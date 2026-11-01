import iconv from 'iconv-lite'

/**
 * 文本解码与编码探测的纯逻辑模块（无 electron 依赖，vitest 直接测试）。
 * 入参类型为 Uint8Array：主进程同步路径传 Buffer（其子类），
 * 解码 worker 路径经结构化克隆收到 Uint8Array，两侧共用同一实现。
 */

/** 解码结果：文本 + 探测到的编码标注 + 二进制启发式判定 */
export interface DecodeResult {
  text: string
  encoding: string
  binary: boolean
}

/**
 * 缓冲区二进制启发式判定：出现 NUL 字节立即判定；
 * 否则统计前 8KB 内不可见控制字符占比（> 5% 视为二进制）。
 */
export function looksBinary(buf: Uint8Array): boolean {
  const len = Math.min(buf.length, 8000)
  if (len === 0) return false
  let suspicious = 0
  for (let i = 0; i < len; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++
  }
  return suspicious / len > 0.05
}

// iconv-lite 的类型签名要求 Buffer，运行时仅依赖 Uint8Array 接口（length/下标/subarray），
// 结构化克隆产生的 Uint8Array 直接传入安全，此断言不产生拷贝
const asBuffer = (u: Uint8Array): Buffer => u as unknown as Buffer

/**
 * 探测文本编码并解码：优先 BOM（UTF-8 / UTF-16 BE / UTF-16 LE），
 * 其次严格 UTF-8，失败则回退 GBK 解码。
 */
export function decodeText(buf: Uint8Array): DecodeResult {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder().decode(buf.subarray(3)), encoding: 'UTF-8 (BOM)', binary: false }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(asBuffer(buf.subarray(2)), 'utf16-be'), encoding: 'UTF-16 BE', binary: false }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le').decode(buf.subarray(2)),
      encoding: 'UTF-16 LE',
      binary: false
    }
  }
  // 严格 UTF-8 探测
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const text = decoder.decode(buf)
    return { text, encoding: 'UTF-8', binary: false }
  } catch {
    const text = iconv.decode(asBuffer(buf), 'gbk')
    // GBK 覆盖面广，二进制内容也能解出“文字”；用字节启发式 + 替换符占比双保险
    const bad = (text.match(/\uFFFD/g) ?? []).length
    const binary = looksBinary(buf) || (text.length > 0 && bad / text.length > 0.05)
    return { text, encoding: 'GBK', binary }
  }
}
