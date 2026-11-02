import { diffArrays, diffChars, diffWordsWithSpace, type Change } from 'diff'

/** 词级分段类型 */
export type SegKind = 'common' | 'insert' | 'delete'

export interface Seg {
  text: string
  kind: SegKind
}

export interface SideCell {
  /** 原文行号（1 基），缺行时为 null（该侧为空槽） */
  lineNo: number | null
  /** 该行原始文本，无行时为 null */
  text: string | null
  /** 词级高亮分段，仅修改行填充 */
  segs: Seg[] | null
}

export type RowKind = 'unchanged' | 'removed' | 'added' | 'modified'

export interface DiffRow {
  id: string
  rowKind: RowKind
  isChanged: boolean
  left: SideCell
  right: SideCell
}

export interface DiffSummary {
  changedLines: number
  inserted: number
  deleted: number
  modified: number
  /**
   * 字符粒度的新增量（码点数）：added 行计右侧整行文本、modified 行计 segs 的新增段。
   * 超长行防护（segs 为 null）的 modified 行无法细分，不计入。码点计数避免
   * emoji / CJK 扩展字符的代理对被拆成 2 个"字符"。
   */
  charsAdded: number
  /** 字符粒度的删除量（码点数）：removed 行计左侧整行文本、modified 行计 segs 的删除段 */
  charsDeleted: number
}

export interface DiffOptions {
  /** 忽略行首/行尾空白差异 */
  trimWhitespace?: boolean
  /** 忽略大小写 */
  ignoreCase?: boolean
  /** 忽略空行差异（两侧空白行互相判等，不产生增删差异） */
  ignoreBlankLines?: boolean
  /** 忽略全部行内空白（空格/制表符/全角空格等），仅比较实际文字内容；换行结构仍参与对比 */
  ignoreAllWhitespace?: boolean
  /**
   * 字符级对比：全部空白与换行结构都不参与判等，两侧全文归一化为字符流做 diff，
   * 差异以字符粒度回映射到行（跨行重组也能判等）。隐含 ignoreAllWhitespace 的全部语义；
   * 归一化流超限（CHAR_DIFF_MAX_CHARS）或编辑距离超限（CHAR_DIFF_MAX_EDIT）时
   * 自动降级为行级对比并置 charModeDowngraded；总预算随输入规模自适应
   * （charGroupBudget，下限与历史固定值一致）。
   */
  charMode?: boolean
  /**
   * 字符级对比的编辑距离上限覆盖值（内部参数，测试注入用）：
   * 生产不传，使用 CHAR_DIFF_MAX_EDIT 默认值。触发截断需跑满上限轮数的
   * Myers 迭代，测试以小阈值毫秒级构造降级场景。
   */
  charDiffMaxEdit?: number
}

export interface DiffResult {
  rows: DiffRow[]
  summary: DiffSummary
  /** 字符级对比因内容超限自动降级为行级对比时为 true（供界面与报告提示） */
  charModeDowngraded?: boolean
  /**
   * 字符级对比部分降级：存在完成字符级计算的变更组，也有超限按行级配对的变更组
   * （逐组预算制：单组超 CHAR_DIFF_MAX_CHARS / 编辑距离超限 / 总预算耗尽的组行级降级，
   * 其余组仍字符级）。与 charModeDowngraded 互斥（全部组降级时只置后者）。
   */
  charModePartial?: boolean
}

function emptyLine(): SideCell {
  return { lineNo: null, text: null, segs: null }
}

/**
 * 行级 + 字符粒度的差异统计（行级与字符级路径共用）。
 * 字符粒度按码点计数（[...text].length）：added 行计右侧整行、removed 行计左侧整行、
 * modified 行计 segs 的新增/删除段（行级词级与字符级回映射的 segs 结构一致，通用）；
 * 超长行防护（segs 为 null）的 modified 行无法细分，不计入字符统计。
 */
