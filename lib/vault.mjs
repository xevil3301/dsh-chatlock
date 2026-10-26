/**
 * lib/vault.mjs —— 保险箱：把一个目录整体加密 / 解密。
 *
 * 目录结构（全部藏在 `<root>/.dsh-chatlock/` 里）：
 *
 *   manifest.json   { version, root, files:[{ rel, size, enc, mtime, dir }], createdAt }
 *   enc/<hash>.bin  每个文件一条密文（见 lib/crypt.mjs 的格式）
 *
 * 三条工程上的硬要求：
 *  1. **可中断、可重入**：每一步都是「写临时文件 → rename → 删原件」，
 *     崩在任何一步都只是让同一文件出现两份，重跑一遍就收敛，永远不会只剩半截。
 *  2. **不碰符号链接**：跟出去可能加密到保险箱外面的文件，直接跳过并记进报告。
 *  3. **上限**：单文件 > MAX_FILE_BYTES 跳过并记进报告，不做「悄悄漏掉」。
 */
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { MAX_FILE_BYTES, decryptFileTo, encryptFileTo, openBuffer, sealBuffer } from './crypt.mjs'

/** 每个保险箱内部元数据目录名。 */
export const META_DIR = '.dsh-chatlock'

/** manifest 结构版本。 */
const MANIFEST_VERSION = 1

/** 该保险箱的元数据目录。 */
export function metaDirOf(root) {
  return join(root, META_DIR)
}

/** 该保险箱的 manifest 路径（**加密**存放；明文里不含任何原始文件名）。 */
export function manifestPathOf(root) {
  return join(metaDirOf(root), 'manifest.enc')
}

/** 该保险箱的密文目录。 */
export function cipherDirOf(root) {
  return join(metaDirOf(root), 'enc')
}

/** rel → 稳定的密文文件名。 */
function encNameOf(rel) {
  return createHash('sha256').update(rel.replace(/\\/g, '/')).digest('hex').slice(0, 40) + '.bin'
}

/** rel 是否安全地落在 root 里（挡住 ../ 和绝对路径）。 */
function insideRoot(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return false
  const abs = resolve(root, rel)
  const base = resolve(root)
  return abs === base || abs.startsWith(base + sep)
}

/**
 * 递归收集文件（跳过元数据目录、符号链接、以及超过上限的文件）。
 * @param root - 保险箱根目录。
 * @param log - 可选日志函数。
 * @returns {{files: Array<{rel:string,size:number,mtime:number}>, skipped: Array<{rel:string,why:string}>, bytes:number}}
 */
export async function collectFiles(root, log) {
  const files = []
  const skipped = []
  let bytes = 0

  async function walk(dir, relBase) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ rel: relBase || '.', why: `读取目录失败: ${error?.code || error?.message}` })
      return
    }
    for (const entry of entries) {
      const rel = relBase ? join(relBase, entry.name) : entry.name
      if (!relBase && entry.name === META_DIR) continue
      const abs = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped.push({ rel, why: '符号链接（不跟随）' })
        continue
      }
      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ rel, why: '不是普通文件' })
        continue
      }
      let stat
      try {
        stat = await fsp.stat(abs)
      } catch (error) {
        skipped.push({ rel, why: `stat 失败: ${error?.code || error?.message}` })
        continue
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.push({ rel, why: `超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB` })
        continue
      }
      files.push({ rel, size: stat.size, mtime: Math.floor(stat.mtimeMs) })
      bytes += stat.size
    }
  }

  await walk(root, '')
  log?.(`扫描完成：${files.length} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)} MB，跳过 ${skipped.length} 项`)
  return { files, skipped, bytes }
}

/** manifest 是否存在（= 这个目录处于锁定状态）。 */
export function manifestExists(root) {
  return existsSync(manifestPathOf(root))
}

