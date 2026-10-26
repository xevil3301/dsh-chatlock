/**
 * dsh-chatlock —— host 半侧
 * ============================================================================
 * 它提供两件事：
 *
 *  A. **聊天锁**：`/api/chatlock/*` 路由族 + 口令校验 + 每会话锁登记 + 内存授权表。
 *     GUI 半侧（./client）负责弹窗和遮罩；host 负责「谁算已解锁」这个唯一事实。
 *
 *  B. **保险箱**：把一个目录整体 AES-256-GCM 加密，锁定后磁盘上只剩密文；
 *     同时给 `ctx.fs` 套一层守卫，锁定期间连 DSH 自己的文件工具都读不到里面。
 *
 * 依赖：只要求 `webServer`。`connection`（信任栅栏）和 `fs`（守卫）都是**按需取**——
 * 取不到就降级，绝不让一个缺失的服务把整个插件拖成「不激活」。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadState, normalizeState, saveState, stateDir } from './lib/state.mjs'
import { Grants } from './lib/secret.mjs'
import { makeHandler } from './lib/routes.mjs'
import { canonPath, isInside, lockVault } from './lib/vault.mjs'

/** cordis 插件名（要和 patch 里的 insert id 对齐）。 */
export const name = 'chatlock'

/** 必需服务：只要 HTTP 路由能力。 */
export const inject = ['webServer']

/** 版本号（客户端设置页要显示）。 */
const VERSION = '0.1.0'

// schemastery 拿不到就返回 undefined —— 插件照常加载，只是没有配置页字段。
let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  try {
    z = (await import('schemastery')).default
  } catch { z = null }
}

export const Config = z
  ? z.object({
      /** 总开关：关掉后路由与客户端 UI 都不再起作用。 */
      enabled: z.boolean().default(true).description('聊天锁总开关。'),
    })
  : undefined

/**
 * 挂载插件。
 * @param ctx - host 侧 cordis context。
 * @param config - 来自配置树的对象（可能是对象包装，逐字段按类型取值）。
 */
