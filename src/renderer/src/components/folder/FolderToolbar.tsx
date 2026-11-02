import { useCallback, useRef, type ReactElement, type RefObject } from 'react'
import type { FolderSnapshot, SnapshotDiffResult } from '../../diff/snapshotDiff'
import { useDismiss } from '../../hooks/useDismiss'
import { BADGES, SNAP_CHANGES, STATUS_META } from './folderViewConfig'
import type { FolderViewState } from './useFolderViewState'

export interface FolderToolbarProps {
  view: FolderViewState
  /** Ctrl+F 聚焦用：文件名搜索输入框 ref（App 持有并转发到 input） */
  searchInputRef?: RefObject<HTMLInputElement | null>
  scanning: boolean
  semantic: boolean
  onSemanticChange: (v: boolean) => void
  onlyDiff: boolean
  truncated: boolean
  total: number
  entriesCount: number
  ignoreRules: string[]
  snapshot: FolderSnapshot | null
  snapshotDiff: SnapshotDiffResult | null
  onExitSnapshot: () => void
}

/** 文件夹工具行：对照模式渲染变迁统计，普通模式渲染状态统计 + 搜索/过滤/开关。 */
export default function FolderToolbar({
  view,
  searchInputRef,
  scanning,
  semantic,
  onSemanticChange,
  onlyDiff,
  truncated,
  total,
  entriesCount,
  ignoreRules,
  snapshot,
  snapshotDiff,
  onExitSnapshot
}: FolderToolbarProps): ReactElement {
  const {
    query,
    setQuery,
    statusFilter,
    extFilter,
    setExtFilter,
    extOpen,
    setExtOpen,
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
    snapList,
    filteredCount,
    handleOnlyDiff,
    handleBadge,
    handleExtToggle,
    handleSnapBadge
  } = view

  // 内部搜索框 ref（清空按钮点击后聚焦用；外部传入 searchInputRef 时共用同一个）
  const innerSearchRef = useRef<HTMLInputElement>(null)
  const folderSearchRef = searchInputRef ?? innerSearchRef

  // 扩展名/忽略规则下拉（点击外部 / Esc 关闭）
  const extWrapRef = useRef<HTMLDivElement>(null)
  const ignoreWrapRef = useRef<HTMLDivElement>(null)
  const closeExt = useCallback((): void => setExtOpen(false), [setExtOpen])
  const closeIgnore = useCallback((): void => setIgnoreOpen(false), [setIgnoreOpen])
  useDismiss(extWrapRef, closeExt)
  useDismiss(ignoreWrapRef, closeIgnore)

  return snapshotDiff !== null && snapshot !== null ? (
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
          共{' '}
          {snapList !== null
            ? `${snapList.length} / ${snapshotDiff.entries.length}`
            : snapshotDiff.entries.length}{' '}
          项
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
          共{' '}
          {extFilter !== null || statusFilter !== null
            ? `${filteredCount} / ${entriesCount}`
            : entriesCount}{' '}
          项
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
                  title={
                    on
                      ? `点击取消“${ext === '' ? '无扩展名' : '.' + ext}”过滤`
                      : `点击只看“${ext === '' ? '无扩展名' : '.' + ext}”的文件`
                  }
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
          ⚠ 文件过多（{total}+），仅展示前 {entriesCount} 项
        </span>
      )}
    </div>
  )
}
