import { diffArrays } from 'diff'
import type { DiffOptions, DiffResult, DiffRow } from './types'
import {
  emptyLine,
  splitLines,
  summarize,
  wordSegments,
  WORD_DIFF_MAX_LEN,
  type NumberedLine
} from './common'

/**
 * 行级对比：diffArrays 以“归一化行”做行级 LCS，得到增/删/同；
 * 删除段与新增段配对为“修改”行并做词级内联高亮。
 * trimWhitespace / ignoreCase / ignoreAllWhitespace 只影响“是否判等”，展示文本始终取原始行；
 * ignoreBlankLines 则把空白行从比较与视图中整体剔除（行号保留原值）。
 */
export function computeLineDiff(
  leftText: string,
  rightText: string,
  options: DiffOptions = {}
): DiffResult {
  const leftOrig = splitLines(leftText)
  const rightOrig = splitLines(rightText)

  // 行号与行文本绑定；忽略空行模式下剔除空白行（行号保留原值，便于定位原始文件位置）
  const leftSeq: NumberedLine[] = leftOrig.map((text, i) => ({ text, lineNo: i + 1 }))
  const rightSeq: NumberedLine[] = rightOrig.map((text, i) => ({ text, lineNo: i + 1 }))
  const leftUsed = options.ignoreBlankLines ? leftSeq.filter((p) => p.text.trim() !== '') : leftSeq
  const rightUsed = options.ignoreBlankLines
    ? rightSeq.filter((p) => p.text.trim() !== '')
    : rightSeq

  const norm = (s: string): string => {
    // 忽略所有空白为 trimWhitespace 的超集：开启后行内空白一并剔除，trim 不再重复处理
    let v = options.ignoreAllWhitespace ? s.replace(/\s+/g, '') : s
    if (!options.ignoreAllWhitespace && options.trimWhitespace) v = v.trim()
    if (options.ignoreCase) v = v.toLowerCase()
    return v
  }
  const leftNorm = leftUsed.map((p) => norm(p.text))
  const rightNorm = rightUsed.map((p) => norm(p.text))

  const parts = diffArrays(leftNorm, rightNorm)
  const rows: DiffRow[] = []
  let leftPtr = 0 // 左侧下一个待消费下标（0 基，指向 leftUsed）
  let rightPtr = 0

  // 暂存的纯删除行（等待与随后新增配对）
  let queuedRemoved: NumberedLine[] = []

  const flushRemoved = (): void => {
    for (const r of queuedRemoved) {
      rows.push({
        id: `r${rows.length}`,
        rowKind: 'removed',
        isChanged: true,
        left: { lineNo: r.lineNo, text: r.text, segs: null },
        right: emptyLine()
      })
    }
    queuedRemoved = []
  }

  /** 删除段与新增段配对为修改行 */
  const commitModified = (addedRows: NumberedLine[]): void => {
    const count = Math.max(queuedRemoved.length, addedRows.length)
    for (let i = 0; i < count; i++) {
      const l = queuedRemoved[i]
      const r = addedRows[i]
      if (l && r) {
        // 任一侧超长则跳过词级高亮（segs 置空），行仍按 modified 展示行级背景
        const skipWordDiff = l.text.length > WORD_DIFF_MAX_LEN || r.text.length > WORD_DIFF_MAX_LEN
        const { left: lSegs, right: rSegs } = skipWordDiff
          ? { left: null, right: null }
          : wordSegments(l.text, r.text)
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'modified',
          isChanged: true,
          left: { lineNo: l.lineNo, text: l.text, segs: lSegs },
          right: { lineNo: r.lineNo, text: r.text, segs: rSegs }
        })
      } else if (l) {
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'removed',
          isChanged: true,
          left: { lineNo: l.lineNo, text: l.text, segs: null },
          right: emptyLine()
        })
      } else if (r) {
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'added',
          isChanged: true,
          left: emptyLine(),
          right: { lineNo: r.lineNo, text: r.text, segs: null }
        })
      }
    }
    queuedRemoved = []
  }

  for (const part of parts) {
    const value = part.value as string[] // diffArrays 的 value 为行数组
    if (part.removed) {
      const len = value.length
      for (let i = 0; i < len; i++) {
        queuedRemoved.push(leftUsed[leftPtr + i])
      }
      leftPtr += len
    } else if (part.added) {
      const len = value.length
      const addedRows: NumberedLine[] = []
      for (let i = 0; i < len; i++) {
        addedRows.push(rightUsed[rightPtr + i])
      }
      rightPtr += len
      if (queuedRemoved.length > 0) {
        commitModified(addedRows)
      } else {
        for (const r of addedRows) {
          rows.push({
            id: `r${rows.length}`,
            rowKind: 'added',
            isChanged: true,
            left: emptyLine(),
            right: { lineNo: r.lineNo, text: r.text, segs: null }
          })
        }
      }
    } else {
      // common
      if (queuedRemoved.length > 0) flushRemoved()
      const len = value.length
      for (let i = 0; i < len; i++) {
        const lp = leftUsed[leftPtr + i]
        const rp = rightUsed[rightPtr + i]
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'unchanged',
          isChanged: false,
          left: { lineNo: lp.lineNo, text: lp.text, segs: null },
          right: { lineNo: rp.lineNo, text: rp.text, segs: null }
        })
      }
      leftPtr += len
      rightPtr += len
    }
  }
  if (queuedRemoved.length > 0) flushRemoved()

  return { rows, summary: summarize(rows) }
}
