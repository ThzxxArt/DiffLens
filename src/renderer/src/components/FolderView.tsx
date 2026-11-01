import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import type { FolderEntry, FolderEntryStatus } from '../../../preload/index'
import { type ReportFormat } from '../diff/report'
import { countFolderStats, fmtSize } from '../diff/folderReport'
import type { FolderSnapshot, SnapshotChange, SnapshotDiffResult } from '../diff/snapshotDiff'
import { SNAPSHOT_CHANGE_LABEL } from '../diff/snapshotDiff'
import { useDismiss } from '../hooks/useDismiss'
import { compileIgnoreRules, IGNORE_RULES_MAX } from '../../../shared/ignoreRules'
import { buildFolderTree, filterEntries, flattenFolderTree, relExt } from './folderTree'

/** 文件夹列表虚拟行高（px），与 global.css 的 --folder-row-height 保持一致，改动需双向同步 */
export const FOLDER_ROW_HEIGHT = 26
/** 上下各多渲染的缓冲行数 */
const OVERSCAN = 8
/** 视口高度兜底值（jsdom 无布局时使用） */
const FALLBACK_VIEWPORT = 600
/** 树形缩进步进（px / 深度） */
const TREE_INDENT = 16

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
  searchInputRef?: RefObject<HTMLInputElement>
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

/** 导出格式清单（与单文件报告一致） */
const FORMATS: { fmt: ReportFormat; label: string }[] = [
  { fmt: 'html', label: 'HTML 报告' },
  { fmt: 'txt', label: '纯文本' },
  { fmt: 'md', label: 'Markdown' }
]

const STATUS_META: Record<FolderEntryStatus, { icon: string; label: string; cls: string }> = {
  same: { icon: '●', label: '相同', cls: 'st-same' },
  'semantic-same': { icon: '◐', label: '语义同', cls: 'st-sem' },
  different: { icon: '●', label: '不同', cls: 'st-diff' },
  'left-only': { icon: '◀', label: '仅左侧', cls: 'st-left' },
  'right-only': { icon: '▶', label: '仅右侧', cls: 'st-right' },
  unreadable: { icon: '⊘', label: '无法读取', cls: 'st-unread' }
}

/** 状态过滤徽章与统计的展示配置（顺序即渲染顺序） */
const BADGES: { status: FolderEntryStatus; countKey: keyof ReturnType<typeof countFolderStats>; text: string }[] = [
  { status: 'same', countKey: 'same', text: '相同' },
  { status: 'semantic-same', countKey: 'semanticSame', text: '语义同' },
  { status: 'different', countKey: 'different', text: '不同' },
  { status: 'left-only', countKey: 'leftOnly', text: '仅左' },
  { status: 'right-only', countKey: 'rightOnly', text: '仅右' },
  { status: 'unreadable', countKey: 'unreadable', text: '无法读取' }
]

