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
