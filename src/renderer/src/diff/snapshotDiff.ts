import type { FolderEntry, FolderEntryStatus } from '../../../preload/index'
import { normDir } from '../../../shared/pathNorm'

/**
 * 文件夹对比快照基线的纯逻辑模块：
 * 快照文件结构定义、解析校验、快照 ↔ 当前扫描结果的状态变迁对照。
 * v2 起可选保存差异条目的双侧文件内容（contents），供对照模式双击进入
 * "快照基线内容 vs 当前内容"的单文件对比（快照只存内容不存判定外的任何派生数据）。
 */

/** 快照结构版本（不兼容变更时递增并让旧文件作废；v1 无 contents 字段，加载时功能降级为纯状态对照） */
export const SNAPSHOT_VERSION = 2

/**
 * 快照内容保存的单文件字节上限（对齐主进程语义判等的 SEMANTIC_MAX_BYTES）：
 * 超限侧不存内容（快照仍保存状态），双击该条目走常规当前文件对比。
 */
export const SNAPSHOT_FILE_MAX_BYTES = 2 * 1024 * 1024

/**
 * 快照内容总量上限（字符数）：差异条目内容合计超出时整体降级为纯状态快照
 * （保存永不失败，行为可预期优于按字典序随机截断），toast 告知用户。
 */
export const SNAPSHOT_CONTENTS_MAX_CHARS = 32 * 1024 * 1024

/** 单个差异条目的双侧内容（对应侧快照时刻不存在或超限为 null） */
export interface SnapshotContents {
  left: string | null
  right: string | null
}

/** 快照文件结构（JSON 落盘，与扫描结果同构 + 目录对与时间戳 + 可选差异内容） */
export interface FolderSnapshot {
  version: 1 | 2
  leftDir: string
  rightDir: string
  /** 保存时的语义判等开关（对照口径说明用） */
  semantic: boolean
  truncated: boolean
  total: number
  entries: FolderEntry[]
  /** 保存时间戳 */
  savedAt: number
  /** v2 可选：差异条目的双侧内容（key 为 rel；仅 isDiffStatus 条目；超限/总量降级时缺失） */
  contents?: Record<string, SnapshotContents>
}

/** 条目状态的合法值（解析校验共用） */
const ENTRY_STATUSES: FolderEntryStatus[] = [
  'same',
  'semantic-same',
  'different',
  'left-only',
  'right-only',
  'unreadable'
]

function isEntry(v: unknown): v is FolderEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  if (typeof e.rel !== 'string' || e.rel === '') return false
  if (typeof e.status !== 'string' || !ENTRY_STATUSES.includes(e.status as FolderEntryStatus)) {
    return false
  }
  if (e.leftSize !== null && typeof e.leftSize !== 'number') return false
  if (e.rightSize !== null && typeof e.rightSize !== 'number') return false
  if (e.approximate !== undefined && typeof e.approximate !== 'boolean') return false
  return true
}

/** 单条内容记录形态校验（left/right 为字符串或 null） */
function isContents(v: unknown): v is SnapshotContents {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    (c.left === null || typeof c.left === 'string') &&
    (c.right === null || typeof c.right === 'string')
  )
}

/**
 * 解析快照 JSON 文本：JSON 非法 / 版本不符（仅接受 1 与 2）/ 任一字段或条目形态异常
 * 一律回退 null（调用方提示加载失败，绝不部分加载）。
 * v1 快照无 contents 字段合法（加载后功能降级为纯状态对照）。
 */
export function parseSnapshot(raw: string): FolderSnapshot | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (obj.version !== 1 && obj.version !== 2) return null
    if (typeof obj.leftDir !== 'string' || typeof obj.rightDir !== 'string') return null
    if (typeof obj.semantic !== 'boolean' || typeof obj.truncated !== 'boolean') return null
    if (typeof obj.total !== 'number' || !Number.isFinite(obj.total)) return null
    if (typeof obj.savedAt !== 'number' || !Number.isFinite(obj.savedAt)) return null
    if (!Array.isArray(obj.entries) || !obj.entries.every(isEntry)) return null
    // contents 可选；存在时任一条目形态异常整体回退 null（与 entries 的绝不部分加载口径一致）
    let contents: Record<string, SnapshotContents> | undefined
    if (obj.contents !== undefined) {
      if (typeof obj.contents !== 'object' || obj.contents === null || Array.isArray(obj.contents)) {
        return null
      }
      const map: Record<string, SnapshotContents> = {}
      for (const [rel, val] of Object.entries(obj.contents as Record<string, unknown>)) {
        if (!isContents(val)) return null
        map[rel] = val
      }
      contents = map
    }
    return {
      version: obj.version,
      leftDir: obj.leftDir,
      rightDir: obj.rightDir,
      semantic: obj.semantic,
      truncated: obj.truncated,
      total: obj.total,
      entries: obj.entries,
      savedAt: obj.savedAt,
      ...(contents !== undefined ? { contents } : {})
    }
  } catch {
    return null
  }
}