/** 快照变迁类型的展示配置（顺序即徽章渲染顺序；标签复用 snapshotDiff 的共享映射） */
const SNAP_CHANGES: { key: SnapshotChange; text: string }[] = [
  { key: 'fixed', text: SNAPSHOT_CHANGE_LABEL.fixed },
  { key: 'regressed', text: SNAPSHOT_CHANGE_LABEL.regressed },
  { key: 'new', text: SNAPSHOT_CHANGE_LABEL.new },
  { key: 'gone', text: SNAPSHOT_CHANGE_LABEL.gone },
  { key: 'changed', text: SNAPSHOT_CHANGE_LABEL.changed },
  { key: 'stable', text: SNAPSHOT_CHANGE_LABEL.stable }
]

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
  // 导出下拉（点击外部 / Esc 关闭）
  const [exportOpen, setExportOpen] = useState(false)
  const exportWrapRef = useRef<HTMLDivElement>(null)
  const closeExport = useCallback((): void => setExportOpen(false), [])
  useDismiss(exportWrapRef, closeExport)

  // 快照下拉（保存/加载归组；点击外部 / Esc 关闭）
  const [snapOpen, setSnapOpen] = useState(false)
  const snapWrapRef = useRef<HTMLDivElement>(null)
  const closeSnap = useCallback((): void => setSnapOpen(false), [])
  useDismiss(snapWrapRef, closeSnap)

  // 内部搜索框 ref（清空按钮点击后聚焦用；外部传入 searchInputRef 时共用同一个）
  const innerSearchRef = useRef<HTMLInputElement>(null)
  const folderSearchRef = searchInputRef ?? innerSearchRef

  // 搜索（相对路径子串，不区分大小写；对照模式同样生效）
  const [query, setQuery] = useState('')
  // 状态精确过滤（null = 不过滤；与 onlyDiff 互斥）
  const [statusFilter, setStatusFilter] = useState<Set<FolderEntryStatus> | null>(null)
  // 扩展名精确过滤（null = 不过滤；与其他过滤条件取交集）
  const [extFilter, setExtFilter] = useState<Set<string> | null>(null)
  // 扩展名下拉（点击外部 / Esc 关闭）
  const [extOpen, setExtOpen] = useState(false)
  const extWrapRef = useRef<HTMLDivElement>(null)
  const closeExt = useCallback((): void => setExtOpen(false), [])
  useDismiss(extWrapRef, closeExt)
  // 折叠的目录集合（默认全展开；空集合 = 全部展开）
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  // 忽略规则下拉（草稿文本域；打开时以当前规则初始化，应用时解析为规则数组并触发重扫）
  const [ignoreOpen, setIgnoreOpen] = useState(false)
  const [ignoreDraft, setIgnoreDraft] = useState('')
  const ignoreWrapRef = useRef<HTMLDivElement>(null)
  const closeIgnore = useCallback((): void => setIgnoreOpen(false), [])
  useDismiss(ignoreWrapRef, closeIgnore)

  // 草稿的无效规则清单（实时提示，不再静默丢弃）：逐行 trim 后编译，收集非法规则原文
  const ignoreInvalid = useMemo(() => {
    const lines = ignoreDraft
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r !== '')
    return compileIgnoreRules(lines).invalid
  }, [ignoreDraft])

  // 快照对照模式的变迁类型过滤（null = 不过滤；单选 toggle）
  const [changeFilter, setChangeFilter] = useState<SnapshotChange | null>(null)

  // 目录对变化（重新选择新目录对）：重置全部视图层状态——旧搜索词 / 状态过滤 /
  // 扩展名过滤 / 折叠集合 / 变迁过滤对新目录无意义，残留会静默生效（旧目录的
  // 折叠路径会让新目录同名目录意外折叠、旧关键字继续过滤新列表）。
  // 同目录重扫（leftDir/rightDir 不变）不触发，保留用户视图状态。
  useEffect(() => {
    setQuery('')
    setStatusFilter(null)
    setExtFilter(null)
    setCollapsedDirs(new Set())
    setChangeFilter(null)
  }, [leftDir, rightDir])

  /** 应用忽略规则草稿：逐行解析、去空白、去空行，截断至上限后回调重扫 */
  const applyIgnoreDraft = useCallback((): void => {
    const rules = ignoreDraft
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r !== '')
      .slice(0, IGNORE_RULES_MAX)
    setIgnoreOpen(false)
    onIgnoreRulesChange(rules)
  }, [ignoreDraft, onIgnoreRulesChange])

  /** 清空全部忽略规则（立即生效并重扫） */
  const clearIgnore = useCallback((): void => {
    setIgnoreDraft('')
    setIgnoreOpen(false)
    onIgnoreRulesChange([])
  }, [onIgnoreRulesChange])

  // 统计（条目集不变时不重算；口径与报告导出共用同一实现，始终基于全量条目）
  const stats = useMemo(() => countFolderStats(entries), [entries])

  /** 全量条目的扩展名分布（字典序），扩展名过滤下拉的数据源 */
  const extStats = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of entries) {
      const x = relExt(e.rel)
      m.set(x, (m.get(x) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  }, [entries])

  /** 过滤 → 建树（剪枝：过滤后无文件的目录不出现） */
  const rows = useMemo(() => {
    const filtered = filterEntries(entries, { onlyDiff, statusFilter, query, exts: extFilter })
    const tree = buildFolderTree(filtered)
    const q = query.trim()
    // 搜索激活时强制全部展开（命中路径完整可见）；清空搜索恢复用户折叠状态
    const isExpanded = (dirPath: string): boolean =>
      q !== '' ? true : !collapsedDirs.has(dirPath)
    return flattenFolderTree(tree, isExpanded)
  }, [entries, onlyDiff, statusFilter, query, extFilter, collapsedDirs])

  /** 快照对照模式的对照条目列表（平铺全路径，含已移除条目；搜索与变迁过滤生效）。
   *  默认隐藏无变迁（stable）条目——对照价值在变迁；点击"保持一致"徽章可查看 */
  const snapList = useMemo(() => {
    if (snapshotDiff === null) return null
    const q = query.trim().toLowerCase()
    return snapshotDiff.entries.filter((e) => {
      if (changeFilter === null) {
        if (e.change === 'stable') return false
      } else if (e.change !== changeFilter) {
        return false
      }
      if (q !== '' && !e.rel.toLowerCase().includes(q)) return false
      return true
    })
  }, [snapshotDiff, query, changeFilter])

  /** 过滤后的文件数（"共 N / 总数"计数用，不含目录行） */
  const filteredCount = useMemo(
    () => filterEntries(entries, { onlyDiff, statusFilter, query, exts: extFilter }).length,
    [entries, onlyDiff, statusFilter, query, extFilter]
  )

  const toggleDir = useCallback((path: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  /** 仅看差异开关：开启时清空状态精确过滤（两机制互斥） */
  const handleOnlyDiff = useCallback(
    (v: boolean): void => {
      if (v) setStatusFilter(null)
      onOnlyDiffChange(v)
    },
    [onOnlyDiffChange]
  )

  /** 徽章点击：状态精确过滤 toggle；onlyDiff 开启时自动关闭 */
  const handleBadge = useCallback(
    (st: FolderEntryStatus): void => {
      setStatusFilter((prev) => {
        const next = new Set(prev ?? [])
        if (next.has(st)) next.delete(st)
        else next.add(st)
        return next.size === 0 ? null : next
      })
      if (onlyDiff) onOnlyDiffChange(false)
    },
    [onlyDiff, onOnlyDiffChange]
  )

  /** 扩展名下拉项点击：toggle 过滤集合（空集合回落 null = 不过滤） */
  const handleExtToggle = useCallback((ext: string): void => {
    setExtFilter((prev) => {
      const next = new Set(prev ?? [])
      if (next.has(ext)) next.delete(ext)
      else next.add(ext)
      return next.size === 0 ? null : next
    })
  }, [])

  /** 快照变迁徽章点击：单选 toggle（再点取消） */
  const handleSnapBadge = useCallback((change: SnapshotChange): void => {
    setChangeFilter((prev) => (prev === change ? null : change))
  }, [])

  // 对照结果刷新（重扫）后过滤的变迁类型计数归零：过滤自动复位为全部
  // （徽章已不渲染，残留过滤会让列表显示空态——0.9.3 收尾）
  useEffect(() => {
    if (changeFilter !== null && snapshotDiff !== null && snapshotDiff.stats[changeFilter] === 0) {
      setChangeFilter(null)
    }
  }, [snapshotDiff, changeFilter])

  // 虚拟滚动：固定行高换算可见窗口（与 DiffView 同思路；对照模式与树形模式共用窗口状态）
  const scrollRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 0 })
  const listCount = snapList !== null ? snapList.length : rows.length

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

  const q = query.trim()

  return (
    <div className="folder-view">
      {/* 两侧文件夹卡片 + 横排操作区（快照归组下拉；单行头部把高度留给条目列表） */}
      <div className="folder-head">
        <div className="folder-card left" title={leftDir}>
          <span className="pane-dot left" />
          <span className="folder-path">{leftDir}</span>
        </div>
        <div className="folder-card right" title={rightDir}>
          <span className="pane-dot right" />
          <span className="folder-path">{rightDir}</span>
        </div>
        <div className="folder-actions">
          <button
            className="btn ghost"
            disabled={scanning}
            title={scanning ? '正在扫描文件夹' : '重新扫描当前两个目录（增量：未变更的文件直接沿用判定）'}
            onClick={onRescan}
          >
            重新扫描
          </button>
          {/* 重新选择保持可用（与“返回文件对比”同类：发起新会话并作废在途扫描，
              竞态守卫保证迟到的旧结果被丢弃；大目录扫描慢时允许用户放弃改选） */}
          <button
            className="btn ghost"
            title="重新选择两个文件夹进行对比（扫描中点击将放弃当前扫描）"
            onClick={onReopen}
          >
            重新选择
          </button>
          <div className="export-wrap" ref={snapWrapRef}>
            <button
              className="btn ghost"
              disabled={scanning || saving}
              title={
                scanning
                  ? '正在扫描文件夹'
                  : saving
                    ? '正在保存快照'
                    : '保存当前对比结果为快照基线 / 加载之前保存的快照对照'
              }
              onClick={() => setSnapOpen((o) => !o)}
            >
              快照
            </button>
            {snapOpen && (
              <div className="export-menu">
                <button
                  className="ctx-item"
                  disabled={scanning || saving}
                  title={
                    saving
                      ? '正在保存快照'
                      : '保存当前对比结果为快照基线（JSON 文件），供日后加载对照'
                  }
                  onClick={() => {
                    setSnapOpen(false)
                    onSaveSnapshot()
                  }}
                >
                  保存快照…
                </button>
                <button
                  className="ctx-item"
                  disabled={scanning || saving}
                  title={
                    saving
                      ? '正在保存快照'
                      : '加载之前保存的快照，与当前结果对照（已修复 / 新增差异 / 新文件 / 已移除）'
                  }
                  onClick={() => {
                    setSnapOpen(false)
                    onLoadSnapshot()
                  }}
                >
                  加载快照…
                </button>
              </div>
            )}
          </div>
          <div className="export-wrap" ref={exportWrapRef}>
            <button
              className="btn ghost"
              disabled={scanning}
              title={scanning ? '正在扫描文件夹' : '导出文件夹对比报告（HTML / 纯文本 / Markdown）'}
              onClick={() => setExportOpen((o) => !o)}
            >
              导出报告
            </button>
            {exportOpen && (
              <div className="export-menu">
                {FORMATS.map((f) => (
                  <button
                    key={f.fmt}
                    className="ctx-item"
                    onClick={() => {
                      setExportOpen(false)
                      onExport(f.fmt)
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn ghost" onClick={onExit}>
            返回文件对比
          </button>
        </div>
      </div>

      {/* 工具行：对照模式渲染变迁统计，普通模式渲染状态统计 + 搜索 + 开关 */}
      {snapshotDiff !== null && snapshot !== null ? (
        <div className="folder-toolbar">
          <div className="folder-stats">
            {SNAP_CHANGES.map((c) => {
              const n = snapshotDiff.stats[c.key]
              // 零计数与保持一致的常态不占位（保持一致仅在存在时展示）
              if (n === 0) return null
              const active = changeFilter === c.key
              return (
                <button
                  key={c.key}
                  className={`fstat snap-${c.key}${active ? ' active' : ''}`}
                  title={
                    active
                      ? `点击取消“${c.text}”过滤`
                      : `点击只看“${c.text}”的条目（基于 ${new Date(snapshot.savedAt).toLocaleString('zh-CN')} 的快照基线）`
                  }
                  onClick={() => handleSnapBadge(c.key)}
                >
                  {c.text} {n}
                </button>
              )
            })}
            <span className="fstat muted" title="对照条目总数（快照与当前结果的并集）">
              共 {snapList !== null ? `${snapList.length} / ${snapshotDiff.entries.length}` : snapshotDiff.entries.length} 项
            </span>
          </div>
          <span className="fstat muted" title="快照基线的保存时间与判定口径">
            基线 {new Date(snapshot.savedAt).toLocaleString('zh-CN')}
            {snapshot.semantic ? ' · 语义判等' : ''}
          </span>
          <div className="search-box">
            <input
              ref={folderSearchRef}
              className="folder-search"
              type="text"
              value={query}
              placeholder="搜索文件名… (Ctrl+F)"
              spellCheck={false}
              title="在对照条目的相对路径内搜索（不区分大小写）：Esc 清空"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (query !== '') e.preventDefault()
                  setQuery('')
                  e.currentTarget.blur()
                }
              }}
            />
            {query.trim() !== '' && (
              <button
                className="search-clear"
                title="清空搜索（Esc）"
                onClick={() => {
                  setQuery('')
                  folderSearchRef.current?.focus()
                }}
              >
                ×
              </button>
            )}
          </div>
          <button className="btn ghost" onClick={onExitSnapshot} title="退出快照对照，恢复常规视图">
            退出对照
          </button>
        </div>
      ) : (
        <div className="folder-toolbar">
          <div className="folder-stats">
            {BADGES.map((b) => {
              // 语义关闭时语义同恒为 0，徽章隐藏（与旧版一致）
              if (b.status === 'semantic-same' && !semantic) return null
              // 无法读取为异常态：仅在出现时展示，平时不占位
              if (b.status === 'unreadable' && stats.unreadable === 0) return null
              const active = statusFilter?.has(b.status) ?? false
              return (
                <button
                  key={b.status}
                  className={`fstat ${STATUS_META[b.status].cls}${active ? ' active' : ''}`}
                  title={
                    active
                      ? `点击取消“${STATUS_META[b.status].label}”过滤`
                      : `点击只看“${STATUS_META[b.status].label}”的文件`
                  }
                  onClick={() => handleBadge(b.status)}
                >
                  {b.text} {stats[b.countKey]}
                </button>
              )
            })}
            <span className="fstat muted" title="条目总数（扩展名/状态过滤不影响统计徽章口径）">
              共 {extFilter !== null || statusFilter !== null ? `${filteredCount} / ${entries.length}` : entries.length} 项
            </span>
          </div>
          <div className="export-wrap" ref={extWrapRef}>
            <button
              className={'btn ghost' + (extFilter !== null ? ' filtered' : '')}
              title="按扩展名过滤条目（可多选，与其他过滤条件取交集）"
              onClick={() => setExtOpen((o) => !o)}
            >
              扩展名{extFilter !== null ? ` · ${extFilter.size}` : ''}
            </button>
            {extOpen && (
              <div className="export-menu ext-menu">
                {extStats.map(([ext, n]) => {
                  const on = extFilter?.has(ext) ?? false
                  return (
                    <button
                      key={ext}
                      className={'ctx-item' + (on ? ' active' : '')}
                      title={on ? `点击取消“${ext === '' ? '无扩展名' : '.' + ext}”过滤` : `点击只看“${ext === '' ? '无扩展名' : '.' + ext}”的文件`}
                      onClick={() => handleExtToggle(ext)}
                    >
                      {ext === '' ? '（无扩展名）' : `.${ext}`}
                      <span className="ext-count">{n}</span>
                    </button>
                  )
                })}
                {extFilter !== null && (
                  <button className="ctx-item ext-clear" onClick={() => setExtFilter(null)}>
                    清除扩展名过滤
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="export-wrap" ref={ignoreWrapRef}>
            <button
              className={'btn ghost' + (ignoreRules.length > 0 ? ' filtered' : '')}
              disabled={scanning}
              title={
                scanning
                  ? '正在扫描文件夹'
                  : '忽略规则（gitignore 简化子集含高级 glob）：node_modules/ 目录整树剪枝、*.log 通配、lo?g 单字符、*.[ch] 字符类、src/temp 多段路径、build/**/cache 跨段、!keep.log 否定；应用后重新扫描'
              }
              onClick={() => {
                setIgnoreDraft(ignoreRules.join('\n'))
                setIgnoreOpen((o) => !o)
              }}
            >
              忽略规则{ignoreRules.length > 0 ? ` · ${ignoreRules.length}` : ''}
            </button>
            {ignoreOpen && (
              <div className="export-menu ignore-menu">
                <textarea
                  className="ignore-input"
                  value={ignoreDraft}
                  rows={8}
                  spellCheck={false}
                  placeholder={
                    '每行一条（gitignore 简化子集）：\nnode_modules/    目录整树剪枝\n*.log           扩展名通配\nlo?g            ? 单字符\n*.[ch]          [abc] 字符类\nsrc/temp        多段路径（从根）\nbuild/**/cache  ** 跨段\n!keep.log       否定（最后匹配优先）'
                  }
                  onChange={(e) => setIgnoreDraft(e.target.value)}
                />
                {ignoreInvalid.length > 0 && (
                  <div className="ignore-invalid" title="以下规则不被支持，应用时将被忽略">
                    将被忽略的无效规则：{ignoreInvalid.join('、')}
                  </div>
                )}
                <button className="ctx-item" onClick={applyIgnoreDraft}>
                  应用并重扫
                </button>
                <button className="ctx-item ext-clear" onClick={clearIgnore}>
                  清空规则
                </button>
              </div>
            )}
          </div>
          <div className="search-box">
            <input
              ref={folderSearchRef}
              className="folder-search"
              type="text"
              value={query}
              placeholder="搜索文件名… (Ctrl+F)"
              spellCheck={false}
              title="在全部条目的相对路径内搜索（不区分大小写）：Esc 清空"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (query !== '') e.preventDefault()
                  setQuery('')
                  e.currentTarget.blur()
                }
              }}
            />
            {query.trim() !== '' && (
              <button
                className="search-clear"
                title="清空搜索（Esc）"
                onClick={() => {
                  setQuery('')
                  folderSearchRef.current?.focus()
                }}
              >
                ×
              </button>
            )}
          </div>
          <label
            className={'switch' + (scanning ? ' disabled' : '')}
            title={
              scanning
                ? '正在扫描文件夹'
                : '字节不同但剔除空白（换行符/缩进/空行）后内容一致的文件计为“语义同”，不计入差异；切换后重新扫描'
            }
          >
            <input
              type="checkbox"
              checked={semantic}
              disabled={scanning}
              onChange={(e) => onSemanticChange(e.target.checked)}
            />
            语义判等
          </label>
          <label className="switch" title="隐藏两侧内容一致的文件（含语义同），专注差异">
            <input
              type="checkbox"
              checked={onlyDiff}
              onChange={(e) => handleOnlyDiff(e.target.checked)}
            />
            仅看差异
          </label>
          {truncated && (
            <span className="fstat warn" title="文件数量超出上限，以下仅展示部分条目">
              ⚠ 文件过多（{total}+），仅展示前 {entries.length} 项
            </span>
          )}
        </div>
      )}

      {/* 条目列表：对照模式平铺对照条目，普通模式目录树 + 虚拟滚动 */}
      <div className="folder-scroll" ref={scrollRef} onScroll={updateRange}>
        <div style={{ height: listCount * FOLDER_ROW_HEIGHT }}>
          {snapList !== null
            ? snapList.slice(range.start, range.end).map((e) => {
                // 展示条目：当前结果优先，已移除条目回退快照数据
                const display = e.current ?? e.baseline!
                const meta = STATUS_META[display.status]
                const sc = SNAP_CHANGES.find((c) => c.key === e.change)!
                // 快照含基线内容时双击进入"快照基线 vs 当前"的内容对照（App 判定 contents）
                const hasContents =
                  e.current !== null &&
                  snapshot?.contents?.[e.rel] !== undefined &&
                  (snapshot.contents[e.rel].left !== null || snapshot.contents[e.rel].right !== null)
                return (
                  <div
                    className={'folder-row ' + meta.cls}
                    key={e.rel}
                    style={{ paddingLeft: 18 }}
                    title={`${e.rel} · 快照对照：${sc.text}${e.current ? '' : '（当前已不存在，大小为快照值）'}${hasContents ? ' · 双击查看快照基线内容对照' : ''}`}
                    onDoubleClick={() => {
                      if (e.current) onOpenEntry(e.current)
                    }}
                  >
                    <span className="folder-st-icon">{meta.icon}</span>
                    <span className="folder-rel">{e.rel}</span>
                    <span className={`snap-badge snap-b-${e.change}`}>{sc.text}</span>
                    <span className="folder-size">{fmtSize(display.leftSize)}</span>
                    <span className="folder-size">{fmtSize(display.rightSize)}</span>
                  </div>
                )
              })
            : rows.slice(range.start, range.end).map((row) => {
                const n = row.node
                const indent = { paddingLeft: 18 + row.depth * TREE_INDENT }
                if (n.isDir) {
                  const collapsed = q === '' && collapsedDirs.has(n.path)
                  const meta = STATUS_META[n.agg ?? 'same']
                  return (
                    <div
                      className={`folder-row dir ${meta.cls}`}
                      key={`dir-${n.path}`}
                      title={`${n.path}/ · ${n.fileCount ?? 0} 个文件 · 双击对比此目录内的差异文件`}
                      onClick={() => toggleDir(n.path)}
                      onDoubleClick={() => {
                        // 双击前两次单击 toggle 会回到原折叠态：进入聚合对比前确保该目录展开
                        setCollapsedDirs((prev) => {
                          if (!prev.has(n.path)) return prev
                          const next = new Set(prev)
                          next.delete(n.path)
                          return next
                        })
                        onOpenDir(n.path)
                      }}
                    >
                      <span className="folder-caret">{collapsed ? '▶' : '▼'}</span>
                      <span className="folder-rel">{n.name}</span>
                      <span className={`folder-agg ${meta.cls}`}>{meta.label}</span>
                      <span className="folder-dircount">{n.fileCount ?? 0} 项</span>
                    </div>
                  )
                }
                const e = n.entry!
                const meta = STATUS_META[e.status]
                return (
                  <div
                    className={'folder-row ' + meta.cls}
                    key={e.rel}
                    style={indent}
                    title={`双击对比：${e.rel}${e.status === 'semantic-same' ? '（语义同：仅空白/换行差异）' : ''}${e.approximate ? '（超大文件，近似判定）' : ''}`}
                    onDoubleClick={() => onOpenEntry(e)}
                  >
                    <span className="folder-st-icon">{meta.icon}</span>
                    <span className="folder-rel">{n.name}</span>
                    {e.approximate && <span className="folder-approx">≈</span>}
                    <span className="folder-size">{fmtSize(e.leftSize)}</span>
                    <span className="folder-size">{fmtSize(e.rightSize)}</span>
                  </div>
                )
              })}
        </div>
        {!scanning && listCount === 0 && (
          <div className="folder-empty-note">
            {snapList !== null
              ? q !== ''
                ? `没有匹配“${q}”的条目`
                : changeFilter !== null
                  ? `没有“${SNAP_CHANGES.find((c) => c.key === changeFilter)!.text}”的条目`
                  : '与快照基线完全一致，没有任何变迁'
              : q !== ''
                ? `没有匹配“${q}”的文件`
                : entries.length === 0
                  ? '两个文件夹内都没有文件'
                  : statusFilter !== null || extFilter !== null
                    ? '当前过滤条件下没有文件'
                    : '没有差异文件（两侧内容全部一致）'}
          </div>
        )}
      </div>

      {scanning && (
        <div className="computing-overlay">
          <span className="computing-ring" />
          <span>
            正在扫描文件夹…
            {progress ? ` 已比对 ${progress.done} / ${progress.total}` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
