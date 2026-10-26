/**
 * install.mjs —— 把本插件装进一个 dsh profile（默认 desktop）。
 *
 * 做的事只有三件，全部可重复执行：
 *   1. 把插件文件复制到 `<profile>/node_modules/dsh-chatlock`（**复制**而不是软链，
 *      因为宿主包解析要走 profile 那棵树，软链会按真实路径解析出去、找不到 @deepseek-ai/*）；
 *   2. 确保 `<profile>/cordis.patch.yml` 里有一条 `insert` 把 `chatlock` 这行加进配置树；
 *   3. 打印下一步。
 *
 * 用法：
 *   node install.mjs                 # 装进 desktop profile
 *   node install.mjs --profile web   # 装进别的 profile
 *   node install.mjs --dry           # 只看会做什么
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const profileArg = (() => {
  const index = argv.indexOf('--profile')
  return index >= 0 ? argv[index + 1] : 'desktop'
})()

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = join(dshHome, 'profiles', profileArg)
const target = join(profile, 'node_modules', 'dsh-chatlock')

if (!existsSync(profile)) {
  console.error(`找不到 profile：${profile}\n先跑一次 dsh（或指定 --profile <名字>）。`)
  process.exit(1)
}

const FILES = ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'package.json', 'README.md']
const present = FILES.filter((name) => existsSync(join(here, name)))

console.log(`源目录 : ${here}`)
console.log(`目标   : ${target}`)
console.log(`复制   : ${present.join(', ')}`)
if (dry) {
  console.log('\n[dry] 不做任何修改。')
  process.exit(0)
}

mkdirSync(target, { recursive: true })
for (const name of present) {
  const from = join(here, name)
  const to = join(target, name)
  if (name === 'lib') {
    rmSync(to, { recursive: true, force: true })
    cpSync(from, to, { recursive: true })
  } else {
    cpSync(from, to)
  }
}
console.log('✔ 文件已复制')

// ---- cordis.patch.yml ----
const patchFile = join(profile, 'cordis.patch.yml')
let patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
if (/name:\s*['"]?dsh-chatlock['"]?/.test(patch)) {
  console.log('✔ cordis.patch.yml 里已经有 chatlock 行，跳过')
} else {
  const block = [
    '',
    '# dsh-chatlock：聊天锁 / 保险箱（由 install.mjs 自动追加）',
    '- insert:',
    '    - id: chatlock',
    '      name: dsh-chatlock',
    '      config:',
    '        enabled: true',
    '',
  ].join('\n')
  // 空文件 / 只有注释的 `[]` 也需要能追加出合法 YAML：直接按数组追加即可。
  writeFileSync(patchFile, patch.replace(/\s*$/, '\n') + block, 'utf8')
  console.log('✔ 已写入 cordis.patch.yml')
}

console.log('\n下一步：重启 dsh（桌面端退出重开；CLI 端 Ctrl+C 后重新启动），')
console.log('然后到 设置 → 聊天锁 设置密码。')