function summarize(rows: DiffRow[]): DiffSummary {
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
interface NumberedLine {
  text: string
  lineNo: number
}

/**
 * 词级高亮的单行长度上限：任一侧超长即跳过词级 diff，整行按行级背景展示。
 * 压缩产物 / base64 / 无换行日志的单行可达数 MB，词法 diff 会长时间阻塞渲染进程。
 */
const WORD_DIFF_MAX_LEN = 5000

/** 词级 diff：对同一对齐的左右两行求差异，得到左右两套高亮分段 */
function wordSegments(leftText: string, rightText: string): { left: Seg[]; right: Seg[] } {
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

/**
 * 行级对比：diffArrays 以“归一化行”做行级 LCS，得到增/删/同；
 * 删除段与新增段配对为“修改”行并做词级内联高亮。
 * trimWhitespace / ignoreCase / ignoreAllWhitespace 只影响“是否判等”，展示文本始终取原始行；
 * ignoreBlankLines 则把空白行从比较与视图中整体剔除（行号保留原值）。
 */
function computeLineDiff(
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

/** ============ 字符级对比 ============ */

/**
 * 字符级对比的字符总量上限（单个变更组两侧归一化流合计）：
 * diffChars 为 O(ND)，字符量与编辑距离任一超限都可能导致耗时失控。
 * 0.6.3 起对比按“行锚定 + 变更组分块”进行：相同内容不进入 diffChars，
 * 本上限只约束单个变更组——大文件（总量远超上限）只要变更集中在组内限额之下，
 * 字符级对比即可正常完成，不再整篇受限。
 */
export const CHAR_DIFF_MAX_CHARS = 50000

/**
 * 字符级对比的编辑距离上限：diffChars 以 maxEditLength 迭代轮数封顶，
 * 编辑距离超限立即放弃（返回 undefined）并降级为行级对比——
 * 差异过大时字符级高亮已失去可读性，行级语义足够。
 * 实测口径：5000 轮 × 5 万字符最坏约 5 秒（worker 内计算，界面不冻结）。
 */
export const CHAR_DIFF_MAX_EDIT = 5000

/**
 * 变更组字符级计算的预算下限（全部成功组两侧归一化流合计）：
 * 小输入的总预算即该值，行为与历史固定预算版本完全一致。
 */
export const CHAR_DIFF_GROUP_TOTAL_CHARS = CHAR_DIFF_MAX_CHARS * 2

/**
 * 变更组总预算上限：随输入规模自适应放宽的封顶值（单组耗时上界不变 ×
 * 预算组数上界），保证最坏总耗时仍有界（worker 内计算，界面不冻结）。
 */
export const CHAR_DIFF_BUDGET_MAX = CHAR_DIFF_MAX_CHARS * 20

/**
 * 按输入规模自适应的变更组总预算：全部组归一化流合计的一半，
 * 钳制在 [CHAR_DIFF_GROUP_TOTAL_CHARS, CHAR_DIFF_BUDGET_MAX]。
 * 大输入但变更组普遍较小的场景（固定预算会过早耗尽降级）得以按比例放宽；
 * 下限保证小输入行为与历史版本完全一致（已固化测试不受影响）。
 */
export function charGroupBudget(totalGroupChars: number): number {
  if (!Number.isFinite(totalGroupChars) || totalGroupChars <= 0) {
    return CHAR_DIFF_GROUP_TOTAL_CHARS
  }
  return Math.min(
    CHAR_DIFF_BUDGET_MAX,
    Math.max(CHAR_DIFF_GROUP_TOTAL_CHARS, Math.ceil(totalGroupChars / 2))
  )
}

/**
 * 字符级对比的重输入阈值（两侧原始字符总量）：超过即走 worker 后台计算。
 * 按 CHAR_DIFF_MAX_EDIT 对齐取值——同步快路径的最坏耗时 ≈ 流长 × 编辑距离，
 * 5000 × 5000 ≈ 0.5 秒量级（与 0.5.5 收紧后的口径相当）；
 * 且此类重输入往往行数很少（压缩 JSON / base64 单行），
 * 行数维度的重输入判定防不住，需以字符量兜底。
 */
export const CHAR_HEAVY_INPUT_CHARS = 5000

/** 空白字符判定：与 ignoreAllWhitespace 的 \s 语义一致（含换行、制表符、全角空格） */
function isWsChar(ch: string): boolean {
  return /\s/.test(ch)
}

/** 归一化字符流：剔除全部空白后的连续字符，并记录每个字符的原始行号与码点列号 */
interface CharStream {
  /** 归一化字符连成的字符串（供 diffChars 直接消费） */
  text: string
  /** 与 text 逐字符对应的原始行号（1 基） */
  lineNos: number[]
  /** 与 text 逐字符对应的原始码点列号（0 基） */
  cols: number[]
}

/**
 * 变更组的归一化流：组内各行拼接为一个字符流，
 * 行号与列号取原始文件位置（供字符差异回映射到行）。
 * lineIdx 为组内行的 0 基下标序列（左右两侧各自收集）。
 */
function groupStream(orig: string[], lineIdx: number[], norm: (ch: string) => string): CharStream {
  const chars: string[] = []
  const lineNos: number[] = []
  const cols: number[] = []
  for (const li of lineIdx) {
    let col = 0
    for (const ch of orig[li]) {
      if (!isWsChar(ch)) {
        chars.push(norm(ch))
        lineNos.push(li + 1)
        cols.push(col)
      }
      col++
    }
  }
  return { text: chars.join(''), lineNos, cols }
}

/**
 * 按行内字符状态重建高亮分段（modified 行的 segs）：
 * 非空白字符查状态表（缺省 common）；空白字符继承前一个非空白字符的状态（行首空白按 common），
 * 保证被删除文本中间的空白归入删除段、新增文本中间的空白归入新增段。
 */
function charSegs(text: string, stat: Map<number, number> | undefined): Seg[] {
  const segs: Seg[] = []
  let cur: SegKind | null = null
  let buf = ''
  let lastStat = 0
  let col = 0
  for (const ch of text) {
    let st: number
    if (isWsChar(ch)) {
      st = lastStat
    } else {
      st = stat?.get(col) ?? 0
      lastStat = st
    }
    const kind: SegKind = st === 1 ? 'delete' : st === 2 ? 'insert' : 'common'
    if (kind !== cur) {
      if (cur !== null) segs.push({ text: buf, kind: cur })
      cur = kind
      buf = ch
    } else {
      buf += ch
    }
    col++
  }
  if (cur !== null) segs.push({ text: buf, kind: cur })
  return segs
}

/**
 * 字符级对比（两阶段：行锚定 + 变更组分块）。
 *
 * 第一阶段：每行剔除全部空白（可选小写）后做行级判等——判等行的归一化字符流必然
 * 完全一致，是安全锚点，直接输出锚行；相同内容不进入第二阶段的 diffChars，
 * 因此归一化流总量不再受单次 diffChars 上限约束（大文件字符级不再整篇受限）。
 *
 * 第二阶段：连续的 removed/added 行块合为一个“变更组”，组内左右行拼接为归一化
 * 字符流送 diffChars（差异以字符粒度回映射到行）。逐组判定 + 预算制：组流不超过
 * CHAR_DIFF_MAX_CHARS、编辑距离不超过 CHAR_DIFF_MAX_EDIT 且在总预算内的组走字符级；
 * 超限/预算耗尽的组按行级配对输出（部分降级，置 charModePartial）；全部组降级
 * 才返回 null 由调用方整体降级（置 charModeDowngraded）。
 *
 * 无任何锚行时（两侧行归一化完全无交集）唯一变更组即全文，行为与整篇流对比同构。
 */
function computeCharDiff(
  leftText: string,
  rightText: string,
  options: DiffOptions
): DiffResult | null {
  const leftOrig = splitLines(leftText)
  const rightOrig = splitLines(rightText)
  // 大小写归一化在构造流时完成：toLowerCase 展开为多字符的字符（如 İ→i̇）退回原样，
  // 避免归一化后字符数变化破坏流索引（第一阶段行判等用整串 toLowerCase，两侧同样
  // 变换不影响判等一致性；流索引稳定性仍由逐字符守卫保证）
  const normCh = (ch: string): string => {
    if (!options.ignoreCase) return ch
    const lo = ch.toLowerCase()
    return lo.length === 1 ? lo : ch
  }

  // ===== 第一阶段：行归一化锚定 =====
  const normLine = (s: string): string => {
    const t = s.replace(/\s+/g, '')
    return options.ignoreCase ? t.toLowerCase() : t
  }
  const lineParts = diffArrays(leftOrig.map(normLine), rightOrig.map(normLine))

  // 输出时间线：锚行（行归一化判等，左右原文各自展示）与变更组占位按序交替
  const timeline: Array<{ kind: 'anchor'; ln: number; rn: number } | { kind: 'group'; g: number }> =
    []
  const groups: { l: number[]; r: number[] }[] = []
  let lPtr = 0
  let rPtr = 0
  for (const part of lineParts) {
    const len = part.value.length
    if (!part.added && !part.removed) {
      for (let i = 0; i < len; i++) {
        timeline.push({ kind: 'anchor', ln: lPtr + i, rn: rPtr + i })
      }
      lPtr += len
      rPtr += len
    } else {
      // 连续 removed/added 行块归为一个变更组（timeline 尾部已是本组则不重复占位）
      if (groups.length === 0 || timeline[timeline.length - 1].kind !== 'group') {
        groups.push({ l: [], r: [] })
        timeline.push({ kind: 'group', g: groups.length - 1 })
      }
      const g = groups[groups.length - 1]
      if (part.removed) {
        for (let i = 0; i < len; i++) g.l.push(lPtr + i)
        lPtr += len
      } else {
        for (let i = 0; i < len; i++) g.r.push(rPtr + i)
        rPtr += len
      }
    }
  }

  // ===== 第二阶段：变更组字符流 diff（逐组判定 + 预算制部分降级）=====
  const streams = groups.map((g) => ({
    ls: groupStream(leftOrig, g.l, normCh),
    rs: groupStream(rightOrig, g.r, normCh),
    // 组内行号集合（1 基）：限定 emitGroupRows 的锚行/尾部输出范围
    gl: new Set(g.l.map((i) => i + 1)),
    gr: new Set(g.r.map((i) => i + 1))
  }))
  /**
   * 逐组判定 + 预算制：组流 ≤ CHAR_DIFF_MAX_CHARS 且在剩余预算内、编辑距离 ≤ 上限的组
   * 走 diffChars（字符级）；单组超限 / 编辑距离超限 / 预算耗尽的组仅按行级配对输出
   * （不再牵连其余组）。预算按输入规模自适应（charGroupBudget），只被完成字符级
   * 计算的组消耗，最坏总耗时仍有界（上限封顶）。全部组都降级时返回 null
   * 由调用方整体降级（等价旧行为）。
   */
  const groupParts: Array<Change[] | null> = []
  const totalGroupChars = streams.reduce((acc, s) => acc + s.ls.text.length + s.rs.text.length, 0)
  let budget = charGroupBudget(totalGroupChars)
  let anyChar = false
  for (const { ls, rs } of streams) {
    const n = ls.text.length + rs.text.length
    if (n <= CHAR_DIFF_MAX_CHARS && n <= budget) {
      // maxEditLength 封顶 Myers 迭代轮数（编辑距离），防止 O(ND) 无界计算卡死；
      // jsdiff 超限时运行时返回 undefined（类型签名未标注，真值判断兜底）
      const parts = diffChars(ls.text, rs.text, {
        maxEditLength: options.charDiffMaxEdit ?? CHAR_DIFF_MAX_EDIT
      })
      if (parts) {
        groupParts.push(parts)
        budget -= n
        anyChar = true
        continue
      }
    }
    groupParts.push(null)
  }
  if (groups.length > 0 && !anyChar) return null

  // ===== 按时间线输出：锚行 + 变更组回映射（字符级组 / 行级降级组分发）=====
  const rows: DiffRow[] = []
  const lineLevelGroups = new Set<number>()
  for (const item of timeline) {
    if (item.kind === 'anchor') {
      rows.push({
        id: `r${rows.length}`,
        rowKind: 'unchanged',
        isChanged: false,
        left: { lineNo: item.ln + 1, text: leftOrig[item.ln], segs: null },
        right: { lineNo: item.rn + 1, text: rightOrig[item.rn], segs: null }
      })
    } else {
      const { ls, rs, gl, gr } = streams[item.g]
      const parts = groupParts[item.g]
      if (parts) {
        emitGroupRows(ls, rs, leftOrig, rightOrig, parts, rows, gl, gr)
      } else {
        lineLevelGroups.add(item.g)
        emitGroupLineLevel(groups[item.g], leftOrig, rightOrig, normLine, rows)
      }
    }
  }

  return {
    rows,
    summary: summarize(rows),
    // 存在行级降级组且也有字符级组：部分降级（供界面与报告提示）
    ...(lineLevelGroups.size > 0 ? { charModePartial: true } : {})
  }
}

/**
 * 行级降级组的输出：组内左右行以行归一化（字符级语义：剔除全部空白 + 可选小写）
 * 做行级 LCS 配对——判等行配 unchanged；相邻删除/新增块配 modified（词级高亮，
 * 与行级路径的 commitModified 同构，含超长行跳过词级防护）；多余侧降级 removed/added。
 * 供字符级对比的逐组预算制降级（超限组不再牵连其余组，也不整体降级）。
 */
function emitGroupLineLevel(
  g: { l: number[]; r: number[] },
  leftOrig: string[],
  rightOrig: string[],
  normLine: (s: string) => string,
  rows: DiffRow[]
): void {
  const leftLines = g.l.map((i) => ({ text: leftOrig[i], lineNo: i + 1 }))
  const rightLines = g.r.map((i) => ({ text: rightOrig[i], lineNo: i + 1 }))
  const parts = diffArrays(
    leftLines.map((p) => normLine(p.text)),
    rightLines.map((p) => normLine(p.text))
  )
  let li = 0
  let ri = 0
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

  const commitModified = (addedRows: NumberedLine[]): void => {
    const count = Math.max(queuedRemoved.length, addedRows.length)
    for (let i = 0; i < count; i++) {
      const l = queuedRemoved[i]
      const r = addedRows[i]
      if (l && r) {
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
    const value = part.value as string[]
    if (part.removed) {
      for (let i = 0; i < value.length; i++) queuedRemoved.push(leftLines[li + i])
      li += value.length
    } else if (part.added) {
      const added: NumberedLine[] = []
      for (let i = 0; i < value.length; i++) added.push(rightLines[ri + i])
      ri += value.length
      if (queuedRemoved.length > 0) commitModified(added)
      else {
        for (const r of added) {
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
      if (queuedRemoved.length > 0) flushRemoved()
      for (let i = 0; i < value.length; i++) {
        const lp = leftLines[li + i]
        const rp = rightLines[ri + i]
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'unchanged',
          isChanged: false,
          left: { lineNo: lp.lineNo, text: lp.text, segs: null },
          right: { lineNo: rp.lineNo, text: rp.text, segs: null }
        })
      }
      li += value.length
      ri += value.length
    }
  }
  if (queuedRemoved.length > 0) flushRemoved()
}

/**
 * 单个变更组的字符差异回映射：组内归一化流的 diffChars 结果 → 追加 DiffRow 到 rows。
 *
 * 回映射规则（输出仍为 DiffRow，视图/报告/导航零改动）：
 * - 含变更（删除/新增）字符的行为“变更行”（跨界行——既有 common 又有变更字符——也划归变更行，
 *   其 common 部分在 modified 行的 segs 中以 common 段呈现，信息不丢失）；
 * - 连续变更行组配对：等长配 modified（segs 按整行重建），多余侧降级 removed / added（与行级 commitModified 同构）；
 * - 组内对齐块之间的行（含纯空白行）为“锚行”，左右按序 zip 配对输出 unchanged，短侧空槽仍标 unchanged
 *   （字符级语义下纯空白行不构成差异）。
 */
function emitGroupRows(
  left: CharStream,
  right: CharStream,
  leftOrig: string[],
  rightOrig: string[],
  parts: Change[],
  rows: DiffRow[],
  groupL: Set<number>,
  groupR: Set<number>
): void {
  // 流区间块序列：common 为 eq 块，连续 removed/added 合并为 ne 块（与行级 parts 循环同构）
  interface Block {
    eq: boolean
    l0: number
    l1: number
    r0: number
    r1: number
    /** removed-only 时回拉的对侧配对行（见下方预处理说明） */
    pullR?: number
    /** added-only 时回拉的对侧配对行 */
    pullL?: number
  }
  const blocks: Block[] = []
  let li = 0
  let ri = 0
  for (const part of parts) {
    const len = part.value.length
    const isEq = !part.added && !part.removed
    const last = blocks[blocks.length - 1]
    if (!last || last.eq !== isEq) {
      blocks.push({ eq: isEq, l0: li, l1: li, r0: ri, r1: ri })
    }
    const b = blocks[blocks.length - 1]
    if (isEq) {
      b.l1 += len
      b.r1 += len
      li += len
      ri += len
    } else if (part.removed) {
      b.l1 += len
      li += len
    } else {
      b.r1 += len
      ri += len
    }
  }

  // ne 块字符状态与涉及行集合（跨界行划归变更组）
  const changedL = new Set<number>()
  const changedR = new Set<number>()
  for (const b of blocks) {
    if (b.eq) continue
    for (let i = b.l0; i < b.l1; i++) changedL.add(left.lineNos[i])
    for (let i = b.r0; i < b.r1; i++) changedR.add(right.lineNos[i])
  }

  // 已划归变更组的行（含跨界行与回拉行），锚段输出时排除
  const pairedL = new Set(changedL)
  const pairedR = new Set(changedR)

  // 单侧变更块（removed-only / added-only）的对侧行回拉：
  // 变更行与相邻 eq 块同行（跨界延续，如行内删除 abcXYZdef → abcdef）时，
  // 把对侧对齐行拉入变更组配对，使行内增删显示为 modified（字符高亮）而非整行 removed/added；
  // 跨行整行增删（变更行与相邻 eq 块不同行）不回拉，维持 removed/added 语义。
  // 约束：跨界判定与对齐行判定必须锚定同一个 eq 块（pe 或 nx），
  // 否则会拼接出跨越两个变更簇的假配对（多行换位场景曾把全 common 行误判为 added）。
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]
    if (b.eq) continue
    const pe = bi > 0 && blocks[bi - 1].eq ? blocks[bi - 1] : undefined
    const nx = bi + 1 < blocks.length && blocks[bi + 1].eq ? blocks[bi + 1] : undefined
    if (b.l0 < b.l1 && b.r0 === b.r1) {
      // removed-only：左侧变更行跨界时回拉右侧对齐行（pe 优先，两处判定同块）
      const firstL = left.lineNos[b.l0]
      const lastL = left.lineNos[b.l1 - 1]
      const viaPe = pe !== undefined && firstL === left.lineNos[pe.l1 - 1]
      const viaNx = nx !== undefined && lastL === left.lineNos[nx.l0]
      if (!viaPe && !viaNx) continue
      const rn =
        b.r0 < right.lineNos.length
          ? right.lineNos[b.r0]
          : right.lineNos.length > 0
            ? right.lineNos[right.lineNos.length - 1]
            : 0
      if (rn < 1) continue
      const crossR =
        (viaPe && rn === right.lineNos[pe!.r1 - 1]) ||
        (!viaPe && viaNx && rn === right.lineNos[nx!.r0])
      if (crossR) {
        b.pullR = rn
        pairedR.add(rn)
      }
    } else if (b.r0 < b.r1 && b.l0 === b.l1) {
      // added-only：右侧变更行跨界时回拉左侧对齐行（pe 优先，两处判定同块）
      const firstR = right.lineNos[b.r0]
      const lastR = right.lineNos[b.r1 - 1]
      const viaPe = pe !== undefined && firstR === right.lineNos[pe.r1 - 1]
      const viaNx = nx !== undefined && lastR === right.lineNos[nx.r0]
      if (!viaPe && !viaNx) continue
      const ln =
        b.l0 < left.lineNos.length
          ? left.lineNos[b.l0]
          : left.lineNos.length > 0
            ? left.lineNos[left.lineNos.length - 1]
            : 0
      if (ln < 1) continue
      const crossL =
        (viaPe && ln === left.lineNos[pe!.l1 - 1]) ||
        (!viaPe && viaNx && ln === left.lineNos[nx!.l0])
      if (crossL) {
        b.pullL = ln
        pairedL.add(ln)
      }
    }
  }

  // 行内变更字符的列位状态（行号 → 列号 → 1 删除 / 2 新增），供 segs 重建
  const statByLineL = new Map<number, Map<number, number>>()
  const statByLineR = new Map<number, Map<number, number>>()
  for (const b of blocks) {
    if (b.eq) continue
    for (let i = b.l0; i < b.l1; i++) {
      const ln = left.lineNos[i]
      let m = statByLineL.get(ln)
      if (!m) {
        m = new Map()
        statByLineL.set(ln, m)
      }
      m.set(left.cols[i], 1)
    }
    for (let i = b.r0; i < b.r1; i++) {
      const rn = right.lineNos[i]
      let m = statByLineR.get(rn)
      if (!m) {
        m = new Map()
        statByLineR.set(rn, m)
      }
      m.set(right.cols[i], 2)
    }
  }

  let pendingL: number[] = []
  let pendingR: number[] = []
  // 已输出进变更组的行：同行内多处变更（ne-eq-ne 落在同一行，如换位、同行两处替换）
  // 时，第二处收集必须跳过已消费的行，否则同一行会重复输出为多个 modified
  const doneL = new Set<number>()
  const doneR = new Set<number>()

  /** 变更行组配对输出（与行级 commitModified 同构：等长 modified / 多余降级 removed·added） */
  const flushChange = (): void => {
    const n = Math.max(pendingL.length, pendingR.length)
    for (let i = 0; i < n; i++) {
      const ln = pendingL[i]
      const rn = pendingR[i]
      if (ln !== undefined && rn !== undefined) {
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'modified',
          isChanged: true,
          left: {
            lineNo: ln,
            text: leftOrig[ln - 1],
            segs: charSegs(leftOrig[ln - 1], statByLineL.get(ln))
          },
          right: {
            lineNo: rn,
            text: rightOrig[rn - 1],
            segs: charSegs(rightOrig[rn - 1], statByLineR.get(rn))
          }
        })
        doneL.add(ln)
        doneR.add(rn)
      } else if (ln !== undefined) {
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'removed',
          isChanged: true,
          left: { lineNo: ln, text: leftOrig[ln - 1], segs: null },
          right: emptyLine()
        })
        doneL.add(ln)
      } else if (rn !== undefined) {
        rows.push({
          id: `r${rows.length}`,
          rowKind: 'added',
          isChanged: true,
          left: emptyLine(),
          right: { lineNo: rn, text: rightOrig[rn - 1], segs: null }
        })
        doneR.add(rn)
      }
    }
    pendingL = []
    pendingR = []
  }

  /** 锚行组按序 zip 配对输出 unchanged（短侧空槽，纯空白行不构成差异） */
  const emitAnchors = (la: number[], ra: number[]): void => {
    const n = Math.max(la.length, ra.length)
    for (let i = 0; i < n; i++) {
      const ln = la[i] ?? null
      const rn = ra[i] ?? null
      rows.push({
        id: `r${rows.length}`,
        rowKind: 'unchanged',
        isChanged: false,
        left: ln === null ? emptyLine() : { lineNo: ln, text: leftOrig[ln - 1], segs: null },
        right: rn === null ? emptyLine() : { lineNo: rn, text: rightOrig[rn - 1], segs: null }
      })
    }
  }

  // 行游标推进：锚段右边界 = 下一 ne 块首字符行 - 1（流尽则为组内末行）；
  // 锚行与尾部范围限定在组内行集合（组外行由时间线的锚行/其他组负责，防止重复输出）
  let lCursor = 1
  let rCursor = 1
  for (const b of blocks) {
    if (b.eq) {
      flushChange()
      const lEnd = b.l1 < left.lineNos.length ? left.lineNos[b.l1] - 1 : maxLine(groupL)
      const rEnd = b.r1 < right.lineNos.length ? right.lineNos[b.r1] - 1 : maxLine(groupR)
      const la: number[] = []
      for (let ln = lCursor; ln <= lEnd; ln++) {
        if (groupL.has(ln) && !pairedL.has(ln)) la.push(ln)
      }
      const ra: number[] = []
      for (let rn = rCursor; rn <= rEnd; rn++) {
        if (groupR.has(rn) && !pairedR.has(rn)) ra.push(rn)
      }
      emitAnchors(la, ra)
      lCursor = lEnd + 1
      rCursor = rEnd + 1
    } else {
      // 变更行收集（ne 块内行号单调不减，尾去重即可；跳过已输出的行防同行重复）；
      // 单侧变更块带上回拉的对侧配对行（回拉行已输出时同样跳过）
      for (let i = b.l0; i < b.l1; i++) {
        const ln = left.lineNos[i]
        if (pendingL[pendingL.length - 1] !== ln && !doneL.has(ln)) pendingL.push(ln)
      }
      for (let i = b.r0; i < b.r1; i++) {
        const rn = right.lineNos[i]
        if (pendingR[pendingR.length - 1] !== rn && !doneR.has(rn)) pendingR.push(rn)
      }
      if (b.pullR !== undefined && pendingR.length === 0 && !doneR.has(b.pullR)) {
        pendingR.push(b.pullR)
      }
      if (b.pullL !== undefined && pendingL.length === 0 && !doneL.has(b.pullL)) {
        pendingL.push(b.pullL)
      }
    }
  }
  flushChange()

  // 尾部剩余行（组内未被覆盖的空白行等）按锚行输出（同样限定组内行集合）
  const tailLa: number[] = []
  for (let ln = lCursor; ln <= maxLine(groupL); ln++) {
    if (groupL.has(ln) && !pairedL.has(ln)) tailLa.push(ln)
  }
  const tailRa: number[] = []
  for (let rn = rCursor; rn <= maxLine(groupR); rn++) {
    if (groupR.has(rn) && !pairedR.has(rn)) tailRa.push(rn)
  }
  emitAnchors(tailLa, tailRa)
}

/** 行号集合的最大行（空集合为 0，即无锚行可输出） */
function maxLine(lines: Set<number>): number {
  let m = 0
  for (const ln of lines) {
    if (ln > m) m = ln
  }
  return m
}