/** 状态是否计为"有差异"（不同 / 仅一侧 / 无法读取） */
export function isDiffStatus(status: FolderEntryStatus): boolean {
  return (
    status === 'different' || status === 'left-only' || status === 'right-only' || status === 'unreadable'
  )
}

/** 状态变迁类型 */
export type SnapshotChange =
  /** 快照有差异 → 现在无差异（same / semantic-same） */
  | 'fixed'
  /** 快照无差异 → 现在有差异 */
  | 'regressed'
  /** 快照不存在 → 现在存在 */
  | 'new'
  /** 快照存在 → 现在不存在 */
  | 'gone'
  /** 快照有差异 → 现在仍有差异 */
  | 'changed'
  /** 双方都无差异 */
  | 'stable'

export interface SnapshotDiffEntry {
  rel: string
  change: SnapshotChange
  /** 当前条目（gone 时为 null） */
  current: FolderEntry | null
  /** 快照条目（new 时为 null） */
  baseline: FolderEntry | null
}

export interface SnapshotDiffStats {
  fixed: number
  regressed: number
  new: number
  gone: number
  changed: number
  stable: number
}

export interface SnapshotDiffResult {
  /** 全部对照条目（按 rel 字典序） */
  entries: SnapshotDiffEntry[]
  stats: SnapshotDiffStats
}

/** 变迁类型的人话标签（FolderView 徽章与文件夹报告共用同一实现） */
export const SNAPSHOT_CHANGE_LABEL: Record<SnapshotChange, string> = {
  fixed: '已修复',
  regressed: '新增差异',
  new: '新文件',
  gone: '已移除',
  changed: '仍有差异',
  stable: '保持一致'
}

/** 快照与当前扫描的目录对是否一致（路径归一化后比较；不一致时对照无意义，调用方拦截） */
export function snapshotDirsMatch(
  baseline: FolderSnapshot,
  leftDir: string,
  rightDir: string
): boolean {
  return normDir(baseline.leftDir) === normDir(leftDir) && normDir(baseline.rightDir) === normDir(rightDir)
}

/**
 * 对照快照基线与当前扫描：按 rel 对齐产出状态变迁。
 * 变迁语义以"是否有差异"（isDiffStatus）为主轴：
 * 有差异 ↔ 无差异 的翻转记 fixed / regressed；双侧均有差异记 changed（含差异形态变化）；
 * 单侧存在记 new / gone；双侧均无差异记 stable。
 */
export function diffSnapshot(
  baseline: FolderEntry[],
  current: FolderEntry[]
): SnapshotDiffResult {
  const baseMap = new Map(baseline.map((e) => [e.rel, e]))
  const curMap = new Map(current.map((e) => [e.rel, e]))
  const rels = [...new Set([...baseMap.keys(), ...curMap.keys()])].sort()
  const stats: SnapshotDiffStats = { fixed: 0, regressed: 0, new: 0, gone: 0, changed: 0, stable: 0 }
  const entries = rels.map((rel) => {
    const b = baseMap.get(rel) ?? null
    const c = curMap.get(rel) ?? null
    let change: SnapshotChange
    if (b === null) change = 'new'
    else if (c === null) change = 'gone'
    else if (isDiffStatus(b.status) && !isDiffStatus(c.status)) change = 'fixed'
    else if (!isDiffStatus(b.status) && isDiffStatus(c.status)) change = 'regressed'
    else if (isDiffStatus(b.status) && isDiffStatus(c.status)) change = 'changed'
    else change = 'stable'
    stats[change]++
    return { rel, change, current: c, baseline: b }
  })
  return { entries, stats }
}
