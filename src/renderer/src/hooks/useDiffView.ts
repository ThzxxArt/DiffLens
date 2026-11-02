import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { EMPTY_SUMMARY } from '../app/constants'
import type { PaneState } from '../app/types'
import {
  type DiffOptions,
  type DiffResult,
  type DiffRow,
  type DiffSummary
} from '../diff/diffEngine'
import { type DisplayItem, type FoldMarker, isFold } from '../components/diffViewModel'
import { countLines } from '../diff/textUtils'
import { canBuildPatch } from '../diff/report'
import { useDiff } from './useDiff'
import type { ShowToast } from './useToast'

/**
 * 单文件对比视图：diff 计算、仅看差异行集、视图内搜索、差异导航与统计。
 * 不包含 DOM 事件绑定（Ctrl+F / F7 / Alt+方向键由 App 统一编排）。
 */
export function useDiffView({
  paneL,
  paneR,
  options,
  onlyDiff,
  showToast
}: {
  paneL: PaneState | null
  paneR: PaneState | null
  options: DiffOptions
  onlyDiff: boolean
  showToast: ShowToast
}): {
  diff: DiffResult | null
  computing: boolean
  rows: DiffRow[]
  changedRows: DiffRow[]
  summary: DiffSummary
  displayRows: DisplayItem[]
  searchQuery: string
  setSearchQuery: Dispatch<SetStateAction<string>>
  searchIndex: number
  searchHits: DiffRow[]
  activeRowId: string | null
  navIndex: number
  go: (dir: 1 | -1) => void
  goSearch: (dir: 1 | -1) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  leftLines: number
  rightLines: number
  canPatch: boolean
} {
  // diff 计算已 worker 化：大输入后台计算（computing 期间 diff 为 null），小输入同步快路径
  const { diff, computing } = useDiff(paneL?.text ?? '', paneR?.text ?? '', options)

  // 字符级对比因内容超限或差异过大自动降级为行级时提示（依赖 diff 对象，同一结果只提示一次）；
  // 部分降级（部分超限组行级配对、其余组仍字符级）单独提示
  useEffect(() => {
    if (diff?.charModeDowngraded) {
      showToast('内容或差异过大，字符级对比已自动降级为行级对比')
    } else if (diff?.charModePartial) {
      showToast('部分差异块过大已按行级对比，其余差异仍为字符级高亮')
    }
  }, [diff, showToast])

  const rows = useMemo(() => diff?.rows ?? [], [diff])
  const changedRows = useMemo(() => rows.filter((r) => r.isChanged), [rows])
  const summary: DiffSummary = diff?.summary ?? EMPTY_SUMMARY

  // “仅看差异”视图行集：过滤未更改行，在连续省略处插入折叠提示行（占一个虚拟行位）
  const displayRows = useMemo(() => {
    if (!onlyDiff) return rows as DisplayItem[]
    if (rows.length === 0) return [] as DisplayItem[]
    if (changedRows.length === 0) {
      const m: FoldMarker = {
        fold: true,
        skipped: rows.length,
        note: '两文件内容完全一致，已折叠全部未更改行'
      }
      return [m]
    }
    const out: DisplayItem[] = []
    let skipped = 0
    for (const r of rows) {
      if (r.isChanged) {
        if (skipped > 0) {
          out.push({ fold: true, skipped })
          skipped = 0
        }
        out.push(r)
      } else {
        skipped++
      }
    }
    if (skipped > 0) out.push({ fold: true, skipped })
    return out
  }, [rows, onlyDiff, changedRows.length])

  // ===== 视图内文本搜索 =====
  // 命中行集（大小写不敏感，两侧任一命中即算；含未更改行，与“仅看差异”独立——
  // rows 为全量行，5 万行线性扫描毫秒级，无需 worker）
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const searchHits = useMemo<DiffRow[]>(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q === '') return []
    return rows.filter(
      (r) =>
        (r.left.text !== null && r.left.text.toLowerCase().includes(q)) ||
        (r.right.text !== null && r.right.text.toLowerCase().includes(q))
    )
  }, [rows, searchQuery])

  const searchInputRef = useRef<HTMLInputElement>(null)
  const [activeRowId, setActiveRowId] = useState<string | null>(null)
  const [navIndex, setNavIndex] = useState(0)

  // 关键字变化：命中序号归零并定位到第一个命中行（GitHub 风格即时反馈）；
  // 仅依赖 searchQuery（rows 变化触发的 hits 重算不抢跳，由下方 clamp 兜底）
  useEffect(() => {
    setSearchIndex(0)
    if (searchQuery.trim() !== '' && searchHits.length > 0) setActiveRowId(searchHits[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  // diff 重算（切选项/交换/新文件）导致命中集变化：序号钳制回有效范围；
  // 搜索仍激活但命中归零时同步清空 active 高亮（React 19 effect 时序变化暴露的回归锚）
  useEffect(() => {
    setSearchIndex((i) => Math.min(i, Math.max(0, searchHits.length - 1)))
    if (searchQuery.trim() !== '' && searchHits.length === 0) setActiveRowId(null)
  }, [searchHits, searchQuery])

  // 搜索激活但命中归零时，active 行不应继续高亮（状态清空 effect 之外的渲染态兜底；
  // React 19 下 effect 在 paint 后执行，避免一帧残留旧高亮）
  const effectiveActiveRowId =
    searchQuery.trim() !== '' && searchHits.length === 0 ? null : activeRowId

  /** 命中行之间循环跳转（Enter / Shift+Enter）；目标行被“仅看差异”折叠时提示且不推进 */
  const goSearch = useCallback(
    (dir: 1 | -1): void => {
      const len = searchHits.length
      if (len === 0) return
      let ni = searchIndex + dir
      if (ni >= len) ni = 0
      if (ni < 0) ni = len - 1
      const hit = searchHits[ni]
      if (!displayRows.some((it) => !isFold(it) && it.id === hit.id)) {
        showToast('命中行位于“仅看差异”折叠段内，关闭该开关后可定位')
        return
      }
      setSearchIndex(ni)
      setActiveRowId(hit.id)
    },
    [searchHits, searchIndex, displayRows, showToast]
  )

  const leftLines = useMemo(() => (paneL ? countLines(paneL.text) : 0), [paneL])
  const rightLines = useMemo(() => (paneR ? countLines(paneR.text) : 0), [paneR])

  // Patch（unified diff）可导出性：判等类选项把两侧不同文本判为 unchanged 时不可表达
  const canPatch = useMemo(() => canBuildPatch(rows), [rows])

  // diff 内容或视图选项变化时重置导航；搜索激活时 active 行同步定位到钳制后的
  // 当前命中行——rows 重建后行 id 全部重新编号（r{index}），旧 activeRowId 不再
  // 命中任何行，搜索计数（由 clamp 钳制保持）与行高亮会脱节直到下次 Enter；
  // 无命中时清空高亮。searchHits/searchIndex 有意不列入依赖：关键字变化路径由
  // 上方 effect 负责重置定位（首个命中行），若因 hits 变化触发会按旧序号定位，
  // 覆盖正确的首个命中定位。
  useEffect(() => {
    setNavIndex(0)
    const ni = Math.min(searchIndex, Math.max(0, searchHits.length - 1))
    setActiveRowId(searchHits.length > 0 ? searchHits[ni].id : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneL, paneR, options, onlyDiff])

  const go = useCallback(
    (dir: 1 | -1) => {
      const len = changedRows.length
      if (len === 0) return
      let ni = navIndex + dir
      if (ni >= len) ni = 0
      if (ni < 0) ni = len - 1
      setNavIndex(ni)
      setActiveRowId(changedRows[ni].id)
    },
    [changedRows, navIndex]
  )

  return {
    diff,
    computing,
    rows,
    changedRows,
    summary,
    displayRows,
    searchQuery,
    setSearchQuery,
    searchIndex,
    searchHits,
    activeRowId: effectiveActiveRowId,
    navIndex,
    go,
    goSearch,
    searchInputRef,
    leftLines,
    rightLines,
    canPatch
  }
}
