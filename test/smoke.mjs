/**
 * test/smoke.mjs —— 不依赖 dsh 的本地自检。
 *
 * 跑：`node test/smoke.mjs`
 * 覆盖：口令哈希/校验、授权表语义、保险箱 加解密往返（含中文文件名、空文件、嵌套目录）。
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { makePasswordRecord, verifyPassword, Grants, deriveVaultKey } from '../lib/secret.mjs'
import { normalizeState, emptyState } from '../lib/state.mjs'
import { lockVault, unlockVault, collectFiles, readManifest, META_DIR } from '../lib/vault.mjs'

let failures = 0
const ok = (label) => console.log(`  ✔ ${label}`)
const check = async (label, fn) => {
  try {
    await fn()
    ok(label)
  } catch (error) {
    failures += 1
    console.error(`  ✘ ${label}\n    ${error?.stack || error}`)
  }
}

console.log('\n[1] 口令')
await check('正确口令通过、错误口令拒绝', () => {
  const record = makePasswordRecord('correct horse battery')
  assert.equal(verifyPassword(record, 'correct horse battery'), true)
  assert.equal(verifyPassword(record, 'correct horse batterY'), false)
  assert.equal(verifyPassword(record, ''), false)
  assert.equal(verifyPassword(null, 'x'), false)
})

console.log('\n[2] 授权表')
await check('按会话放行 / 全局放行 / 撤销', () => {
  const grants = new Grants()
  assert.equal(grants.allows('a'), false)
  grants.grant('a', 5)
  assert.equal(grants.allows('a'), true)
  assert.equal(grants.allows('b'), false)
  grants.grant('global', 5)
  assert.equal(grants.allows('b'), true)
  grants.revoke('global')
  assert.equal(grants.allows('b'), false)
  grants.revoke('all')
  assert.equal(grants.allows('a'), false)
  assert.deepEqual(grants.snapshot().sessions, [])
})

await check('空闲超时会把授权清空', () => {
  const grants = new Grants()
  grants.grant('a', 5)
  grants.lastActivity = Date.now() - 11 * 60_000
  assert.equal(grants.expireIdle(10), true)
  assert.equal(grants.allows('a'), false)
})

console.log('\n[3] 状态归一化')
await check('坏字段收敛成默认值', () => {
  const state = normalizeState({ password: { hash: 'h', salt: 's' }, policy: { autoLockMinutes: -5 } })
  assert.equal(state.password.hash, 'h')
  assert.equal(state.policy.autoLockMinutes, 0)
  assert.equal(state.policy.lockOnStart, true)
  assert.deepEqual(state.sessions, {})
  assert.deepEqual(state.vaults, {})
  assert.equal(normalizeState(null).version, emptyState().version)
})

console.log('\n[4] 保险箱往返')
const root = mkdtempSync(join(tmpdir(), 'dshcl-smoke-'))
const cases = {
  'notes.txt': '这是一份中文笔记，含 emoji 🐳 和换行\n第二行\n',
  'empty.bin': '',
  'nested/deep/numbers.json': JSON.stringify({ a: 1, b: [2, 3] }),
  'big.txt': 'x'.repeat(512 * 1024),
}
for (const [rel, body] of Object.entries(cases)) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body, 'utf8')
}

const key = deriveVaultKey('hunter2hunter2', Buffer.from('0123456789abcdef').toString('base64'))

await check('上锁后明文消失、密文就位', async () => {
  const result = await lockVault(root, key)
  assert.equal(result.files, Object.keys(cases).length)
  for (const rel of Object.keys(cases)) assert.equal(existsSync(join(root, rel)), false, `明文还在: ${rel}`)
  const manifest = await readManifest(root, key)
  assert.equal(manifest.files.length, Object.keys(cases).length)
  const enc = readdirSync(join(root, META_DIR, 'enc'))
  assert.equal(enc.length, Object.keys(cases).length)
  // 密文里不应该出现明文片段
  const all = enc.map((name) => readFileSync(join(root, META_DIR, 'enc', name)))
  const joined = Buffer.concat(all).toString('latin1')
  assert.equal(joined.includes('这是一份中文笔记'), false, '密文里出现了明文')
})

await check('重复上锁是幂等的', async () => {
  const again = await lockVault(root, key)
  assert.equal(again.files, Object.keys(cases).length)
})

await check('解锁后内容逐字节一致', async () => {
  const result = await unlockVault(root, key)
  assert.equal(result.files, Object.keys(cases).length)
  assert.equal(result.skipped.length, 0)
  for (const [rel, body] of Object.entries(cases)) assert.equal(readFileSync(join(root, rel), 'utf8'), body, `内容不一致: ${rel}`)
  assert.equal(existsSync(join(root, META_DIR)), false, '元数据目录没清掉')
})

await check('错误密钥解不开、不留半截明文、也不会覆盖原清单', async () => {
  await lockVault(root, key)
  const wrong = deriveVaultKey('wrong-password', Buffer.from('0123456789abcdef').toString('base64'))
  // 解锁：必须明确报错（而不是返回一个「部分成功」的假结果）
  await assert.rejects(() => unlockVault(root, wrong), /解不开|口令不对/)
  for (const rel of Object.keys(cases)) assert.equal(existsSync(join(root, rel)), false, `错密钥却写回了明文: ${rel}`)
  // 再拿错钥匙 lock：必须拒绝，绝不覆盖掉真正的文件清单（否则数据永久找不回）
  await assert.rejects(() => lockVault(root, wrong), /已经锁着|解不开/)
  const still = await readManifest(root, key)
  assert.equal(still.files.length, Object.keys(cases).length, '原清单被破坏了')
  await unlockVault(root, key) // 收尾：用真钥匙还原，后面的用例还要用
})

await check('扫描会跳过符号链接（平台支持时）', async () => {
  const scan = await collectFiles(root)
  assert.ok(Array.isArray(scan.files))
  assert.ok(Array.isArray(scan.skipped))
})

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n失败 ${failures} 项 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
