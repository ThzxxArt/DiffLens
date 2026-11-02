import { diffWordsWithSpace } from 'diff'
import type { DiffRow, DiffSummary, Seg, SideCell } from './types'

export function emptyLine(): SideCell {
  return { lineNo: null, text: null, segs: null }
}

/**
 * 行级 + 字符粒度的差异统计（行级与字符级路径共用）。
 * 字符粒度按码点计数（[...text].length）：added 行计右侧整行、removed 行计左侧整行、
 * modified 行计 segs 的新增/删除段（行级词级与字符级回映射的 segs 结构一致，通用）；
 * 超长行防护（segs 为 null）的 modified 行无法细分，不计入字符统计。
 */
export function summarize(rows: DiffRow[]): DiffSummary {
  let changedLines = 0
  let inserted = 0
  let deleted = 0
  let modified = 0
  let charsAdded = 0
  let charsDeleted = 0
  for (const r of rows) {
    if (r.isChanged) changedLines++
    if (r.rowKind === 'added') {
      inserted++
      if (r.right.text !== null) charsAdded += [...r.right.text].length
    } else if (r.rowKind === 'removed') {
      deleted++
      if (r.left.text !== null) charsDeleted += [...r.left.text].length
    } else if (r.rowKind === 'modified') {
      modified++
      if (r.right.segs !== null) {
        for (const s of r.right.segs) {
          if (s.kind === 'insert') charsAdded += [...s.text].length
        }
      }
      if (r.left.segs !== null) {
        for (const s of r.left.segs) {
          if (s.kind === 'delete') charsDeleted += [...s.text].length
        }
      }
    }
  }
  return { changedLines, inserted, deleted, modified, charsAdded, charsDeleted }
}

/** 带原始行号的行（忽略空行模式下空行被剔除，行号保留原值以维持定位） */
export interface NumberedLine {
  text: string
  lineNo: number
}

/**
 * 词级高亮的单行长度上限：任一侧超长即跳过词级 diff，整行按行级背景展示。
 * 压缩产物 / base64 / 无换行日志的单行可达数 MB，词法 diff 会长时间阻塞渲染进程。
 */
export const WORD_DIFF_MAX_LEN = 5000

/** 词级 diff：对同一对齐的左右两行求差异，得到左右两套高亮分段 */
export function wordSegments(leftText: string, rightText: string): { left: Seg[]; right: Seg[] } {
  const parts = diffWordsWithSpace(leftText, rightText)
  const left: Seg[] = []
  const right: Seg[] = []
  for (const part of parts) {
    if (part.added) {
      right.push({ text: part.value, kind: 'insert' })
    } else if (part.removed) {
      left.push({ text: part.value, kind: 'delete' })
    } else {
      left.push({ text: part.value, kind: 'common' })
      right.push({ text: part.value, kind: 'common' })
    }
  }
  return { left, right }
}

/** 按行切分；空字符串返回空数组。结尾换行符不产生一个额外空行（导出供行数统计复用，保持切分规则一致） */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
