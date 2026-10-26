/**
 * scripts/audit.mjs —— 死代码审计（人工清单，不是编译器）。
 *
 * 只看两件事
 *   1. 每个 export 出去的名字，在本仓库里到底有没有人用（0 次 = 僵尸）
 *   2. 每个文件 import 进来的名字，在该文件正文里到底有没有出现（0 次 = 多余 import）
 *
 * 跑法：node scripts/audit.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SKIP = new Set(['node_modules', '.git', 'demo-vault', 'assets'])

/**
 * 白名单：这些导出「在本仓库里没人用」是对的。
 * `Config` 由 cordis loader 读取，静态扫描看不到那个调用点。
 */
const ALLOW = new Set(['index.js → Config'])

const files = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs)
    else if (/\.(mjs|cjs|js|json|md)$/.test(entry)) files.push(abs)
  }
}
walk(ROOT)

const sources = files.filter((f) => /\.(mjs|cjs|js)$/.test(f))
const byFile = new Map(sources.map((f) => [f, readFileSync(f, 'utf8')]))
const allText = [...byFile.values()].join('\n')

const zombies = []
for (const [file, text] of byFile) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const re = /export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const name = m[1]
    if (ALLOW.has(`${rel} → ${name}`)) continue
    const uses = [...allText.matchAll(new RegExp('\\b' + name + '\\b', 'g'))].length
    const defs = [...text.matchAll(new RegExp('export (?:async )?(?:function|const|let|class) ' + name + '\\b', 'g'))].length
    if (uses - defs <= 0) zombies.push(`${rel} → ${name}`)
  }
}

const deadImports = []
for (const [file, text] of byFile) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"][^'"]+['"]/g
  let m
  while ((m = re.exec(text)) !== null) {
    const names = []
    if (m[1]) names.push(m[1].trim())
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const clean = part.trim().split(/\s+as\s+/).pop().trim()
        if (clean) names.push(clean)
      }
    }
    const body = text.slice(0, m.index) + text.slice(m.index + m[0].length)
    for (const name of names) {
      if (!(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b')).test(body)) deadImports.push(`${rel} → ${name}`)
    }
  }
}

console.log('=== 僵尸导出 ===')
console.log(zombies.length === 0 ? '  （无）' : zombies.map((z) => '  ' + z).join('\n'))
console.log('\n=== 没用上的 import ===')
console.log(deadImports.length === 0 ? '  （无）' : deadImports.map((d) => '  ' + d).join('\n'))

process.exitCode = zombies.length + deadImports.length > 0 ? 1 : 0
