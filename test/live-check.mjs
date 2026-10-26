/**
 * test/live-check.mjs —— 在**运行中的 dsh** 上做真机验证（只在本机用）。
 *
 * 为什么需要它：dsh 的 `/api` 有自己的浏览器信任栅栏 —— 回环只是第一道，
 * 真正放行的是「浏览器会话签名 cookie」。命令行没有那个 cookie，所以直接
 * curl 会拿到 401。这个脚本按 dsh 自己的算法（见 dsh-client-connection 的
 * browser-auth）用 `~/.dsh/.credentials.yaml` 里的签名密钥现场签一个 cookie，
 * 然后就等价于「已登录的浏览器标签页」。
 *
 * ⚠️ 这是本机自检工具：它读的是你自己的凭据文件、签的是你自己进程接受的身份。
 *
 * 用法：
 *   node test/live-check.mjs                 # 只读：状态 + 客户端包是否被托管
 *   node test/live-check.mjs --mutate        # 再跑一遍 设密码→锁会话→解锁→清除
 *   node test/live-check.mjs --port 2636
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const mutate = argv.includes('--mutate')
const port = (() => {
  const index = argv.indexOf('--port')
  return index >= 0 ? argv[index + 1] : (process.env.DSH_PORT || '2636')
})()

const profile = join(homedir(), '.dsh', 'profiles', 'desktop')
const yaml = (await import(new URL('file://' + join(profile, 'node_modules', 'js-yaml', 'index.js').replace(/\\/g, '/')))).default
const credentials = yaml.load(readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8'))

const record = credentials?.records?.['client-connection/browser-session']
if (!record) throw new Error('凭据里没有 client-connection/browser-session 记录（dsh 还没启用浏览器鉴权？）')
const secretB64 = record.payload?.secret
if (typeof secretB64 !== 'string') throw new Error('browser-session 记录里没有 secret')

const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const secret = Buffer.from(secretB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
if (secret.length !== 32) throw new Error('secret 长度不是 32 字节')

const authority = `127.0.0.1:${port}`
const cookieName = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
const issuedAt = Date.now()
const expiresAt = issuedAt + 30 * 24 * 3600 * 1000
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
const signature = b64url(createHmac('sha256', secret).update(body).digest())
const cookie = `${cookieName}=v1.${body}.${signature}`

const base = `http://${authority}`
const call = async (path, body) => {
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, accept: 'application/json', origin: base },
  }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(base + path, init)
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text.slice(0, 200) }
  return { status: res.status, data }
}

let failures = 0
const check = async (label, fn) => {
  try { const detail = await fn(); console.log('  ✔ ' + label + (detail === undefined ? '' : '  → ' + detail)) } catch (error) {
    failures += 1
    console.error('  ✘ ' + label + '\n    ' + (error?.message || error))
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

console.log(`\n目标：${base}（签名 cookie 已按 dsh 自己的算法生成，长度 ${cookie.length}）`)

console.log('\n[只读]')
await check('GET /api/chatlock/status 被本插件处理（不是 SPA fallback）', async () => {
  const { status, data } = await call('/api/chatlock/status')
  assert(status === 200, `HTTP ${status}: ${JSON.stringify(data)}`)
  assert(data && data.ok === true, '响应不是本插件的 JSON: ' + JSON.stringify(data))
  const client = data.client && data.client.hello
    ? ` · 客户端自检 ok=${data.client.hello.ok} region=${data.client.hello.region} content=${data.client.hello.content}`
    : ' · 客户端自检还没回传（这一版宿主还没重启，或页面没加载）'
  return `configured=${data.configured} locked=${data.lockedSessions.length} vaults=${data.vaults.length} v${data.version}${client}`
})

await check('客户端包已被宿主托管（按 __DSH_BOOT__.entries 里的真实 URL 取）', async () => {
  const page = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } })
  const html = await page.text()
  assert(page.status === 200, `GET / → HTTP ${page.status}`)

  const marker = 'globalThis["__DSH_BOOT__"] = '
  const at = html.indexOf(marker)
  assert(at >= 0, '启动载荷里找不到 __DSH_BOOT__')
  const end = html.indexOf('</script>', at)
  const boot = JSON.parse(html.slice(at + marker.length, end).trim())

  const entry = (boot.entries || []).find((item) => String(item.id).includes('chatlock'))
  assert(entry, `启动载荷的 ${(boot.entries || []).length} 个客户端条目里没有 chatlock`)
  assert(Array.isArray(entry.inject), 'entry.inject 缺失')

  const url = entry.url.startsWith('/') ? entry.url : '/' + entry.url
  const res = await fetch(base + url, { headers: { cookie } })
  const text = await res.text()
  assert(res.status === 200, `${url} → HTTP ${res.status}`)
  assert(text.includes('dsh-chatlock'), '内容不是本插件的 client.js')
  // 回归护栏：2026-10-27 那次「白底白字」修的是配色 token，这里钉住它没被改回去。
  assert(text.includes('label-primary-foreground'), '客户端包还是旧配色（没有 label-primary-foreground）')
  assert(!text.includes('var(--dsw-alias-bg-layer-4'), '客户端包里还在用主题里不存在的 bg-layer-4')
  const cache = res.headers.get('cache-control') || '(none)'
  return `${entry.id} ← ${url.split('&')[0]}（${text.length} bytes，缓存 ${cache}）`
})

if (!mutate) {
  console.log('\n（只读模式。加 --mutate 才会改状态，跑完会自己清干净）')
} else {
  const password = 'verify-' + randomBytes(4).toString('hex')
  const sessionId = 'chatlock-verify-' + Date.now()

  console.log('\n[写入往返]（密码是本次随机的，结束后清除）')
  await check('设置密码', async () => {
    const { status, data } = await call('/api/chatlock/setup', { password })
    assert(status === 200, `HTTP ${status}: ${JSON.stringify(data)}`)
    assert(data.configured === true, '配置状态没变')
    return 'configured=true'
  })

  await check('锁一个会话', async () => {
    const { status, data } = await call('/api/chatlock/lock', { sessionId, title: '验证用会话' })
    assert(status === 200, `HTTP ${status}: ${JSON.stringify(data)}`)
    const row = data.lockedSessions.find((item) => item.sessionId === sessionId)
    assert(row && row.title === '验证用会话', '锁记录没进状态')
    return 'lockedSessions 里有它'
  })

  await check('错密码 401', async () => {
    const { status } = await call('/api/chatlock/verify', { password: 'definitely-wrong', sessionId })
    assert(status === 401, `HTTP ${status}`)
    return 'HTTP 401'
  })

  await check('对密码放行（授权表里有它）', async () => {
    const { status, data } = await call('/api/chatlock/verify', { password, sessionId })
    assert(status === 200, `HTTP ${status}: ${JSON.stringify(data)}`)
    assert(data.grants.sessions.includes(sessionId), '授权快照里没有该会话')
    return 'grants.sessions 命中'
  })

  await check('自动锁定策略可写', async () => {
    const { status, data } = await call('/api/chatlock/policy', { password, autoLockMinutes: 7 })
    assert(status === 200, `HTTP ${status}: ${JSON.stringify(data)}`)
    assert(data.policy.autoLockMinutes === 7, '策略没写进去')
    return 'autoLockMinutes=7'
  })

  await check('relock 撤销授权', async () => {
    const { data } = await call('/api/chatlock/relock', {})
    assert(data.grants.sessions.length === 0, '授权没被撤销')
    return 'grants.sessions=[]'
  })

  await check('清除（恢复现场）', async () => {
    const { status, data } = await call('/api/chatlock/clear', { password })
    assert(status === 200, `HTTP ${status}: ${JSON.stringify(data)}`)
    assert(data.configured === false, '密码没被清掉')
    assert(data.lockedSessions.length === 0, '锁记录没被清掉')
    return 'configured=false, locked=0'
  })
}

console.log(failures === 0 ? '\n真机验证通过 ✅\n' : `\n失败 ${failures} 项 ❌\n`)
process.exitCode = failures === 0 ? 0 : 1
// 别用 process.exit()：Windows 上它会在 socket 还没关干净时触发 libuv 断言噪声。
