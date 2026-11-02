import type { DiffOptions, DiffResult } from './engine/types'
import { computeCharDiff } from './engine/charDiff'
import { computeLineDiff } from './engine/lineDiff'

// 公共 API 保持不变：调用方继续从 diffEngine 导入类型、切分函数与字符级常量。
export type {
  SegKind,
  Seg,
  SideCell,
  RowKind,
  DiffRow,
  DiffSummary,
  DiffOptions,
  DiffResult
} from './engine/types'
export { splitLines } from './engine/common'
export {
  CHAR_DIFF_MAX_CHARS,
  CHAR_DIFF_MAX_EDIT,
  CHAR_DIFF_GROUP_TOTAL_CHARS,
  CHAR_DIFF_BUDGET_MAX,
  charGroupBudget,
  CHAR_HEAVY_INPUT_CHARS
} from './engine/charDiff'

/**
 * 计算文本差异（统一入口）。
 * charMode 开启时走字符级对比（超限自动降级行级并携带降级标志）；否则走行级对比。
 */
export function computeDiff(
  leftText: string,
  rightText: string,
  options: DiffOptions = {}
): DiffResult {
  if (options.charMode) {
    const charResult = computeCharDiff(leftText, rightText, options)
    if (charResult) return charResult
    // 内容超限或差异过大：降级为行级对比，选项取字符级语义的最接近子集
    // （全部空白忽略 + 空行忽略；换行结构差异是行级架构无法消除的边界）
    const result = computeLineDiff(leftText, rightText, {
      ...options,
      charMode: false,
      ignoreAllWhitespace: true,
      ignoreBlankLines: true,
      trimWhitespace: false
    })
    result.charModeDowngraded = true
    return result
  }
  return computeLineDiff(leftText, rightText, options)
}
