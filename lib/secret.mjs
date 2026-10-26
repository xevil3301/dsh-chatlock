/**
 * lib/secret.mjs —— 口令哈希与「已解锁」授权表。
 *
 * 两条规矩：
 *  1. 密码**永不落盘**，只存 scrypt 派生值 + 每条独立的盐；比较用 timingSafeEqual。
 *  2. 「已解锁」只活在内存里 —— 进程一重启就全灭，这也是最可靠的自动重锁。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { SCRYPT } from './state.mjs'

/** 允许的最短口令长度。太短的锁等于没锁，这里直接挡住。 */
export const MIN_PASSWORD_LENGTH = 6

/**
 * 生成一条新的口令记录。
 * @param password - 明文口令。
 * @returns 可写进 state.password 的对象。
 */
export function makePasswordRecord(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024,
  })
  return {
    alg: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: Date.now(),
  }
}

/**
 * 校验口令。任何参数问题都返回 false（失败即拒绝，绝不「因为没配置就放行」）。
 * @param record - state.password。
 * @param password - 待校验明文。
 * @returns 是否匹配。
 */
export function verifyPassword(record, password) {
  if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false
  if (typeof password !== 'string' || password.length === 0) return false
  try {
    const salt = Buffer.from(record.salt, 'base64')
    const expected = Buffer.from(record.hash, 'base64')
    const actual = scryptSync(password, salt, record.keylen || SCRYPT.keylen, {
      N: record.N || SCRYPT.N,
      r: record.r || SCRYPT.r,
      p: record.p || SCRYPT.p,
      maxmem: 256 * 1024 * 1024,
    })
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * 从口令派生一把对称密钥（保险箱用）。盐来自该保险箱自己的 salt。
 * @param password - 明文口令。
 * @param saltB64 - base64 盐。
 * @returns 32 字节 AES-256 密钥。
 */
export function deriveVaultKey(password, saltB64) {
  return scryptSync(String(password), Buffer.from(saltB64, 'base64'), 32, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024,
  })
}

/**
 * 解锁授权表：谁在什么时刻被临时放行。
 *
 * 语义刻意做成「按会话 + 全局」两级：
 *  - 单个会话解锁：只放行那个会话，其它锁着的照旧弹窗；
 *  - 全局解锁（`global`）：一次性放行全部，适合「我人在电脑前」的整段工作。
 * 有效期由 policy.autoLockMinutes 控制（0 = 不过期，直到进程退出）。
 */
export class Grants {
  constructor() {
    /** @type {Map<string, number>} sessionId -> 过期时刻（ms，0 表示永不过期） */
    this.sessions = new Map()
    /** @type {number} 全局过期时刻（0 表示没有全局授权） */
    this.globalUntil = 0
    /** 最近一次用户活动时间，用于 auto-lock 判定。 */
    this.lastActivity = Date.now()
  }

  /** 记一次活动（客户端节流后调用）。 */
  touch() {
    this.lastActivity = Date.now()
  }

  /**
   * 授权。
   * @param scope - 'global' 或具体 sessionId。
   * @param minutes - 有效分钟数；0 表示到进程结束。
   */
  grant(scope, minutes) {
    const until = minutes > 0 ? Date.now() + minutes * 60_000 : 0
    this.touch()
    if (scope === 'global') {
      this.globalUntil = until || Number.MAX_SAFE_INTEGER
      return
    }
    this.sessions.set(String(scope), until || Number.MAX_SAFE_INTEGER)
  }

  /**
   * 撤销。
   * @param scope - 'global' | 'all' | sessionId。
   */
  revoke(scope) {
    if (scope === 'all') {
      this.sessions.clear()
      this.globalUntil = 0
      return
    }
    if (scope === 'global') {
      this.globalUntil = 0
      return
    }
    this.sessions.delete(String(scope))
  }

  /** 撤掉全部（锁屏按钮 / 空闲超时）。 */
  clear() {
    this.sessions.clear()
    this.globalUntil = 0
  }

  /**
   * 该会话当前是否被放行。
   * @param sessionId - 会话 id。
   * @returns 是否已授权。
   */
  allows(sessionId) {
    if (this.globalUntil && this.globalUntil > Date.now()) return true
    const until = this.sessions.get(String(sessionId))
    if (until === undefined) return false
    if (until === 0 || until === Number.MAX_SAFE_INTEGER) return true
    if (until > Date.now()) return true
    this.sessions.delete(String(sessionId))
    return false
  }

  /**
   * 空闲超时检查：超过 autoLockMinutes 没有活动就把授权全撤。
   * @param minutes - 策略里的分钟数；0 表示不自动锁。
   * @returns 是否刚刚发生了自动锁。
   */
  expireIdle(minutes) {
    if (!minutes || minutes <= 0) return false
    if (Date.now() - this.lastActivity < minutes * 60_000) return false
    if (this.globalUntil === 0 && this.sessions.size === 0) return false
    this.clear()
    return true
  }

  /** 给客户端看的快照（不含时间细节）。 */
  snapshot() {
    const now = Date.now()
    const alive = (until) => until === 0 || until === Number.MAX_SAFE_INTEGER || until > now
    const sessions = [...this.sessions.entries()].filter(([, until]) => alive(until)).map(([id]) => id)
    return { global: alive(this.globalUntil) && this.globalUntil > 0, sessions, idleMs: now - this.lastActivity }
  }
}
