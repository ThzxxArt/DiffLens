import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type RefObject,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { DiffRow, SideCell } from '../diff/diffEngine'
import { displayCols } from '../diff/textUtils'

export interface PaneMeta {
  name: string
  encoding: string
}

/** 虚拟行高（px）。与 global.css 的 --line-height: 21px 保持一致，改动需双向同步 */
export const ROW_HEIGHT = 21
/** 窗口上下各多渲染的缓冲行数 */
const OVERSCAN = 8
/** 视口高度兜底值（jsdom 无布局，clientHeight 为 0 时使用） */
const FALLBACK_VIEWPORT = 600
/** 内容最小宽度 = 列宽 × 字符宽 + 行号列与内边距的固定开销 */
const CONTENT_WIDTH_PAD = 86

/** “仅看差异”视图中的折叠提示行（占用一个虚拟行位，高度与其他行一致） */
export interface FoldMarker {
  fold: true
  /** 被折叠的未更改行数 */
  skipped: number
  /** 自定义提示文案（如“完全一致”场景） */
  note?: string
}

export type DisplayItem = DiffRow | FoldMarker

export const isFold = (item: DisplayItem): item is FoldMarker => 'fold' in item

interface DiffViewProps {
  items: DisplayItem[]
  leftMeta: PaneMeta | null
  rightMeta: PaneMeta | null
  activeRowId: string | null
  /** 视图内文本搜索（大小写不敏感，非空时行内命中子串高亮） */
  searchQuery?: string
  onOpen: (side: 'left' | 'right') => void
  onRowContext: (e: ReactMouseEvent, side: 'left' | 'right', cell: SideCell) => void
  onDropFile: (side: 'left' | 'right', files: File[]) => void
}

/** 把行尾空白用淡色高亮显示，便于识别被忽略/忽略差异 */
function renderWithWs(text: string): ReactNode[] {
  const m = /(\s+)$/.exec(text)
  if (!m || m[1].length === 0) return [text]
  const body = text.slice(0, text.length - m[1].length)
  return [
    body,
    <span className="ws" key="ws">
      {m[1]}
    </span>
  ]
}

/** 搜索命中子串包裹高亮 span（大小写不敏感，多处命中全部拆分）；无命中返回原文本单节点 */
function renderWithHits(text: string, query: string): ReactNode[] {
  if (query === '') return [text]
  const lower = text.toLowerCase()
  const lq = query.toLowerCase()
  const out: ReactNode[] = []
  let from = 0
  let i = lower.indexOf(lq)
  let key = 0
  while (i >= 0) {
    if (i > from) out.push(text.slice(from, i))
    out.push(
      <span className="search-hit" key={`hit-${key++}`}>
        {text.slice(i, i + query.length)}
      </span>
    )
    from = i + query.length
    i = lower.indexOf(lq, from)
  }
  if (out.length === 0) return [text]
  if (from < text.length) out.push(text.slice(from))
  return out
}

function renderCellText(cell: SideCell, query: string): ReactNode {
  if (cell.segs) {
    return cell.segs.map((s, i) => (
      <span key={i} className={'seg seg-' + s.kind}>
        {query !== '' ? renderWithHits(s.text, query) : s.text}
      </span>
    ))
  }
  if (cell.text === null) {
    return <span className="plain-empty">&#8203;</span>
  }
  // 搜索激活时命中高亮优先（行尾空白标注与命中拆分不叠加，避免嵌套冲突）
  const body = query !== '' ? renderWithHits(cell.text, query) : renderWithWs(cell.text)
  return <span className="plain">{body}</span>
}

