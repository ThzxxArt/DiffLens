import { useCallback, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { DiffOptions, DiffSummary } from '../diff/diffEngine'
import { type ReportFormat } from '../diff/report'
import { useDismiss } from '../hooks/useDismiss'

const FORMATS: { fmt: ReportFormat; label: string }[] = [
  { fmt: 'html', label: 'HTML 报告' },
  { fmt: 'txt', label: '纯文本' },
  { fmt: 'md', label: 'Markdown' },
  { fmt: 'patch', label: 'Patch 标准差异' }
]

interface ToolbarProps {
  options: DiffOptions
  onOptionsChange: (options: DiffOptions) => void
  summary: DiffSummary
  navIndex: number
  navCount: number
  onNav: (dir: 1 | -1) => void
  onExport: (fmt: ReportFormat) => void
  /** 后台差异计算中（导出不可用） */
  computing: boolean
  /** 仅看差异视图开关 */
  onlyDiff: boolean
  onOnlyDiffChange: (v: boolean) => void
  /** 交换左右两侧 */
  onSwap: () => void
  /** 点击被字符级对比包含（禁用中）的空白选项时通知（App 弹 toast 解释） */
  onOptionBlocked?: (label: string) => void
  /** 字符级对比因内容超限自动降级为行级（开关旁显示“已降级”标记） */
  charModeDowngraded?: boolean
  /** 字符级对比部分降级（部分超限组按行级，其余组仍字符级；显示“部分降级”标记） */
  charModePartial?: boolean
  /** 视图内文本搜索关键字（空串 = 未搜索） */
  searchQuery: string
  onSearchChange: (v: string) => void
  /** 当前命中序号（0 基；无命中为 0） */
  searchIndex: number
  /** 命中总数 */
  searchCount: number
  /** 命中行之间跳转（1 下一个 / -1 上一个，循环） */
  onSearchNav: (dir: 1 | -1) => void
  /** Ctrl+F 聚焦用：搜索输入框 ref（App 持有并转发到 input） */
  searchInputRef: RefObject<HTMLInputElement>
  /** Patch（unified diff）是否可从当前结果生成：判等选项污染 unchanged 行时为 false（菜单项禁用） */
  canPatch?: boolean
}

export default function Toolbar({
  options,
  onOptionsChange,
  summary,
  navIndex,
  navCount,
  onNav,
  onExport,
  computing,
  onlyDiff,
  onOnlyDiffChange,
  onSwap,
  onOptionBlocked,
  charModeDowngraded = false,
  charModePartial = false,
  searchQuery,
  onSearchChange,
  searchIndex,
  searchCount,
  onSearchNav,
  searchInputRef,
  canPatch = true
}: ToolbarProps): ReactElement {
  const set = (patch: Partial<DiffOptions>): void => onOptionsChange({ ...options, ...patch })
  const [exportOpen, setExportOpen] = useState(false)
  const exportWrapRef = useRef<HTMLDivElement>(null)
  const closeExport = useCallback((): void => setExportOpen(false), [])
  // 点击外部 / 按 Esc 关闭导出下拉
  useDismiss(exportWrapRef, closeExport)

  const canNav = navCount > 0

  // 被包含选项的 label：灰显 + 点击解释（checkbox 本身 disabled 不响应，label 捕获点击给反馈）
  const blockedLabel = (label: string): ((e: { preventDefault(): void }) => void) | undefined =>
    options.charMode
      ? (e) => {
          // 阻止 label 默认激活行为，统一走解释反馈
          e.preventDefault()
          onOptionBlocked?.(label)
        }
      : undefined

  return (
    <div className="toolbar">
      <div className="tool-group">
        <span className="tool-label">比较选项</span>
        <label
          className={'switch' + (options.charMode ? ' disabled' : '')}
          title={
            options.charMode
              ? '已被“字符级对比”包含（字符级忽略全部空白与换行）'
              : '忽略行首尾空白差异'
          }
          onClick={blockedLabel('忽略行首尾空白')}
        >
          <input
            type="checkbox"
            checked={options.charMode ? true : options.trimWhitespace}
            disabled={options.charMode}
            onChange={(e) => set({ trimWhitespace: e.target.checked })}
          />
          忽略行首尾空白
          {options.charMode && <span className="opt-badge">已包含</span>}
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={options.ignoreCase}
            onChange={(e) => set({ ignoreCase: e.target.checked })}
          />
          忽略大小写
        </label>
        <label
          className={'switch' + (options.charMode ? ' disabled' : '')}
          title={
            options.charMode
              ? '已被“字符级对比”包含（字符级忽略全部空白与换行）'
              : '忽略空行差异（两侧空白行互相判等）'
          }
          onClick={blockedLabel('忽略空行')}
        >
          <input
            type="checkbox"
            checked={options.charMode ? true : (options.ignoreBlankLines ?? false)}
            disabled={options.charMode}
            onChange={(e) => set({ ignoreBlankLines: e.target.checked })}
          />
          忽略空行
          {options.charMode && <span className="opt-badge">已包含</span>}
        </label>
        <label
          className={'switch' + (options.charMode ? ' disabled' : '')}
          title={
            options.charMode
              ? '已被“字符级对比”包含（字符级忽略全部空白与换行）'
              : '忽略行内全部空白（空格/制表符/全角空格），仅比较实际文字；换行结构仍参与对比'
          }
          onClick={blockedLabel('忽略所有空白')}
        >
          <input
            type="checkbox"
            checked={options.charMode ? true : (options.ignoreAllWhitespace ?? false)}
            disabled={options.charMode}
            onChange={(e) => set({ ignoreAllWhitespace: e.target.checked })}
          />
          忽略所有空白
          {options.charMode && <span className="opt-badge">已包含</span>}
        </label>
        <label
          className="switch"
          title="空白与换行结构全部不参与判等，差异以字符粒度定位（跨行重组也能判等）；相同内容自动锚定跳过计算，大文件不再整篇受限；变更组预算随输入规模自适应；差异过大时降级行级对比"
        >
          <input
            type="checkbox"
            checked={options.charMode ?? false}
            onChange={(e) => set({ charMode: e.target.checked })}
          />
          字符级对比
          {options.charMode && charModeDowngraded && (
            <span className="opt-badge warn" title="内容或差异过大，本次对比已自动降级为行级（忽略所有空白 + 忽略空行语义）">
              已降级
            </span>
          )}
          {options.charMode && !charModeDowngraded && charModePartial && (
            <span
              className="opt-badge warn"
              title="部分差异过大的块已按行级对比，其余差异块仍为字符级高亮"
            >
              部分降级
            </span>
          )}
        </label>
      </div>

      <div className="tool-group">
        <span className="tool-label">视图</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={onlyDiff}
            onChange={(e) => onOnlyDiffChange(e.target.checked)}
          />
          仅看差异
        </label>
        <button className="btn" onClick={onSwap} title="交换左右两侧内容">
          ⇄ 交换左右
        </button>
      </div>

      <div className="tool-group search-group">
        <div className="search-box">
          <input
            ref={searchInputRef}
            className="diff-search"
            type="text"
            value={searchQuery}
            placeholder="搜索内容… (Ctrl+F)"
            spellCheck={false}
            title="在两侧全部行内搜索（大小写不敏感）：Enter 下一个 / Shift+Enter 上一个 / Esc 清空"
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Esc 清空并交还焦点（仅当有内容时阻止默认避免冒泡副作用）
                if (searchQuery !== '') e.preventDefault()
                onSearchChange('')
                e.currentTarget.blur()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                onSearchNav(e.shiftKey ? -1 : 1)
              }
            }}
          />
          {searchQuery.trim() !== '' && (
            <button
              className="search-clear"
              title="清空搜索（Esc）"
              onClick={() => {
                onSearchChange('')
                searchInputRef.current?.focus()
              }}
            >
              ×
            </button>
          )}
        </div>
        <span className="search-count">
          {searchQuery.trim() === '' ? '' : `${searchCount > 0 ? searchIndex + 1 : 0} / ${searchCount}`}
        </span>
      </div>

      <div className="tool-group">
        <button
          className="nav-btn"
          title="上一处差异（Shift+F7）"
          disabled={!canNav}
          onClick={() => onNav(-1)}
        >
          ▲
        </button>
        <span className="nav-count">
          {navCount > 0 ? `${navIndex + 1} / ${navCount}` : '0 / 0'}
        </span>
        <button
          className="nav-btn"
          title="下一处差异（F7）"
          disabled={!canNav}
          onClick={() => onNav(1)}
        >
          ▼
        </button>
      </div>

      <div className="tool-group export-wrap" ref={exportWrapRef}>
        <button
          className="btn primary"
          disabled={computing}
          title={computing ? '正在后台计算差异' : undefined}
          onClick={() => setExportOpen((o) => !o)}
        >
          导出报告
        </button>
        {exportOpen && (
          <div className="export-menu up">
            {FORMATS.map((f) => {
              // Patch 的上下文行要求两侧文本严格一致：判等选项（忽略大小写/所有空白/
              // 字符级等）把不同文本判为相同时无法表达，禁用并解释
              const disabled = f.fmt === 'patch' && !canPatch
              return (
                <button
                  key={f.fmt}
                  className="ctx-item"
                  disabled={disabled}
                  title={
                    disabled
                      ? '当前比较选项把部分不同内容判为相同（如忽略大小写、忽略空白、字符级），Patch 无法表达；关闭相关选项后可导出'
                      : f.fmt === 'patch'
                        ? '标准 unified diff 格式（git diff 风格），可直接用于 git apply / patch'
                        : undefined
                  }
                  onClick={() => {
                    if (disabled) return
                    setExportOpen(false)
                    onExport(f.fmt)
                  }}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="header-spacer" style={{ margin: 0 }} />

      <div className="stats">
        <span className="badge add">
          <span className="dot" />+{summary.inserted}
        </span>
        <span className="badge del">
          <span className="dot" />−{summary.deleted}
        </span>
        <span className="badge mod">
          <span className="dot" />~{summary.modified}
        </span>
        {options.charMode && (
          <>
            <span
              className="badge chars"
              title="字符粒度新增统计（码点数）：新增行整行 + 修改行的新增段；超长防护行不计"
            >
              +{summary.charsAdded} 字
            </span>
            <span
              className="badge chars"
              title="字符粒度删除统计（码点数）：删除行整行 + 修改行的删除段；超长防护行不计"
            >
              −{summary.charsDeleted} 字
            </span>
          </>
        )}
      </div>
    </div>
  )
}