export function apply(ctx, config) {
  const enabled = !(config && typeof config === 'object' && config.enabled === false)
  if (!enabled) return

  const dir = stateDir(ctx)
  mkdirSync(dir, { recursive: true })
  const logFile = join(dir, 'chatlock.log')

  /** 写一行日志：文件 + 宿主 logger，两个都失败也不致命。 */
  const log = (message) => {
    const line = `${new Date().toISOString()}  ${message}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去也继续 */ }
    try { ctx.logger?.info?.(`[chatlock] ${message}`) } catch { /* 没有 logger 就算了 */ }
  }

  // ---- 状态 ---------------------------------------------------------------
  let state = loadState(dir)
  if (state.__loadError) {
    log(`状态文件损坏已重建：${state.__loadError}`)
    delete state.__loadError
    saveState(dir, state)
  }
  const getState = () => state
  const setState = (next) => {
    state = normalizeState(next)
    saveState(dir, state)
    // 任何状态变化都要让 fs 守卫的「当前锁定集合」立刻跟上。
    refreshBlockedRoots()
  }

  // ---- 授权 ---------------------------------------------------------------
  const grants = new Grants()
  if (state.policy.lockOnStart) grants.clear()

  // ---- 信任栅栏 -----------------------------------------------------------
  /**
   * 每次请求现取 connection：插件按组合顺序启动，一次性读取会把「还没起来」的
   * 状态锁死，之后永远退化成回环检查。
   */
  const fence = (req) => {
    const connection = ctx.get('connection')
    if (!connection?.requestRejection) {
      const address = req.socket?.remoteAddress
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' ? undefined : 403
    }
    try {
      return connection.requestRejection(req)
    } catch {
      return 403
    }
  }

  // ---- 路由 ---------------------------------------------------------------
  /** 浏览器半侧的自检回传（只在内存里，重启即清）。 */
  const clientEvents = {}
  /**
   * 解锁后留在内存里的保险箱密钥（vaultId → Buffer）。进程一退出就没了，
   * 这正是「本次会话用完就锁」的实现方式：上锁用内存里的钥匙，不用再输一遍密码。
   */
  const vaultKeys = new Map()
  const handler = makeHandler({
    dir,
    getState,
    setState,
    grants,
    fence,
    log,
    version: VERSION,
    clientEvents,
    vaultKeys,
  })

  const register = () => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: '/api/chatlock',
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            log(`未捕获的路由异常：${error?.message ?? error}`)
            try {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
            } catch { /* 响应已经发出去了 */ }
          }
        },
      })
    } catch (error) {
      log(`路由挂载失败：${error?.message ?? error}`)
      return () => {}
    }
  }
  ctx.effect(register, 'chatlock: /api/chatlock 路由')

  // ---- 保险箱空闲自动上锁 --------------------------------------------------
  /**
   * 明文留在磁盘上的时间越短越好。解锁时把密钥留在内存，空闲超过
   * policy.vaultAutoLockMinutes 就自己把它锁回去（不需要再输密码）。
   * 注意：锁不住「进程被杀」这种场景 —— 那种情况下没有清理钩子可用，
   * 这也是为什么保险箱适合当归档区，而不是正在被写入的工作区。
   */
  const sweepVaultIdle = async () => {
    const minutes = state.policy.vaultAutoLockMinutes
    if (!minutes || minutes <= 0) return
    if (vaultKeys.size === 0) return
    const idleMinutes = (Date.now() - grants.lastActivity) / 60_000
    if (idleMinutes < minutes) return
    const next = { ...state, vaults: {} }
    for (const [id, key] of [...vaultKeys]) {
      const vault = state.vaults[id]
      if (!vault) { vaultKeys.delete(id); continue }
      try {
        const result = await lockVault(vault.path, key, log)
        next.vaults[id] = { ...vault, locked: true, files: result.files, bytes: result.bytes, lockedAt: Date.now() }
        vaultKeys.delete(id)
        log(`保险箱空闲 ${Math.round(idleMinutes)} 分钟，已自动上锁：${vault.path}`)
      } catch (error) {
        next.vaults[id] = vault
        log(`保险箱自动上锁失败 ${vault.path}：${error?.message ?? error}`)
      }
    }
    for (const [id, vault] of Object.entries(state.vaults)) {
      if (!next.vaults[id]) next.vaults[id] = vault
    }
    setState(next)
  }

  ctx.effect(() => {
    const timer = setInterval(() => { sweepVaultIdle().catch(() => {}) }, 60_000)
    try { timer.unref?.() } catch { /* 无关紧要 */ }
    return () => clearInterval(timer)
  }, 'chatlock: 保险箱空闲上锁')

  // ---- ctx.fs 守卫 --------------------------------------------------------
  /**
   * 锁定期间，凡是落在这几个根里的路径一律拒绝。
   * 注意这是**纵深防御**：文件在磁盘上本来就是密文，这里挡的是「解锁后又锁上、
   * 而某个工具还持有旧路径」这类时序窗口。
   */
  let blockedRoots = []
  function refreshBlockedRoots() {
    blockedRoots = Object.values(state.vaults)
      .filter((vault) => vault.locked && state.policy.protectVault)
      .map((vault) => canonPath(vault.path))
  }
  refreshBlockedRoots()

  function blocked(pathLike) {
    if (blockedRoots.length === 0) return false
    if (typeof pathLike !== 'string' || !pathLike) return false
    let canonical
    try { canonical = canonPath(pathLike) } catch { return false }
    return blockedRoots.some((root) => isInside(root, canonical))
  }

  function deny(pathLike) {
    const error = new Error(`保险箱已锁定，拒绝访问：${pathLike}（在 DSH 设置 → 聊天锁 里解锁后再试）`)
    error.code = 'FS_PERMISSION_DENIED'
    return error
  }

  function installFsGuard() {
    const fsService = ctx.get('fs')
    if (!fsService) return () => {}
    const saved = new Map()

    /** 包一层：先看输入路径，再看解析后的 target.key。 */
    const wrap = (method, pick) => {
      const original = fsService[method]
      if (typeof original !== 'function') return
      saved.set(method, original)
      fsService[method] = function guarded(...args) {
        try {
          const candidate = pick(args)
          // 用 reject 而不是同步 throw：这些方法在调用方眼里都是 async，
          // 同步抛会绕过 `.catch()` 之类的链接写法。
          if (blocked(candidate)) return Promise.reject(deny(candidate))
        } catch (error) {
          if (error?.code === 'FS_PERMISSION_DENIED') return Promise.reject(error)
          // 守卫自身出错时不拦（否则一个边界情况会让所有文件操作瘫痪）。
        }
        return original.apply(this, args)
      }
    }

    wrap('resolve', (args) => args[0])
    wrap('readText', (args) => args[0]?.key ?? args[0]?.path)
    wrap('readBytes', (args) => args[0]?.key ?? args[0]?.path)
    wrap('readByteRange', (args) => args[0]?.key ?? args[0]?.path)
    wrap('stat', (args) => args[0]?.key ?? args[0]?.path)
    wrap('list', (args) => args[0]?.key ?? args[0]?.path)
    wrap('writeText', (args) => args[0]?.key ?? args[0]?.path)
    wrap('editText', (args) => args[0]?.key ?? args[0]?.path)
    wrap('watch', (args) => args[0]?.key ?? args[0]?.path)
    wrap('processPathFromHostPath', (args) => args[0])

    log(`ctx.fs 守卫已挂上（当前锁定根 ${blockedRoots.length} 个）`)
    return () => {
      for (const [method, original] of saved) {
        try { fsService[method] = original } catch { /* 服务可能已经销毁 */ }
      }
      saved.clear()
    }
  }

  // fs 后端可能在插件之后才挂上来：先试一次，没挂上就每 500ms 补一次（最多 20s）。
  ctx.effect(() => {
    let dispose = ctx.get('fs') ? installFsGuard() : null
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (dispose === null && ctx.get('fs')) {
        dispose = installFsGuard()
        clearInterval(timer)
        return
      }
      if (tries > 40) clearInterval(timer)
    }, 500)
    try { timer.unref?.() } catch { /* 无关紧要 */ }
    return () => {
      clearInterval(timer)
      if (typeof dispose === 'function') dispose()
    }
  }, 'chatlock: ctx.fs 守卫')

  log(`已加载 v${VERSION}；状态目录 ${dir}；密码${state.password ? '已设置' : '未设置'}；已锁会话 ${Object.keys(state.sessions).length} 个`)
}
