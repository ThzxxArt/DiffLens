import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FolderEntry, FolderEntryStatus } from '../../../../preload/index'
import { compileIgnoreRules, IGNORE_RULES_MAX } from '../../../../shared/ignoreRules'
import { countFolderStats } from '../../diff/folderReport'
import type { FolderSnapshot, SnapshotChange, SnapshotDiffResult } from '../../diff/snapshotDiff'
import { buildFolderTree, filterEntries, flattenFolderTree, relExt } from '../folderTree'

export interface UseFolderViewStateOptions {
  leftDir: string
  rightDir: string
  entries: FolderEntry[]
  snapshot: FolderSnapshot | null
  snapshotDiff: SnapshotDiffResult | null
  onlyDiff: boolean
  onOnlyDiffChange: (v: boolean) => void
  onIgnoreRulesChange: (rules: string[]) => void
}

/**
 * 文件夹视图的本地过滤状态：搜索、状态/扩展名/变迁过滤、折叠集合、忽略规则草稿，
 * 以及由这些状态派生出的统计、树形行集与对照条目集。
 */
export function useFolderViewState({
  leftDir,
  rightDir,
  entries,
  snapshot,
  snapshotDiff,
  onlyDiff,
  onOnlyDiffChange,
  onIgnoreRulesChange
}: UseFolderViewStateOptions) {
  // 搜索（相对路径子串，不区分大小写；对照模式同样生效）
  const [query, setQuery] = useState('')
  // 状态精确过滤（null = 不过滤；与 onlyDiff 互斥）
  const [statusFilter, setStatusFilter] = useState<Set<FolderEntryStatus> | null>(null)
  // 扩展名精确过滤（null = 不过滤；与其他过滤条件取交集）
  const [extFilter, setExtFilter] = useState<Set<string> | null>(null)
  // 扩展名下拉（点击外部 / Esc 关闭）
  const [extOpen, setExtOpen] = useState(false)
  // 折叠的目录集合（默认全展开；空集合 = 全部展开）
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  // 忽略规则下拉（草稿文本域；打开时以当前规则初始化，应用时解析为规则数组并触发重扫）
  const [ignoreOpen, setIgnoreOpen] = useState(false)
  const [ignoreDraft, setIgnoreDraft] = useState('')

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
    const isExpanded = (dirPath: string): boolean => (q !== '' ? true : !collapsedDirs.has(dirPath))
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

  return {
    query,
    setQuery,
    q: query.trim(),
    statusFilter,
    extFilter,
    setExtFilter,
    extOpen,
    setExtOpen,
    collapsedDirs,
    setCollapsedDirs,
    toggleDir,
    ignoreOpen,
    setIgnoreOpen,
    ignoreDraft,
    setIgnoreDraft,
    ignoreInvalid,
    applyIgnoreDraft,
    clearIgnore,
    changeFilter,
    stats,
    extStats,
    rows,
    snapList,
    filteredCount,
    handleOnlyDiff,
    handleBadge,
    handleExtToggle,
    handleSnapBadge,
    snapshot
  }
}

export type FolderViewState = ReturnType<typeof useFolderViewState>
