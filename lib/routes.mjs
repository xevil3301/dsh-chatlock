/**
 * lib/routes.mjs —— `/api/chatlock/*` 整个路由族。
 *
 * 设计规则（别改，改之前先看这条）：
 *  - **每一条**请求都先过 dsh 自己的 `/api` 信任栅栏（回环 / 监听地址 / --trusted-host
 *    / 浏览器会话），栅栏拿不到就退到「只回环」。本族能改密码、能解保险箱，
 *    绝不能比它周围的 GUI 更松。
 *  - 所有**加锁**动作不需要密码（锁上永远是安全的）；所有**解锁 / 改口令 / 删保险箱**
 *    动作都必须带密码，且密码只从请求体读、不落日志。
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { MIN_PASSWORD_LENGTH, deriveVaultKey, makePasswordRecord, verifyPassword } from './secret.mjs'
import { lockVault, unlockVault, isLockedOnDisk, countPlainFiles, canonPath, isInside } from './vault.mjs'

/** 请求体上限（我们这个族里最大的是路径字符串，64KB 足够）。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 读 JSON 请求体。
 * @param req - IncomingMessage。
 * @returns 解析后的对象；解析不了返回 {}。
 */
export async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return {}
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写一个 JSON 响应。 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** 同源兜底（栅栏不可用时的额外一道）。 */
function sameOriginOk(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || !host) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 构建路由处理器。
 *
 * @param deps - 由 host 半侧注入的依赖：
 *   `dir` 状态目录、`getState`/`setState` 状态读写、`grants` 授权表、
 *   `fence` 信任栅栏、`log` 日志、`onStateChanged` 变更回调、`version` 版本号。
 * @returns {(req, res) => Promise<void>} 一个 prefix 路由处理器。
 */
