/**
 * test/host-fake.mjs —— 不给 dsh 也能把 host 半侧跑起来验证。
 *
 * 关键点：**从「已安装」的那份 index.js 导入**（`<profile>/node_modules/dsh-chatlock`），
 * 这样 `@deepseek-ai/schemastery` 才会按 profile 那棵树解析到；从工作区直接 import 会解析失败。
 *
 * 用法：node test/host-fake.mjs [profile]
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const profileName = process.argv[2] || 'desktop'
const installDir = join(homedir(), '.dsh', 'profiles', profileName, 'node_modules', 'dsh-chatlock')
if (!existsSync(join(installDir, 'index.js'))) {
  console.error(`没找到已安装的插件：${installDir}\n先跑 node install.mjs --profile ${profileName}`)
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'dshcl-home-'))
const calls = []
const routes = []

// ---- 假 ctx -------------------------------------------------------------
const fakeFs = {
  calls: 0,
  resolve: async (path) => ({ key: path, processPath: path }),
  readText: async (target) => { fakeFs.calls += 1; return { text: 'plain:' + target.key } },
  writeText: async (target) => { fakeFs.calls += 1; return { key: target.key } },
  stat: async (target) => ({ key: target.key, size: 1 }),
  list: async (target) => ({ key: target.key, entries: [] }),
}

const ctx = {
  logger: { info: (m) => calls.push(['log', m]) },
  get(name) {
    // 夹具要像真实布局：dsh home 在 <tmp>/.dsh 下面，保险箱目录在 <tmp>/vault-test，
    // 两者不能互相包含 —— 否则会（正确地）撞上新加的「别锁 dsh 自己」那条护栏。
    if (name === 'dshHomePath') return (sub) => { const p = join(home, '.dsh', sub); mkdirSync(p, { recursive: true }); return p }
    if (name === 'fs') return fakeFs
    if (name === 'connection') return undefined
    return undefined
  },
  effect(fn, label) {
    const dispose = fn()
    calls.push(['effect', label, typeof dispose])
    return dispose
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

// ---- 假 req/res ---------------------------------------------------------
function makeReq(method, url, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method,
    url,
    headers: { host: '127.0.0.1:6253', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload
    },
  }
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(payload) { this.body = payload },
    json() { try { return JSON.parse(this.body) } catch { return null } },
  }
}

const mod = await import(pathToFileURL(join(installDir, 'index.js')).href)
console.log('模块导出：', Object.keys(mod).join(', '))
assert.equal(mod.name, 'chatlock')
assert.deepEqual(mod.inject, ['webServer'])

mod.apply(ctx, { enabled: true })

assert.equal(routes.length, 1, '路由没挂上')
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/api/chatlock')

const call = async (method, path, body) => {
  const req = makeReq(method, '/api/chatlock' + path, body)
  const res = makeRes()
  await routes[0].handler(req, res)
  return { status: res.status, data: res.json() }
}

let failures = 0
const check = async (label, fn) => {
  try { await fn(); console.log('  ✔ ' + label) } catch (error) {
    failures += 1
    console.error('  ✘ ' + label + '\n    ' + (error?.stack || error))
  }
}

console.log('\n[路由]')
await check('初始状态：未配置', async () => {
  const { status, data } = await call('GET', '/status')
  assert.equal(status, 200)
  assert.equal(data.configured, false)
  assert.deepEqual(data.lockedSessions, [])
})

await check('未配置时 /lock 仍可写（锁永远是安全的）', async () => {
  const { data } = await call('POST', '/lock', { sessionId: 's1', title: '私密会话' })
  assert.equal(data.ok, true)
  assert.equal(data.lockedSessions.length, 1)
  assert.equal(data.lockedSessions[0].title, '私密会话')
})

await check('设置密码后配置生效', async () => {
  const { status, data } = await call('POST', '/setup', { password: 'hunter2hunter2' })
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(data.ok, true)
  assert.equal(data.configured, true)
})

await check('重复 setup 被拒', async () => {
  const { status } = await call('POST', '/setup', { password: 'again123456' })
  assert.equal(status, 409)
})

await check('错密码 verify = 401', async () => {
  const { status } = await call('POST', '/verify', { password: 'nope', sessionId: 's1' })
  assert.equal(status, 401)
})

await check('对密码 verify 放行该会话', async () => {
  const { status, data } = await call('POST', '/verify', { password: 'hunter2hunter2', sessionId: 's1' })
  assert.equal(status, 200, JSON.stringify(data))
  assert.ok(data.grants.sessions.includes('s1'))
})

await check('relock 撤销', async () => {
  const { data } = await call('POST', '/relock', {})
  assert.deepEqual(data.grants.sessions, [])
})

await check('客户端自检回传 client-hello', async () => {
  const { status, data } = await call('POST', '/client-hello', {
    ok: true, region: true, content: true, overlay: true, slots: 4, 附加字段: '不该被存',
  })
  assert.equal(status, 200)
  assert.equal(data.ok, true)
  const { data: state } = await call('GET', '/status')
  assert.equal(state.client.hello.ok, true)
  assert.equal(state.client.hello.region, true)
  assert.equal(state.client.hello.slots, 4)
  assert.equal(state.client.hello['附加字段'], undefined, '白名单没生效')
})

await check('遮罩上报 gate-shown', async () => {
  await call('POST', '/gate-shown', { sessionId: 's1', mask: { w: 900, h: 640 }, contentFound: true, contentFilter: 'blur(16px)' })
  const { data } = await call('GET', '/status')
  assert.equal(data.client.gate.sessionId, 's1')
  assert.deepEqual(data.client.gate.mask, { w: 900, h: 640 })
  assert.equal(data.client.gate.contentFilter, 'blur(16px)')
})

await check('未知路径 = 404', async () => {
  const { status } = await call('POST', '/nope', {})
  assert.equal(status, 404)
})

console.log('\n[保险箱]')
const vaultRoot = join(home, 'vault-test')
mkdirSync(join(vaultRoot, 'sub'), { recursive: true })
writeFileSync(join(vaultRoot, 'a.txt'), 'a-content', 'utf8')
writeFileSync(join(vaultRoot, 'sub', 'b.txt'), 'b-content', 'utf8')

let vaultId = ''
await check('登记保险箱', async () => {
  const { status, data } = await call('POST', '/vault/add', { password: 'hunter2hunter2', path: vaultRoot, label: '测试箱' })
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(data.vaults.length, 1)
  vaultId = data.vaults[0].id
})

await check('拒绝把 dsh 自己的目录登记成保险箱', async () => {
  // fake ctx 的 dshHomePath 是 <tmp>/<sub>，所以 <tmp>/chatlock 就是 dsh home 本身
  const dshHome = join(home)
  const { status, data } = await call('POST', '/vault/add', { password: 'hunter2hunter2', path: dshHome })
  assert.equal(status, 400, JSON.stringify(data))
  assert.match(String(data.error), /dsh 自己的目录/, JSON.stringify(data))
})

await check('拒绝盘符根', async () => {
  const root = process.platform === 'win32' ? 'C:\\' : '/'
  const { status, data } = await call('POST', '/vault/add', { password: 'hunter2hunter2', path: root })
  assert.equal(status, 400, JSON.stringify(data))
})

await check('加密后明文消失、密文就位', async () => {
  const { status, data } = await call('POST', '/vault/lock', { password: 'hunter2hunter2', id: vaultId })
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(existsSync(join(vaultRoot, 'a.txt')), false)
  assert.equal(existsSync(join(vaultRoot, 'sub', 'b.txt')), false)
  assert.equal(readdirSync(join(vaultRoot, '.dsh-chatlock', 'enc')).length, 2)
})

await check('锁定后 ctx.fs 守卫拒绝访问', async () => {
  await assert.rejects(
    () => fakeFs.readText({ key: join(vaultRoot, 'a.txt') }),
    (error) => error.code === 'FS_PERMISSION_DENIED',
  )
  // 保险箱外的路径不受影响
  const outside = await fakeFs.readText({ key: join(home, 'other.txt') })
  assert.equal(outside.text.startsWith('plain:'), true)
})

await check('解锁后内容还原、守卫解除', async () => {
  const { status, data } = await call('POST', '/vault/unlock', { password: 'hunter2hunter2', id: vaultId })
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(readFileSync(join(vaultRoot, 'a.txt'), 'utf8'), 'a-content')
  assert.equal(readFileSync(join(vaultRoot, 'sub', 'b.txt'), 'utf8'), 'b-content')
  assert.equal(existsSync(join(vaultRoot, '.dsh-chatlock')), false)
  const after = await fakeFs.readText({ key: join(vaultRoot, 'a.txt') })
  assert.equal(after.text.startsWith('plain:'), true)
})

await check('解锁后密钥留在内存，可以无密码上锁', async () => {
  const before = await call('GET', '/status')
  const row = before.data.vaults.find((vault) => vault.id === vaultId)
  assert.equal(row.keyLive, true, '解锁后应当缓存密钥')
  const { status, data } = await call('POST', '/vault/lock', { id: vaultId })
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(existsSync(join(vaultRoot, 'a.txt')), false, '无密码上锁没生效')
})

await check('密钥用掉之后，再上锁必须重新输密码', async () => {
  const { status, data } = await call('POST', '/vault/lock', { id: vaultId })
  assert.equal(status, 401, JSON.stringify(data))
})

await check('一键上锁（lock-all）', async () => {
  await call('POST', '/vault/unlock', { password: 'hunter2hunter2', id: vaultId })
  assert.equal(existsSync(join(vaultRoot, 'a.txt')), true, '前置解锁失败')
  const { status, data } = await call('POST', '/vault/lock-all', {})
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(data.done.length, 1, JSON.stringify(data))
  assert.equal(existsSync(join(vaultRoot, 'a.txt')), false, '一键上锁没生效')
})

await check('清除密码（保险箱已解锁）', async () => {
  await call('POST', '/vault/unlock', { password: 'hunter2hunter2', id: vaultId })
  const { status, data } = await call('POST', '/clear', { password: 'hunter2hunter2' })
  assert.equal(status, 200, JSON.stringify(data))
  assert.equal(data.configured, false)
  assert.deepEqual(data.vaults, [])
})

console.log('\n[副作用]')
await check('effect 都拿到了 disposer', async () => {
  const effects = calls.filter((row) => row[0] === 'effect')
  assert.ok(effects.length >= 2, 'effect 数量偏少：' + effects.length)
  for (const [, label, type] of effects) assert.equal(type, 'function', `effect ${label} 没有返回 disposer`)
})

console.log(failures === 0 ? '\n全部通过 ✅（临时目录 ' + home + '）\n' : `\n失败 ${failures} 项 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