function SidePanel({
  items,
  side,
  meta,
  onOpen,
  onRowContext,
  onDropFile,
  scrollRef,
  onScroll,
  activeRowId,
  minWidth,
  searchQuery
}: {
  items: DisplayItem[]
  side: 'left' | 'right'
  meta: PaneMeta | null
  onOpen: (side: 'left' | 'right') => void
  onRowContext: (e: ReactMouseEvent, side: 'left' | 'right', cell: SideCell) => void
  onDropFile: (side: 'left' | 'right', files: File[]) => void
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  activeRowId: string | null
  minWidth: number | undefined
  searchQuery: string
}): ReactElement {
  // 当前渲染窗口 [start, end)，随滚动位置按固定行高换算
  const [range, setRange] = useState({ start: 0, end: 0 })

  const updateRange = (): void => {
    const el = scrollRef.current
    if (!el) return
    const vh = el.clientHeight || FALLBACK_VIEWPORT
    const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(items.length, Math.ceil((el.scrollTop + vh) / ROW_HEIGHT) + OVERSCAN)
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }

  // 挂载与行集变化时重算窗口；行数未变时窗口按索引自然刷新
  useLayoutEffect(() => {
    updateRange()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // 窗口尺寸变化时补齐窗口
  useEffect(() => {
    const onResize = (): void => updateRange()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  const handleScroll = (): void => {
    updateRange()
    onScroll()
  }

  return (
    <div
      className={'pane pane-mid pane-' + side}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) onDropFile(side, files)
      }}
    >
      <div className="panel-head">
        <span className={'pane-dot ' + side} />
        <span className="pane-file">{meta ? meta.name : '（未选择）'}</span>
        {meta && <span className="pane-meta">{meta.encoding}</span>}
        <span className="pane-actions">
          <button className="btn" onClick={() => onOpen(side)}>
            {meta ? '重新选择' : '打开文件'}
          </button>
        </span>
      </div>
      <div className="diff-scroll" ref={scrollRef} onScroll={handleScroll}>
        {/* 总高度撑满全部行 + paddingTop 平移到窗口起点，仅渲染可见切片 */}
        <div
          className="diff-columns"
          style={{
            height: items.length * ROW_HEIGHT,
            minWidth,
            paddingTop: range.start * ROW_HEIGHT
          }}
        >
          {items.slice(range.start, range.end).map((item, i) => {
            const idx = range.start + i
            if (isFold(item)) {
              return (
                <div className="diff-row fold" key={'fold-' + idx}>
                  <span className={'ln ' + side} />
                  <span className="tx fold-note">
                    {item.note ?? `⋯ 已折叠 ${item.skipped} 行相同内容 ⋯`}
                  </span>
                </div>
              )
            }
            const row = item
            const cell = side === 'left' ? row.left : row.right
            const cls =
              'diff-row ' +
              row.rowKind +
              (activeRowId === row.id ? ' active' : '') +
              (side === 'left' && row.rowKind === 'added' ? ' base' : '')
            return (
              <div className={cls} data-row={row.id} key={row.id + '-' + side}>
                <span className={'ln ' + side}>{cell.lineNo ?? ''}</span>
                <span className="tx" onContextMenu={(e) => onRowContext(e, side, cell)}>
                  {renderCellText(cell, searchQuery)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function DiffView({
  items,
  leftMeta,
  rightMeta,
  activeRowId,
  searchQuery,
  onOpen,
  onRowContext,
  onDropFile
}: DiffViewProps): ReactElement {
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  // 等宽字符宽度探针：首帧实测一次，用于虚拟化下预计算内容最小宽度
  const probeRef = useRef<HTMLSpanElement>(null)
  const [charW, setCharW] = useState(0)
  useLayoutEffect(() => {
    const w = probeRef.current?.getBoundingClientRect().width ?? 0
    if (w > 0) setCharW(w / 10)
  }, [])

  /** 列宽计算封顶：超长行（base64/压缩产物可达数 MB 单行）达到上限即停，避免逐字符全量遍历；与词级防护阈值同源 */
  const MAX_COLS_CAP = 5000
  const colsOf = (rows: DisplayItem[], pick: (r: DiffRow) => SideCell): number => {
    let max = 40
    for (const it of rows) {
      if (isFold(it)) continue
      const t = pick(it).text
      if (t) {
        const c = displayCols(t, MAX_COLS_CAP)
        if (c > max) max = c
      }
    }
    return max
  }
  const leftCols = useMemo(() => colsOf(items, (r) => r.left), [items])
  const rightCols = useMemo(() => colsOf(items, (r) => r.right), [items])
  // 探针未测得（jsdom/首帧）时不设 minWidth，退回 CSS min-width: max-content
  const leftMinW = charW > 0 ? leftCols * charW + CONTENT_WIDTH_PAD : undefined
  const rightMinW = charW > 0 ? rightCols * charW + CONTENT_WIDTH_PAD : undefined

  // 双向滚动同步（差值判断，无锁）：一侧滚动后仅在两侧位置差超过 1px 时回写对侧；
  // 回写触发的对侧 scroll 事件因差值归零自然终止，不依赖 rAF 时序假设，快速滚动不丢帧
  const makeScrollSync = (target: 'left' | 'right') => (): void => {
    const src = target === 'left' ? leftRef.current : rightRef.current
    const dst = target === 'left' ? rightRef.current : leftRef.current
    if (!src || !dst) return
    if (Math.abs(dst.scrollTop - src.scrollTop) > 1) dst.scrollTop = src.scrollTop
    if (Math.abs(dst.scrollLeft - src.scrollLeft) > 1) dst.scrollLeft = src.scrollLeft
  }

  // 差异导航定位：目标行换算为受控 scrollTop（虚拟化下行可能未渲染，scrollIntoView 不可用）
  useEffect(() => {
    if (!activeRowId) return
    const idx = items.findIndex((it) => !isFold(it) && it.id === activeRowId)
    if (idx < 0) return
    const vh = leftRef.current?.clientHeight || FALLBACK_VIEWPORT
    const maxScroll = Math.max(0, items.length * ROW_HEIGHT - vh)
    const target = Math.min(
      Math.max(idx * ROW_HEIGHT - Math.floor(vh / 2) + Math.floor(ROW_HEIGHT / 2), 0),
      maxScroll
    )
    leftRef.current?.scrollTo({ top: target })
    rightRef.current?.scrollTo({ top: target })
  }, [activeRowId, items])

  return (
    <div className="diff-view">
      <span className="width-probe" ref={probeRef} aria-hidden="true">
        0000000000
      </span>
      <div className="diff-main">
        <SidePanel
          items={items}
          side="left"
          meta={leftMeta}
          onOpen={onOpen}
          onRowContext={onRowContext}
          onDropFile={onDropFile}
          scrollRef={leftRef}
          onScroll={makeScrollSync('left')}
          activeRowId={activeRowId}
          minWidth={leftMinW}
          searchQuery={searchQuery ?? ''}
        />
        <SidePanel
          items={items}
          side="right"
          meta={rightMeta}
          onOpen={onOpen}
          onRowContext={onRowContext}
          onDropFile={onDropFile}
          scrollRef={rightRef}
          onScroll={makeScrollSync('right')}
          activeRowId={activeRowId}
          minWidth={rightMinW}
          searchQuery={searchQuery ?? ''}
        />
      </div>
    </div>
  )
}
