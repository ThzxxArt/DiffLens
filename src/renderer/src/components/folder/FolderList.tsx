import type { ReactElement, RefObject } from 'react'
import type { FolderEntry } from '../../../../preload/index'
import { fmtSize } from '../../diff/folderReport'
import type { FolderSnapshot } from '../../diff/snapshotDiff'
import { FOLDER_ROW_HEIGHT, SNAP_CHANGES, STATUS_META, TREE_INDENT } from './folderViewConfig'
import type { FolderViewState } from './useFolderViewState'

export interface FolderListProps {
  view: FolderViewState
  scrollRef: RefObject<HTMLDivElement | null>
  range: { start: number; end: number }
  updateRange: () => void
  listCount: number
  scanning: boolean
  progress?: { done: number; total: number } | null
  snapshot: FolderSnapshot | null
  entriesCount: number
  onOpenEntry: (entry: FolderEntry) => void
  onOpenDir: (dirPath: string) => void
}

/** 文件夹条目列表：对照模式平铺变迁条目，普通模式目录树 + 虚拟滚动。 */
export default function FolderList({
  view,
  scrollRef,
  range,
  updateRange,
  listCount,
  scanning,
  progress,
  snapshot,
  entriesCount,
  onOpenEntry,
  onOpenDir
}: FolderListProps): ReactElement {
  const {
    snapList,
    rows,
    q,
    collapsedDirs,
    setCollapsedDirs,
    toggleDir,
    changeFilter,
    statusFilter,
    extFilter
  } = view

  return (
    <>
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
                  (snapshot.contents[e.rel].left !== null ||
                    snapshot.contents[e.rel].right !== null)
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
                : entriesCount === 0
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
    </>
  )
}
