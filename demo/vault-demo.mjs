/**
 * demo/vault-demo.mjs —— 给人看的：一个目录被加密前后，本地到底长什么样。
 *
 * 这不是测试，是演示。它会在工作区里建 `demo-vault/`，塞几个文件，
 * 用固定口令加密，然后把「树的形状」原样打印出来 —— 你可以自己去资源管理器对照。
 *
 * 用法：
 *   node demo/vault-demo.mjs            # 建样本 + 加密（留在锁定状态给你看）
 *   node demo/vault-demo.mjs --unlock   # 还原成明文
 *   node demo/vault-demo.mjs --reset    # 删掉 demo-vault 重来
 *
 * 口令固定是 demo-password，只用于这个演示目录，别拿它当你的真密码。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveVaultKey } from '../lib/secret.mjs'
import { lockVault, unlockVault, readManifest } from '../lib/vault.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', 'demo-vault')
const password = 'demo-password'
const salt = Buffer.from('demo-vault-salt-0').toString('base64')
const key = deriveVaultKey(password, salt)

/** 打印一棵目录树（跳过深度 3 以下不展开，够看清就行）。 */
function tree(dir, base = dir, depth = 0) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    const rel = relative(base, abs)
    const pad = '  '.repeat(depth)
    if (entry.isDirectory()) {
      console.log(`${pad}${entry.name}/`)
      if (depth < 3) tree(abs, base, depth + 1)
    } else {
      let size = 0
      try { size = statSync(abs).size } catch { /* 忽略 */ }
      // 密文文件名是 sha256(相对路径) 前 40 位，故意看不出原名
      console.log(`${pad}${entry.name}  (${size} B)`)
      void rel
    }
  }
}

const mode = process.argv.includes('--unlock') ? 'unlock'
  : process.argv.includes('--reset') ? 'reset' : 'lock'

if (mode === 'reset') {
  rmSync(root, { recursive: true, force: true })
  console.log('已删除 ' + root)
  process.exit(0)
}

if (mode === 'unlock') {
  if (!existsSync(root)) { console.error('没有 demo-vault，先跑一次不带参数的。'); process.exit(1) }
  const result = await unlockVault(root, key, (m) => console.log('  ' + m))
  console.log(`\n已还原 ${result.files} 个文件；失败 ${result.skipped.length} 个。`)
  console.log('\n现在本地看到的是普通明文文件：')
  tree(root)
  process.exit(0)
}

// ---- 建样本 ----
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, '客户资料', '2026Q3'), { recursive: true })
mkdirSync(join(root, '源码'), { recursive: true })
writeFileSync(join(root, '客户资料', '2026Q3', '报价单.md'), '# 报价\n单价 12800\n', 'utf8')
writeFileSync(join(root, '客户资料', '名单.csv'), '姓名,电话\n张三,13800000000\n', 'utf8')
writeFileSync(join(root, '源码', 'secret-config.json'), JSON.stringify({ token: 'sk-demo-not-real' }), 'utf8')
writeFileSync(join(root, 'README.txt'), '这个目录用来演示「加密前后本地长什么样」。\n', 'utf8')

console.log('加密前（你在资源管理器里看到的就是这个）：\n')
tree(root)

const result = await lockVault(root, key, (m) => console.log('  ' + m))

console.log(`\n已加密 ${result.files} 个文件 / ${(result.bytes / 1024).toFixed(1)} KB，跳过 ${result.skipped.length} 项。`)
console.log('加密后（同一个目录，现在长这样）：\n')
tree(root)

const manifest = await readManifest(root, key)
console.log('\nmanifest 里还留着原始相对路径（解密要用），但它自己也在 .dsh-chatlock/ 里，')
console.log('而且没有口令就解不开 —— 里面的 enc/*.bin 是 AES-256-GCM 密文。')
console.log(`manifest 记录的文件数：${manifest ? manifest.files.length : 0}`)
console.log(`\n想还原：node demo/vault-demo.mjs --unlock   （口令固定 ${password}）`)