/**
 * 读 manifest（不存在返回 null）。
 *
 * ⚠️ 必须给 key：manifest 是加密的 —— 原始相对路径（文件名）本身就是隐私，
 * 不能以明文躺在磁盘上，否则「加密了目录」仍然会泄漏你有哪些文件。
 */
export async function readManifest(root, key) {
  try {
    const sealed = await fsp.readFile(manifestPathOf(root))
    const plain = openBuffer(sealed, key)
    const parsed = JSON.parse(plain.toString('utf8'))
    if (!parsed || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.files)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 上锁：把 root 下所有文件换成密文并删掉明文。
 * @param root - 保险箱根目录（绝对路径）。
 * @param key - 32 字节密钥。
 * @param log - 日志函数。
 * @returns {{files:number, bytes:number, skipped:Array<{rel:string,why:string}>}}
 */
export async function lockVault(root, key, log) {
  const meta = metaDirOf(root)
  const encDir = cipherDirOf(root)
  await fsp.mkdir(encDir, { recursive: true })

  // 有 manifest 就沿用（上次中断的续跑），没有就现扫一遍。
  let manifest = await readManifest(root, key)
  if (!manifest && manifestExists(root)) {
    // 已经锁着、但 manifest 解不开：口令不对或文件坏了。
    // 绝不能当成「没锁过」重新扫 —— 那会用一把错的钥匙覆盖掉真正的文件清单，数据就永久丢了。
    throw new Error('这个保险箱已经锁着，但用当前口令解不开它的清单（口令不对，或 .dsh-chatlock 被改过）。已拒绝写入，避免覆盖原有的文件清单。')
  }
  if (!manifest) {
    const scan = await collectFiles(root, log)
    manifest = {
      version: MANIFEST_VERSION,
      root,
      createdAt: Date.now(),
      files: scan.files.map((file) => ({ ...file, enc: encNameOf(file.rel) })),
      skipped: scan.skipped,
    }
    await writeManifest(root, manifest, key)
  }

  let done = 0
  let bytes = 0
  const failures = []
  for (const file of manifest.files) {
    if (!insideRoot(root, file.rel)) {
      failures.push({ rel: file.rel, why: 'manifest 里的相对路径越界' })
      continue
    }
    const abs = join(root, file.rel)
    const encAbs = join(encDir, file.enc)
    let hasPlain = false
    try {
      hasPlain = (await fsp.stat(abs)).isFile()
    } catch { hasPlain = false }
    if (!hasPlain) {
      // 已经加密过（续跑或空文件被删），只要密文在就算完成。
      try { await fsp.stat(encAbs); done += 1; bytes += file.size } catch { failures.push({ rel: file.rel, why: '明文与密文都不存在' }) }
      continue
    }
    const tmp = encAbs + '.tmp'
    try {
      await fsp.unlink(tmp).catch(() => {})
      await encryptFileTo(abs, tmp, key)
      await fsp.rename(tmp, encAbs)
      await fsp.unlink(abs)
      done += 1
      bytes += file.size
    } catch (error) {
      try { await fsp.unlink(tmp) } catch { /* 清理失败无所谓 */ }
      failures.push({ rel: file.rel, why: String(error?.message ?? error) })
    }
  }

  // 清掉加密后留下的空目录（自底向上，失败就留着，不影响安全）。
  await pruneEmptyDirs(root, manifest.files.map((f) => dirname(f.rel)))

  manifest.lockedAt = Date.now()
  manifest.failures = failures
  await writeManifest(root, manifest, key)
  log?.(`已加密 ${done}/${manifest.files.length} 个文件，失败 ${failures.length} 个`)
  return { files: done, bytes, skipped: [...(manifest.skipped || []), ...failures] }
}

/**
 * 解锁：把密文还原成明文。
 * @param root - 保险箱根目录。
 * @param key - 32 字节密钥。
 * @param log - 日志函数。
 * @returns {{files:number, bytes:number, skipped:Array<{rel:string,why:string}>}}
 */
export async function unlockVault(root, key, log) {
  const manifest = await readManifest(root, key)
  if (!manifest) throw new Error('找不到 manifest：这个目录不像是本插件加密过的保险箱（或口令不对）')
  const encDir = cipherDirOf(root)

  let done = 0
  let bytes = 0
  const failures = []
  for (const file of manifest.files) {
    if (!insideRoot(root, file.rel)) {
      failures.push({ rel: file.rel, why: 'manifest 里的相对路径越界' })
      continue
    }
    const abs = join(root, file.rel)
    const encAbs = join(encDir, file.enc)
    let hasCipher = false
    try {
      hasCipher = (await fsp.stat(encAbs)).isFile()
    } catch { hasCipher = false }
    if (!hasCipher) {
      // 明文已经在了 → 视为完成（续跑）。
      try { await fsp.stat(abs); done += 1; bytes += file.size } catch { failures.push({ rel: file.rel, why: '密文与明文都不存在' }) }
      continue
    }
    await fsp.mkdir(dirname(abs), { recursive: true })
    const tmp = abs + '.dshcl-tmp'
    try {
      await fsp.unlink(tmp).catch(() => {})
      await decryptFileTo(encAbs, tmp, key)
      await fsp.rename(tmp, abs)
      await fsp.unlink(encAbs)
      done += 1
      bytes += file.size
    } catch (error) {
      try { await fsp.unlink(tmp) } catch { /* 忽略 */ }
      failures.push({ rel: file.rel, why: String(error?.message ?? error) })
    }
  }

  // 全部成功才拆掉元数据；有失败就保留 manifest，方便重试。
  if (failures.length === 0) {
    await fsp.rm(metaDirOf(root), { recursive: true, force: true })
  } else {
    manifest.failures = failures
    await writeManifest(root, manifest, key)
  }
  log?.(`已解密 ${done}/${manifest.files.length} 个文件，失败 ${failures.length} 个`)
  return { files: done, bytes, skipped: failures }
}

/** 写 manifest（加密 + 原子）。 */
async function writeManifest(root, manifest, key) {
  const file = manifestPathOf(root)
  const tmp = file + '.tmp'
  await fsp.mkdir(dirname(file), { recursive: true })
  const sealed = sealBuffer(Buffer.from(JSON.stringify(manifest), 'utf8'), key)
  await fsp.writeFile(tmp, sealed, { mode: 0o600 })
  await fsp.rename(tmp, file)
}

/** 自底向上删空目录（不删根）。 */
async function pruneEmptyDirs(root, relDirs) {
  const unique = [...new Set(relDirs)].sort((a, b) => b.length - a.length)
  for (const rel of unique) {
    let dir = resolve(root, rel)
    const base = resolve(root)
    while (dir.startsWith(base + sep)) {
      try {
        const left = await fsp.readdir(dir)
        if (left.length > 0) break
        await fsp.rmdir(dir)
      } catch {
        break
      }
      dir = dirname(dir)
    }
  }
}

/** 目录是否像一个「已上锁」的保险箱。 */
export async function isLockedOnDisk(root) {
  // 只看元数据在不在：manifest 本身是加密的，没有 key 读不出来 —— 这也正是「已锁定」的定义。
  return manifestExists(root)
}

/** 明文文件数量粗估（扫描用，不读内容）。 */
export async function countPlainFiles(root) {
  const scan = await collectFiles(root)
  return { files: scan.files.length, bytes: scan.bytes }
}

/** 路径归一化：Windows 上大小写不敏感，比较前统一成小写 + 统一分隔符。 */
export function canonPath(path) {
  return resolve(String(path)).replace(/[\\/]+$/, '').toLowerCase()
}

/** child 是否位于 parent 之内（含相等）。 */
export function isInside(parent, child) {
  const p = canonPath(parent)
  const c = canonPath(child)
  return c === p || c.startsWith(p + sep)
}
