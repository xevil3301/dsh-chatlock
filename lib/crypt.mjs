/**
 * lib/crypt.mjs —— 文件级 AES-256-GCM 加解密。
 *
 * 格式（每个被加密的文件）：
 *
 *   magic       6B   "DSHCL1"
 *   iv         12B   random
 *   ciphertext  N
 *   tag        16B   GCM 认证标签（放在**末尾**，这样流式写不用回头改头）
 *
 * 为什么流式：工作区里可能有几十 MB 的日志/二进制，整块读进内存会把宿主进程顶爆。
 * 为什么 tag 放尾部：写的时候顺序 append，读的时候先 seek 到末尾取 16 字节。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export const MAGIC = Buffer.from('DSHCL1', 'ascii')
export const IV_BYTES = 12
export const TAG_BYTES = 16
export const HEADER_BYTES = MAGIC.length + IV_BYTES

/** 单文件上限：超过就跳过并记录，避免把内存/时间打满。 */
export const MAX_FILE_BYTES = 512 * 1024 * 1024

/**
 * 加密 src → dst。
 * @param src - 明文文件绝对路径。
 * @param dst - 输出密文绝对路径（父目录需已存在）。
 * @param key - 32 字节密钥。
 * @returns 密文字节数。
 */
export async function encryptFileTo(src, dst, key) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const out = createWriteStream(dst, { flags: 'wx', mode: 0o600 })
  out.write(Buffer.concat([MAGIC, iv]))
  await pipeline(createReadStream(src), cipher, out, { end: false })
  // pipeline 结束后 cipher 已 final，tag 就绪；再补到文件尾部并收尾。
  const tag = cipher.getAuthTag()
  await new Promise((resolve, reject) => {
    out.end(tag, (error) => (error ? reject(error) : resolve()))
  })
  const stat = await fsp.stat(dst)
  return stat.size
}

/**
 * 解密 src → dst。
 * @param src - 密文文件绝对路径。
 * @param dst - 输出明文绝对路径（父目录需已存在）。
 * @param key - 32 字节密钥。
 * @returns 明文字节数。
 * @throws 认证失败（密钥不对 / 文件被改过）时抛错，且不留半截明文。
 */
export async function decryptFileTo(src, dst, key) {
  const stat = await fsp.stat(src)
  if (stat.size < HEADER_BYTES + TAG_BYTES) throw new Error('密文太短，文件已损坏')
  const handle = await fsp.open(src, 'r')
  let iv
  let tag
  try {
    const head = Buffer.alloc(HEADER_BYTES)
    await handle.read(head, 0, HEADER_BYTES, 0)
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是本插件的密文（magic 不匹配）')
    iv = head.subarray(MAGIC.length, HEADER_BYTES)
    const tagBuf = Buffer.alloc(TAG_BYTES)
    await handle.read(tagBuf, 0, TAG_BYTES, stat.size - TAG_BYTES)
    tag = tagBuf
  } finally {
    await handle.close()
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const bodyBytes = stat.size - HEADER_BYTES - TAG_BYTES
  if (bodyBytes === 0) {
    // 空文件：没有 body 可读（createReadStream 的 end < start 会直接抛），单独收尾。
    decipher.final() // 认证失败要在这里暴露出来，不能悄悄写个空文件了事
    await fsp.writeFile(dst, Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
    return 0
  }
  const body = createReadStream(src, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 })
  try {
    await pipeline(body, decipher, createWriteStream(dst, { flags: 'wx', mode: 0o600 }))
  } catch (error) {
    try { await fsp.unlink(dst) } catch { /* 清不掉也没关系，反正不认它 */ }
    throw error
  }
  const out = await fsp.stat(dst)
  return out.size
}

/**
 * 内存里密封一段数据（同一个容器格式，落盘用 encryptFileTo）。
 * manifest 用它加密：原始相对路径也是隐私，不能以明文躺在 `.dsh-chatlock/` 里。
 * @param buffer - 明文。
 * @param key - 32 字节密钥。
 * @returns 密文 Buffer（magic + iv + body + tag）。
 */
export function sealBuffer(buffer, key) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(buffer), cipher.final()])
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()])
}

/**
 * 打开 sealBuffer / encryptFileTo 产出的密文。
 * @param sealed - 密文 Buffer。
 * @param key - 32 字节密钥。
 * @returns 明文 Buffer。
 * @throws 密钥不对或内容被改过时抛错。
 */
export function openBuffer(sealed, key) {
  if (!Buffer.isBuffer(sealed) || sealed.length < HEADER_BYTES + TAG_BYTES) throw new Error('密文太短或类型不对')
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是本插件的密文（magic 不匹配）')
  const iv = sealed.subarray(MAGIC.length, HEADER_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const body = sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}
