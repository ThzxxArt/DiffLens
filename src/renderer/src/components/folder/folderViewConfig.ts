import type { FolderEntryStatus } from '../../../../preload/index'
import type { ReportFormat } from '../../diff/report'
import type { countFolderStats } from '../../diff/folderReport'
import { SNAPSHOT_CHANGE_LABEL, type SnapshotChange } from '../../diff/snapshotDiff'

/** 文件夹列表虚拟行高（px），与 global.css 的 --folder-row-height 保持一致，改动需双向同步 */
export const FOLDER_ROW_HEIGHT = 26

/** 上下各多渲染的缓冲行数 */
export const OVERSCAN = 8

/** 视口高度兜底值（jsdom 无布局时使用） */
export const FALLBACK_VIEWPORT = 600

/** 树形缩进步进（px / 深度） */
export const TREE_INDENT = 16

/** 导出格式清单（与单文件报告一致） */
export const FORMATS: { fmt: ReportFormat; label: string }[] = [
  { fmt: 'html', label: 'HTML 报告' },
  { fmt: 'txt', label: '纯文本' },
  { fmt: 'md', label: 'Markdown' }
]

export const STATUS_META: Record<FolderEntryStatus, { icon: string; label: string; cls: string }> =
  {
    same: { icon: '●', label: '相同', cls: 'st-same' },
    'semantic-same': { icon: '◐', label: '语义同', cls: 'st-sem' },
    different: { icon: '●', label: '不同', cls: 'st-diff' },
    'left-only': { icon: '◀', label: '仅左侧', cls: 'st-left' },
    'right-only': { icon: '▶', label: '仅右侧', cls: 'st-right' },
    unreadable: { icon: '⊘', label: '无法读取', cls: 'st-unread' }
  }

/** 状态过滤徽章与统计的展示配置（顺序即渲染顺序） */
export const BADGES: {
  status: FolderEntryStatus
  countKey: keyof ReturnType<typeof countFolderStats>
  text: string
}[] = [
  { status: 'same', countKey: 'same', text: '相同' },
  { status: 'semantic-same', countKey: 'semanticSame', text: '语义同' },
  { status: 'different', countKey: 'different', text: '不同' },
  { status: 'left-only', countKey: 'leftOnly', text: '仅左' },
  { status: 'right-only', countKey: 'rightOnly', text: '仅右' },
  { status: 'unreadable', countKey: 'unreadable', text: '无法读取' }
]

/** 快照变迁类型的展示配置（顺序即徽章渲染顺序；标签复用 snapshotDiff 的共享映射） */
export const SNAP_CHANGES: { key: SnapshotChange; text: string }[] = [
  { key: 'fixed', text: SNAPSHOT_CHANGE_LABEL.fixed },
  { key: 'regressed', text: SNAPSHOT_CHANGE_LABEL.regressed },
  { key: 'new', text: SNAPSHOT_CHANGE_LABEL.new },
  { key: 'gone', text: SNAPSHOT_CHANGE_LABEL.gone },
  { key: 'changed', text: SNAPSHOT_CHANGE_LABEL.changed },
  { key: 'stable', text: SNAPSHOT_CHANGE_LABEL.stable }
]
