/**
 * lib/state.mjs —— 插件状态的读 / 写 / 归一化。
 *
 * 为什么不用 dsh 的 settings 命名空间：密码哈希、每个会话的锁、保险箱密钥盐
 * 这些东西都不该躺在 profile 的 YAML 里（那份文件是给人看、给人手改的），
 * 而且我们要在**没有任何 GUI 写入**的情况下也能原子更新它。
 *
 * 落点：`<dshHome>/chatlock/state.json`，权限 0600。
 *   Windows 上 chmod 基本无效，所以真正的保护靠「哈希 + 内存态 unlock 授权」，
 *   而不是「文件读不到」。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** 版本号；将来结构变了靠它写迁移。 */
export const STATE_VERSION = 1

/** 密码参数默认值（scrypt）。N 取 2^15 ≈ 32ms/次，够挡离线爆破又不卡 UI。 */
export const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 }

/** 策略默认值：10 分钟无操作自动重新上锁，进程启动时默认视为已锁，保险箱 15 分钟空闲自动加密。 */
export const DEFAULT_POLICY = {
  autoLockMinutes: 10,
  vaultAutoLockMinutes: 15,
  lockOnStart: true,
  protectVault: true,
}

/**
 * 定位插件家目录。
 * @param ctx - host 侧 cordis context（可能拿不到 dshHomePath，兜底用 DSH_HOME/HOME）。
 * @returns 已创建的绝对目录。
 */
export function stateDir(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('chatlock')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'chatlock')
    }
  } catch { /* 拿不到就走兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'chatlock')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 空状态。 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    password: null,
    policy: { ...DEFAULT_POLICY },
    /** sessionId -> { title, lockedAt } */
    sessions: {},
    /** vaultId -> { id, label, path, salt, locked, files, bytes, lockedAt } */
    vaults: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 把任意读到的 JSON 收敛成合法状态（缺字段补默认，坏类型丢掉）。 */
export function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const out = { ...base, ...raw }

  if (raw.password && typeof raw.password === 'object') {
    const p = raw.password
    if (typeof p.hash === 'string' && typeof p.salt === 'string') {
      out.password = {
        alg: 'scrypt',
        N: Number(p.N) || SCRYPT.N,
        r: Number(p.r) || SCRYPT.r,
        p: Number(p.p) || SCRYPT.p,
        keylen: Number(p.keylen) || SCRYPT.keylen,
        salt: p.salt,
        hash: p.hash,
        createdAt: Number(p.createdAt) || Date.now(),
      }
    }
  }
  if (!out.password) out.password = null

  const pol = raw.policy && typeof raw.policy === 'object' ? raw.policy : {}
  out.policy = {
    autoLockMinutes: clampInt(pol.autoLockMinutes, 0, 24 * 60, DEFAULT_POLICY.autoLockMinutes),
    vaultAutoLockMinutes: clampInt(pol.vaultAutoLockMinutes, 0, 24 * 60, DEFAULT_POLICY.vaultAutoLockMinutes),
    lockOnStart: typeof pol.lockOnStart === 'boolean' ? pol.lockOnStart : DEFAULT_POLICY.lockOnStart,
    protectVault: typeof pol.protectVault === 'boolean' ? pol.protectVault : DEFAULT_POLICY.protectVault,
  }

  const sessions = {}
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [id, row] of Object.entries(raw.sessions)) {
      if (typeof id !== 'string' || !id) continue
      const r = row && typeof row === 'object' ? row : {}
      sessions[id] = {
        title: typeof r.title === 'string' ? r.title : '',
        lockedAt: Number(r.lockedAt) || Date.now(),
      }
    }
  }
  out.sessions = sessions

  const vaults = {}
  if (raw.vaults && typeof raw.vaults === 'object') {
    for (const [id, row] of Object.entries(raw.vaults)) {
      if (typeof id !== 'string' || !id) continue
      const r = row && typeof row === 'object' ? row : {}
      if (typeof r.path !== 'string' || !r.path) continue
      vaults[id] = {
        id,
        label: typeof r.label === 'string' && r.label ? r.label : r.path,
        path: r.path,
        salt: typeof r.salt === 'string' && r.salt ? r.salt : randomBytes(16).toString('base64'),
        locked: r.locked === true,
        files: Number(r.files) || 0,
        bytes: Number(r.bytes) || 0,
        lockedAt: Number(r.lockedAt) || 0,
      }
    }
  }
  out.vaults = vaults

  out.version = STATE_VERSION
  out.updatedAt = Date.now()
  return out
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 读状态。文件不存在 / 坏掉都不抛 —— 密码锁插件自己挂掉比锁不上更糟。
 * @param dir - stateDir() 的返回值。
 * @returns 归一化后的状态。
 */
export function loadState(dir) {
  const file = join(dir, 'state.json')
  if (!existsSync(file)) return emptyState()
  try {
    return normalizeState(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    // 坏文件留个证据再重建，别静默丢掉用户的锁配置却毫无线索。
    try {
      renameSync(file, join(dir, `state.corrupt-${Date.now()}.json`))
    } catch { /* 改名失败也继续 */ }
    const fresh = emptyState()
    fresh.__loadError = String(error?.message ?? error)
    return fresh
  }
}

/**
 * 原子写状态（tmp + rename），并尽量把权限收紧到 0600。
 * @param dir - stateDir() 的返回值。
 * @param state - 完整状态对象。
 */
export function saveState(dir, state) {
  const file = join(dir, 'state.json')
  const tmp = join(dir, `state.${process.pid}.${Date.now()}.tmp`)
  const body = JSON.stringify({ ...state, version: STATE_VERSION, updatedAt: Date.now() }, null, 2)
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上通常无效 */ }
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* 同上 */ }
  try { return statSync(file).size } catch { return body.length }
}