export function makeHandler(deps) {
  const { dir, getState, setState, grants, fence, log, version, clientEvents, vaultKeys } = deps

  /** 客户端自检回传只收白名单字段，别把浏览器想传什么就存什么。 */
  const pickClientFields = (body) => {
    const out = { at: Date.now() }
    for (const key of ['ok', 'error', 'region', 'content', 'overlay', 'slots', 'sessionId', 'contentFound', 'contentFilter']) {
      if (body[key] !== undefined) out[key] = typeof body[key] === 'string' ? body[key].slice(0, 300) : body[key]
    }
    if (body.mask && typeof body.mask === 'object') {
      out.mask = { w: Number(body.mask.w) || 0, h: Number(body.mask.h) || 0 }
    }
    return out
  }

  const statusBody = () => {
    const state = getState()
    grants.expireIdle(state.policy.autoLockMinutes)
    const vaults = Object.values(state.vaults).map((vault) => ({
      id: vault.id,
      label: vault.label,
      path: vault.path,
      locked: vault.locked,
      files: vault.files,
      bytes: vault.bytes,
      lockedAt: vault.lockedAt,
      /** 本次进程里解锁过、密钥还在内存 → 不用再输密码就能上锁。 */
      keyLive: Boolean(vaultKeys && vaultKeys.has(vault.id)),
    }))
    return {
      ok: true,
      version,
      configured: Boolean(state.password),
      policy: state.policy,
      lockedSessions: Object.entries(state.sessions).map(([id, row]) => ({
        sessionId: id,
        title: row.title || '',
        lockedAt: row.lockedAt,
      })),
      grants: grants.snapshot(),
      vaults,
      client: clientEvents || {},
      minPasswordLength: MIN_PASSWORD_LENGTH,
    }
  }

  /** 密码错了就 401，别给「差一点点」的信息。 */
  const requirePassword = (state, body) => {
    if (!state.password) return { error: '还没有设置密码', status: 409 }
    if (!verifyPassword(state.password, String(body.password ?? body.currentPassword ?? ''))) {
      return { error: '密码不对', status: 401 }
    }
    return null
  }

  const handlers = {
    /** 只读状态：客户端每次打开会话 / 周期轮询都打这条。 */
    'GET status': async () => ({ body: statusBody() }),

    /**
     * 浏览器半侧启动自检：页面里执行到 apply 之后报一声。
     * 它存在的唯一理由是「没有 devtools 时也能证明 UI 半边真的跑起来了」。
     */
    'POST client-hello': async (body) => {
      const record = pickClientFields(body)
      if (clientEvents) clientEvents.hello = record
      log(`客户端已加载：ok=${record.ok}${record.error ? ` 错误=${record.error}` : ''} region=${record.region} content=${record.content}`)
      return { body: { ok: true } }
    },

    /** 锁屏遮罩渲染上报（每次会话从「解锁」变「锁定」报一次）。 */
    'POST gate-shown': async (body) => {
      const record = pickClientFields(body)
      if (clientEvents) clientEvents.gate = record
      log(`锁屏遮罩已渲染：session=${record.sessionId} mask=${record.mask ? `${record.mask.w}x${record.mask.h}` : 'n/a'} content=${record.contentFound} filter=${record.contentFilter}`)
      return { body: { ok: true } }
    },

    /** 首次设置密码。已设置过就必须走 /password。 */
    'POST setup': async (body) => {
      const state = getState()
      if (state.password) return { status: 409, body: { ok: false, error: '已经设置过密码，请用「修改密码」' } }
      const password = String(body.password ?? '')
      if (password.length < MIN_PASSWORD_LENGTH) {
        return { status: 400, body: { ok: false, error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` } }
      }
      state.password = makePasswordRecord(password)
      setState(state)
      grants.grant('global', state.policy.autoLockMinutes)
      log('密码已设置')
      return { body: { ok: true, ...statusBody() } }
    },

    /** 改密码：旧密码验过才换，并且撤销全部临时授权（换了钥匙就得重新开门）。 */
    'POST password': async (body) => {
      const state = getState()
      const bad = requirePassword(state, body)
      if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      const next = String(body.newPassword ?? '')
      if (next.length < MIN_PASSWORD_LENGTH) {
        return { status: 400, body: { ok: false, error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` } }
      }
      state.password = makePasswordRecord(next)
      setState(state)
      grants.clear()
      log('密码已修改，临时授权已全部撤销')
      return { body: { ok: true } }
    },

    /** 验密 → 放行。scope 省略时按 sessionId 放行单个会话。 */
    'POST verify': async (body) => {
      const state = getState()
      if (!state.password) return { status: 409, body: { ok: false, error: '还没有设置密码' } }
      if (!verifyPassword(state.password, String(body.password ?? ''))) {
        return { status: 401, body: { ok: false, error: '密码不对' } }
      }
      const scope = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'global'
      grants.grant(scope, state.policy.autoLockMinutes)
      log(`已解锁 ${scope === 'global' ? '全部会话' : `会话 ${scope}`}`)
      return { body: { ok: true, ...statusBody() } }
    },

    /** 心跳：客户端有操作就报一声，服务端据此判断空闲超时。 */
    'POST touch': async () => {
      grants.touch()
      return { body: { ok: true } }
    },

    /** 上锁（不需要密码）。 */
    'POST lock': async (body) => {
      const state = getState()
      const sessionId = String(body.sessionId ?? '')
      if (!sessionId) return { status: 400, body: { ok: false, error: '缺少 sessionId' } }
      state.sessions[sessionId] = {
        title: typeof body.title === 'string' ? body.title : (state.sessions[sessionId]?.title ?? ''),
        lockedAt: Date.now(),
      }
      setState(state)
      grants.revoke(sessionId)
      log(`已锁定会话 ${sessionId}`)
      return { body: { ok: true, ...statusBody() } }
    },

    /** 解除某会话的锁（要密码）。 */
    'POST unlock-session': async (body) => {
      const state = getState()
      const bad = requirePassword(state, body)
      if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      const sessionId = String(body.sessionId ?? '')
      if (!sessionId) return { status: 400, body: { ok: false, error: '缺少 sessionId' } }
      delete state.sessions[sessionId]
      setState(state)
      grants.revoke(sessionId)
      log(`已解除会话 ${sessionId} 的锁`)
      return { body: { ok: true, ...statusBody() } }
    },

    /** 一次锁上全部（不需要密码）。 */
    'POST lock-all': async (body) => {
      const state = getState()
      const rows = Array.isArray(body.sessions) ? body.sessions : []
      const now = Date.now()
      for (const row of rows) {
        const sessionId = String(row?.sessionId ?? '')
        if (!sessionId) continue
        if (state.sessions[sessionId]) continue
        state.sessions[sessionId] = { title: typeof row?.title === 'string' ? row.title : '', lockedAt: now }
      }
      setState(state)
      grants.clear()
      log(`已锁定全部（新增 ${rows.length} 条候选）`)
      return { body: { ok: true, ...statusBody() } }
    },

    /** 撤销临时授权（不需要密码 —— 收紧权限永远安全）。 */
    'POST relock': async (body) => {
      const scope = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'all'
      grants.revoke(scope)
      log(`已撤销授权：${scope}`)
      return { body: { ok: true, ...statusBody() } }
    },

    /** 策略（要密码）。 */
    'POST policy': async (body) => {
      const state = getState()
      const bad = requirePassword(state, body)
      if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      const minutes = Number(body.autoLockMinutes)
      if (Number.isFinite(minutes)) {
        state.policy.autoLockMinutes = Math.max(0, Math.min(24 * 60, Math.floor(minutes)))
      }
      const vaultMinutes = Number(body.vaultAutoLockMinutes)
      if (Number.isFinite(vaultMinutes)) {
        state.policy.vaultAutoLockMinutes = Math.max(0, Math.min(24 * 60, Math.floor(vaultMinutes)))
      }
      if (typeof body.lockOnStart === 'boolean') state.policy.lockOnStart = body.lockOnStart
      if (typeof body.protectVault === 'boolean') state.policy.protectVault = body.protectVault
      setState(state)
      return { body: { ok: true, ...statusBody() } }
    },

    /** 清空：删密码 + 删所有锁（要密码）。保险箱必须先是解锁状态。 */
    'POST clear': async (body) => {
      const state = getState()
      const bad = requirePassword(state, body)
      if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      const stillLocked = Object.values(state.vaults).filter((vault) => vault.locked)
      if (stillLocked.length > 0) {
        return { status: 409, body: { ok: false, error: `还有 ${stillLocked.length} 个保险箱处于锁定状态，请先解锁它们` } }
      }
      state.password = null
      state.sessions = {}
      state.vaults = {}
      setState(state)
      grants.clear()
      log('已清除密码与全部锁')
      return { body: { ok: true, ...statusBody() } }
    },

    /** 新增保险箱（要密码：保险箱的密钥来自这个口令，改口令等于换钥匙）。 */
    'POST vault/add': async (body) => {
      const state = getState()
      const bad = requirePassword(state, body)
      if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      const raw = String(body.path ?? '').trim()
      if (!raw) return { status: 400, body: { ok: false, error: '缺少目录路径' } }
      const path = resolve(raw)
      if (!existsSync(path)) return { status: 400, body: { ok: false, error: '目录不存在: ' + path } }

      /**
       * 安全闸：不许把 dsh 自己（或它的祖先）锁进去。
       * 一旦 `~/.dsh` 被加密，插件代码、凭据、会话全都读不出来 ——
       * 连「解锁」这个动作都没有 UI 能点了，只能靠手写脚本救。这条必须拦在登记之前。
       */
      const dshHome = dirname(resolve(dir))
      const overlaps = (a, b) => isInside(a, b) || isInside(b, a)
      if (path.length <= 3) {
        return { status: 400, body: { ok: false, error: `不要把整个盘符登记成保险箱：${path}` } }
      }
      if (overlaps(path, dshHome)) {
        return {
          status: 400,
          body: {
            ok: false,
            error: `这个路径与 dsh 自己的目录重叠，锁上之后插件自己也会变成密文、没人能解锁：${path} ↔ ${dshHome}`,
          },
        }
      }
      // 已登记过的直接返回，避免同一目录两条记录指向不同盐。
      for (const vault of Object.values(state.vaults)) {
        if (canonPath(vault.path) === canonPath(path)) {
          return { body: { ok: true, duplicate: true, ...statusBody() } }
        }
      }
      // 不允许嵌套登记：内外两个盐各管一半，加密状态会打架。
      for (const vault of Object.values(state.vaults)) {
        if (isInside(vault.path, path) || isInside(path, vault.path)) {
          return { status: 409, body: { ok: false, error: `与已有保险箱路径重叠：${vault.path}` } }
        }
      }
      const id = randomBytes(8).toString('hex')
      state.vaults[id] = {
        id,
        label: typeof body.label === 'string' && body.label ? body.label : path,
        path,
        salt: randomBytes(16).toString('base64'),
        locked: false,
        files: 0,
        bytes: 0,
        lockedAt: 0,
      }
      setState(state)
      log(`新增保险箱 ${path}`)
      return { body: { ok: true, id, ...statusBody() } }
    },

    /**
     * 锁定保险箱：把目录里所有文件换成密文。
     *
     * 钥匙来源两条路：
     *   ① 请求里带 password（任何一次都能走）；
     *   ② 这次进程里刚解锁过，密钥还在内存（`vaultKeys`）—— 空闲自动上锁、一键全锁走这条，
     *      否则「用完就锁」会变成「每次锁都要再输一遍密码」，没人会用。
     */
    'POST vault/lock': async (body) => {
      const state = getState()
      const id = String(body.id ?? '')
      const vault = state.vaults[id]
      if (!vault) return { status: 404, body: { ok: false, error: '没有这个保险箱' } }
      const hasPassword = String(body.password ?? '').length > 0 || String(body.currentPassword ?? '').length > 0
      if (hasPassword) {
        const bad = requirePassword(state, body)
        if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      } else if (!(vaultKeys && vaultKeys.has(id))) {
        return { status: 401, body: { ok: false, error: '需要密码（或者先在本进程里解锁过这个保险箱）' } }
      }
      if (!existsSync(vault.path)) return { status: 400, body: { ok: false, error: '目录不存在: ' + vault.path } }
      if (vault.locked && (await isLockedOnDisk(vault.path))) {
        if (vaultKeys) vaultKeys.delete(id)
        return { body: { ok: true, already: true, ...statusBody() } }
      }
      const key = hasPassword
        ? deriveVaultKey(String(body.password ?? body.currentPassword ?? ''), vault.salt)
        : vaultKeys.get(id)
      const result = await lockVault(vault.path, key, log)
      vault.locked = true
      vault.files = result.files
      vault.bytes = result.bytes
      vault.lockedAt = Date.now()
      // 上锁之后密钥立刻从内存里抹掉：下次要用就重新输密码。
      if (vaultKeys) vaultKeys.delete(id)
      setState(state)
      return { body: { ok: true, result, ...statusBody() } }
    },

    /** 一键把「本进程里还开着」的保险箱全部加密（不需要密码，用的是内存里的密钥）。 */
    'POST vault/lock-all': async () => {
      const state = getState()
      const done = []
      const failed = []
      for (const [id, key] of [...(vaultKeys || new Map())]) {
        const vault = state.vaults[id]
        if (!vault) { vaultKeys.delete(id); continue }
        if (vault.locked && (await isLockedOnDisk(vault.path))) { vaultKeys.delete(id); continue }
        try {
          const result = await lockVault(vault.path, key, log)
          vault.locked = true
          vault.files = result.files
          vault.bytes = result.bytes
          vault.lockedAt = Date.now()
          vaultKeys.delete(id)
          done.push({ id, path: vault.path, files: result.files })
        } catch (error) {
          failed.push({ id, path: vault.path, error: String(error?.message ?? error) })
        }
      }
      if (done.length > 0 || failed.length > 0) setState(state)
      log(`一键上锁：成功 ${done.length} 个，失败 ${failed.length} 个`)
      return { body: { ok: true, done, failed, ...statusBody() } }
    },

    /** 解锁保险箱：把密文还原成明文。成功后把密钥留在内存，供「自动上锁/一键全锁」使用。 */
    'POST vault/unlock': async (body) => {
      const state = getState()
      const bad = requirePassword(state, body)
      if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      const id = String(body.id ?? '')
      const vault = state.vaults[id]
      if (!vault) return { status: 404, body: { ok: false, error: '没有这个保险箱' } }
      const key = deriveVaultKey(String(body.password ?? ''), vault.salt)
      const result = await unlockVault(vault.path, key, log)
      if (result.skipped.length === 0) {
        vault.locked = false
        vault.lockedAt = 0
        if (vaultKeys) vaultKeys.set(id, key)
        try {
          const plain = await countPlainFiles(vault.path)
          vault.files = plain.files
          vault.bytes = plain.bytes
        } catch { /* 统计失败不影响解锁 */ }
        setState(state)
      }
      return { body: { ok: true, result, ...statusBody() } }
    },

    /** 移出登记（要密码；锁着的时候先解开，否则明文就永远回不来了）。 */
    'POST vault/remove': async (body) => {
      const state = getState()
      const bad = requirePassword(state, body)
      if (bad) return { status: bad.status, body: { ok: false, error: bad.error } }
      const id = String(body.id ?? '')
      const vault = state.vaults[id]
      if (!vault) return { status: 404, body: { ok: false, error: '没有这个保险箱' } }
      if (vault.locked) {
        return { status: 409, body: { ok: false, error: '保险箱还锁着，请先解锁再移出（否则明文无法恢复）' } }
      }
      delete state.vaults[id]
      if (vaultKeys) vaultKeys.delete(id)
      setState(state)
      log(`移出保险箱 ${vault.path}`)
      return { body: { ok: true, ...statusBody() } }
    },
  }

  return async function handle(req, res) {
    // ① 宿主信任栅栏
    try {
      if (fence && fence(req) !== undefined) {
        sendJson(res, fence(req), { ok: false, error: '不被信任的请求来源' })
        return
      }
    } catch {
      sendJson(res, 403, { ok: false, error: '信任检查异常，已拒绝' })
      return
    }
    // ② 同源兜底
    if (!sameOriginOk(req)) {
      sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const action = url.pathname.replace(/^\/api\/chatlock\/?/, '').replace(/\/+$/, '')
    const method = (req.method || 'GET').toUpperCase()
    const key = `${method} ${action || 'status'}`

    // GET 只读三件：status；其余一律 POST，避免被 <img>/链接顺手触发。
    const handler = method === 'GET'
      ? (action === '' || action === 'status' ? handlers['GET status'] : undefined)
      : handlers[key] || handlers[`POST ${action}`]

    if (!handler) {
      sendJson(res, 404, { ok: false, error: `未知的 chatlock 路由: ${method} ${url.pathname}` })
      return
    }

    try {
      const body = method === 'GET' ? {} : await readJson(req)
      const result = await handler(body)
      sendJson(res, result?.status ?? 200, result?.body ?? { ok: true })
    } catch (error) {
      log(`路由失败 ${key}: ${error?.message ?? error}`)
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
}

/** 这个请求路径是否属于本族（prefix 路由已经保证了，留作显式可读）。 */
