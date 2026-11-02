import { splitLines } from './diffEngine'
import { TEXT_EXTENSIONS } from '../../../shared/textExtensions'

export { TEXT_EXTENSIONS }

/**
 * 判断文件名是否为允许的文本文件。
 * 无扩展名的文件按文本尝试放行；有扩展名但不在文本列表内则视为非文本。
 */
export function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return true
  const ext = name.slice(dot + 1).toLowerCase()
  return TEXT_EXTENSIONS.includes(ext)
}

/** 超多行预警阈值：超过该行数时提示后台计算可能耗时（diff 计算 worker 化后不阻塞界面） */
export const HEAVY_LINES = 50000

/** 统计文本行数，切分规则与 diff 引擎一致（结尾换行不计数） */
export function countLines(text: string): number {
  return splitLines(text).length
}

/** 判断码点是否为双宽字符（CJK / 全角 / 韩文 / 常见 emoji 区段） */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首 ~ 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // emoji 区段
    (cp >= 0x20000 && cp <= 0x3fffd) || // CJK 扩展 B+
    cp === 0x3000 // 全角空格
  )
}

/**
 * 估算等宽字体下的显示列宽：半角 1 列、双宽字符 2 列。
 * 用于虚拟滚动下预计算内容最小宽度，替代全量 DOM 的 max-content 测量。
 * cap 为列宽累计上限：达到即提前返回，供调用方跳过超长行的全量逐字符遍历。
 */
export function displayCols(text: string, cap?: number): number {
  let n = 0
  for (const ch of text) {
    n += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (cap !== undefined && n >= cap) return n
  }
  return n
}
