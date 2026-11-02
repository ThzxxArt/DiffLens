import type { DiffOptions, DiffSummary } from '../diff/diffEngine'

export { MAX_FILE_SIZE } from '../../../shared/limits'

/** 快照保存批量读取的分批大小（主进程 folder:read-batch 上限 256，留余量） */
export const SNAPSHOT_READ_BATCH = 200

/** 用户偏好（比较选项 + 视图开关）持久化键 */
export const PREFS_KEY = 'difflens.prefs.v1'

/** 全部比较选项的默认值（严格对比；charDiffMaxEdit 为内部数值参数，不属于偏好） */
export const DEFAULT_OPTIONS: DiffOptions = {
  trimWhitespace: false,
  ignoreCase: false,
  ignoreBlankLines: false,
  ignoreAllWhitespace: false,
  charMode: false
}

/** 布尔型偏好键：持久化恢复只遍历这些字段（数值型内部参数不持久化）；as const 收窄保证赋值类型为 boolean */
export const PREF_BOOL_KEYS = [
  'trimWhitespace',
  'ignoreCase',
  'ignoreBlankLines',
  'ignoreAllWhitespace',
  'charMode'
] as const satisfies (keyof DiffOptions)[]

/** 计算中/无内容时的空统计（保持状态栏与徽章渲染稳定） */
export const EMPTY_SUMMARY: DiffSummary = {
  changedLines: 0,
  inserted: 0,
  deleted: 0,
  modified: 0,
  charsAdded: 0,
  charsDeleted: 0
}

/** toast 队列上限：超出时顶掉最旧的一条 */
export const TOAST_MAX = 3

/** 清空二次确认窗口时长：第一次点击后在此时间内再点确认，超时自动复位 */
export const CLEAR_CONFIRM_MS = 3000
