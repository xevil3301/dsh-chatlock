/**
 * .check-entry.mjs —— 用 dsh-m 自己的校验器，在提 PR 之前先把条目验一遍。
 *
 * 跑法：node .check-entry.mjs
 * 依赖：本机 profile 里装着的 dsh-m（lib/core/registry.js 的 validateRegistry）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const installed = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-m', 'lib', 'core', 'registry.js')
const { validateRegistry } = await import(pathToFileURL(installed).href)

const upstream = JSON.parse(readFileSync('.registry-upstream.json', 'utf8'))

const entry = {
  id: 'dsh-chatlock',
  name: 'DSH Chatlock',
  description: '给会话上密码锁，并把目录整体加密成保险箱，锁定后磁盘上只有密文。',
  category: 'watchlist',
  tags: ['隐私', '加密', '锁'],
  verified: ['0.2.1-rc.3'],
  source: 'github',
  github: 'xevil3301/dsh-chatlock',
  homepage: 'https://github.com/xevil3301/dsh-chatlock',
  icon: 'https://raw.githubusercontent.com/xevil3301/dsh-chatlock/main/assets/icon-180.png',
}

const next = { ...upstream, plugins: [...upstream.plugins, entry] }
const parsed = validateRegistry(next)
if (!parsed.ok) {
  console.error('✗ schema 不通过：')
  for (const e of parsed.errors) console.error('  -', e)
  process.exitCode = 1
} else {
  console.log(`✓ schema 通过，条目数 ${parsed.registry.plugins.length}`)
  const width = [...entry.description].reduce((n, ch) => n + (/[ -~]/.test(ch) ? 0.5 : 1), 0)
  console.log(`  描述宽度 ${width} 当量（上限 60）`, width > 60 ? '⚠ 超了' : '✓')
  const ids = parsed.registry.plugins.map((p) => p.id)
  console.log('  id 唯一性', new Set(ids).size === ids.length ? '✓' : '✗')
}

// 把插入后的 registry 写出来，供提交使用
readFileSync('.registry-upstream.json')
const serialized = JSON.stringify(next, null, 2) + '\n'
if (parsed.ok) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('.registry-next.json', serialized, 'utf8')
  console.log('已写出 .registry-next.json')
}
