import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import type { FolderEntry } from '../../../preload/index'
import type { ReportFormat } from '../diff/report'
import type { FolderSnapshot, SnapshotDiffResult } from '../diff/snapshotDiff'
import FolderHeader from './folder/FolderHeader'
import FolderList from './folder/FolderList'
import FolderToolbar from './folder/FolderToolbar'
import { FALLBACK_VIEWPORT, FOLDER_ROW_HEIGHT, OVERSCAN } from './folder/folderViewConfig'
import { useFolderViewState } from './folder/useFolderViewState'

export { FOLDER_ROW_HEIGHT } from './folder/folderViewConfig'

export interface FolderViewProps {
  leftDir: string
  rightDir: string
  entries: FolderEntry[]
  truncated: boolean
  total: number
  scanning: boolean
  /** 快照保存中（批量读取差异条目内容期间）：保存/加载快照入口禁用（保存遮罩不拦截交互，按钮级防抖） */
  saving?: boolean
  /** Ctrl+F 聚焦用：文件名搜索输入框 ref（App 持有并转发到 input；缺省时内部自持供清空按钮聚焦） */
  searchInputRef?: RefObject<HTMLInputElement | null>
  /** 比对进度（主进程推送；null = 尚无进度态，仅扫描中遮罩展示） */
  progress?: { done: number; total: number } | null
  /** 仅看差异（隐藏两侧一致的文件）；与状态过滤互斥（后者开启时本开关自动关闭） */
  onlyDiff: boolean
  onOnlyDiffChange: (v: boolean) => void
  /** 语义判等开关（字节不同但剔除空白后一致的文件计为“语义同”）；切换后重新扫描 */
  semantic: boolean
  onSemanticChange: (v: boolean) => void
  /** 忽略规则（gitignore 简化子集：`dir/` 目录剪枝、`*.ext` 通配、`name` 名字匹配）；应用后重新扫描 */
  ignoreRules: string[]
  onIgnoreRulesChange: (rules: string[]) => void
  /** 快照基线（null = 非对照模式；对照模式接管列表渲染） */
  snapshot: FolderSnapshot | null
  /** 快照对照结果（null = 非对照模式） */
  snapshotDiff: SnapshotDiffResult | null
  /** 保存当前对比结果为快照基线 */
  onSaveSnapshot: () => void
  /** 加载快照文件并与当前结果对照 */
  onLoadSnapshot: () => void
  /** 退出快照对照 */
  onExitSnapshot: () => void
  /** 重新选择两侧文件夹 */
  onReopen: () => void
  /** 不重选目录直接重新扫描（增量：指纹一致的条目零 IO 沿用） */
  onRescan: () => void
  /** 返回文件对比模式（清空文件夹状态） */
  onExit: () => void
  /** 导出文件夹对比报告 */
  onExport: (fmt: ReportFormat) => void
  /** 双击条目进入单文件对比 */
  onOpenEntry: (entry: FolderEntry) => void
  /** 双击目录行进入该目录的聚合对比（差异文件导航限定在子树内） */
  onOpenDir: (dirPath: string) => void
}

export default function FolderView({
  leftDir,
  rightDir,
  entries,
  truncated,
  total,
  scanning,
  saving = false,
  searchInputRef,
  progress,
  onlyDiff,
  onOnlyDiffChange,
  semantic,
  onSemanticChange,
  ignoreRules,
  onIgnoreRulesChange,
  snapshot,
  snapshotDiff,
  onSaveSnapshot,
  onLoadSnapshot,
  onExitSnapshot,
  onReopen,
  onRescan,
  onExit,
  onExport,
  onOpenEntry,
  onOpenDir
}: FolderViewProps): ReactElement {
  const view = useFolderViewState({
    leftDir,
    rightDir,
    entries,
    snapshot,
    snapshotDiff,
    onlyDiff,
    onOnlyDiffChange,
    onIgnoreRulesChange
  })

  // 虚拟滚动：固定行高换算可见窗口（与 DiffView 同思路；对照模式与树形模式共用窗口状态）
  const scrollRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 0 })
  const listCount = view.snapList !== null ? view.snapList.length : view.rows.length

  const updateRange = (): void => {
    const el = scrollRef.current
    if (!el) return
    const vh = el.clientHeight || FALLBACK_VIEWPORT
    const start = Math.max(0, Math.floor(el.scrollTop / FOLDER_ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(listCount, Math.ceil((el.scrollTop + vh) / FOLDER_ROW_HEIGHT) + OVERSCAN)
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }

  useLayoutEffect(() => {
    updateRange()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listCount])

  // 窗口尺寸变化时按新视口高度补齐渲染窗口（与 DiffView 同思路；
  // 缺失该监听时拉伸窗口变高后底部出现空白区，滚动一下才恢复）
  useEffect(() => {
    const onResize = (): void => updateRange()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listCount])

  return (
    <div className="folder-view">
      <FolderHeader
        leftDir={leftDir}
        rightDir={rightDir}
        scanning={scanning}
        saving={saving}
        onRescan={onRescan}
        onReopen={onReopen}
        onSaveSnapshot={onSaveSnapshot}
        onLoadSnapshot={onLoadSnapshot}
        onExit={onExit}
        onExport={onExport}
      />
      <FolderToolbar
        view={view}
        searchInputRef={searchInputRef}
        scanning={scanning}
        semantic={semantic}
        onSemanticChange={onSemanticChange}
        onlyDiff={onlyDiff}
        truncated={truncated}
        total={total}
        entriesCount={entries.length}
        ignoreRules={ignoreRules}
        snapshot={snapshot}
        snapshotDiff={snapshotDiff}
        onExitSnapshot={onExitSnapshot}
      />
      <FolderList
        view={view}
        scrollRef={scrollRef}
        range={range}
        updateRange={updateRange}
        listCount={listCount}
        scanning={scanning}
        progress={progress}
        snapshot={snapshot}
        entriesCount={entries.length}
        onOpenEntry={onOpenEntry}
        onOpenDir={onOpenDir}
      />
    </div>
  )
}
