import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import type { SideCell } from './diff/diffEngine'
import DiffView from './components/DiffView'
import Toolbar from './components/Toolbar'
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu'
import TextInputModal from './components/TextInputModal'
import FolderView from './components/FolderView'
import AboutModal from './components/AboutModal'
import LogoIcon from './components/LogoIcon'
import EmptyPane from './components/EmptyPane'
import { useDismiss } from './hooks/useDismiss'
import { usePreferences } from './hooks/usePreferences'
import { useToast } from './hooks/useToast'
import { useFilePanes } from './hooks/useFilePanes'
import { useDiffView } from './hooks/useDiffView'
import { useFolderComparison } from './hooks/useFolderComparison'
import { useReportExport } from './hooks/useReportExport'
import { useFolderViewState } from './components/folder/useFolderViewState'
import type { FolderEntry } from '../../preload/index'

/** 无文件夹会话时的稳定空条目（避免每次 render 生成新数组触发无意义派生计算） */
const EMPTY_FOLDER_ENTRIES: FolderEntry[] = []

export default function App(): ReactElement {
  const {
    options,
    setOptions,
    onlyDiff,
    setOnlyDiff,
    folderOnlyDiff,
    setFolderOnlyDiff,
    folderSemantic,
    setFolderSemantic,
    folderIgnoreRules,
    setFolderIgnoreRules
  } = usePreferences()
  const { toasts, showToast, dismissToast } = useToast()
  const {
    paneL,
    paneR,
    setPaneL,
    setPaneR,
    clearPanes,
    openPane,
    dropPane,
    applyFileData,
    applyManualText,
    swapPanes,
    handleClear,
    anyPane
  } = useFilePanes({ showToast })
  const [appVersion, setAppVersion] = useState('')
  const {
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
    activeRowId,
    navIndex,
    go,
    goSearch,
    searchInputRef,
    leftLines,
    rightLines,
    canPatch
  } = useDiffView({ paneL, paneR, options, onlyDiff, showToast })
  const {
    mode,
    folderState,
    folderScanning,
    scanProgress,
    snapshotSaving,
    snapshotProgress,
    folderEntryCursor,
    folderNavScope,
    snapshot,
    snapshotDiff,
    runFolderScan,
    startFolderCompare,
    handleSemanticChange,
    handleIgnoreRulesChange,
    exportFolderReport,
    saveSnapshot,
    loadSnapshot,
    exitSnapshot,
    openFolderEntry,
    diffFileEntries,
    openDirScope,
    goDiffFile,
    cursorIdx,
    backToFolder,
    exitFolder
  } = useFolderComparison({
    showToast,
    setPaneL,
    setPaneR,
    clearPanes,
    applyFileData,
    folderSemantic,
    setFolderSemantic,
    folderIgnoreRules,
    setFolderIgnoreRules,
    appVersion
  })
  // 文件夹视图状态提升到 App：从文件夹进入单文件对比再返回时，搜索/过滤/折叠不丢失；
  // 目录对变化时 useFolderViewState 内部会自动重置（退出文件夹时 leftDir/rightDir 变为空串）
  const folderView = useFolderViewState({
    leftDir: folderState?.leftDir ?? '',
    rightDir: folderState?.rightDir ?? '',
    entries: folderState?.entries ?? EMPTY_FOLDER_ENTRIES,
    snapshot,
    snapshotDiff,
    onlyDiff: folderOnlyDiff,
    onOnlyDiffChange: setFolderOnlyDiff,
    onIgnoreRulesChange: handleIgnoreRulesChange
  })
  const exportReport = useReportExport({
    diff,
    rows,
    paneL,
    paneR,
    summary,
    options,
    showToast,
    canPatch,
    appVersion,
    leftLines,
    rightLines,
    snapshot
  })

  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [pasteSide, setPasteSide] = useState<'left' | 'right' | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const pasteWrapRef = useRef<HTMLDivElement>(null)
  const folderSearchRef = useRef<HTMLInputElement>(null)
  const closePaste = useCallback((): void => setPasteOpen(false), [])
  // 点击外部 / 按 Esc 关闭粘贴下拉
  useDismiss(pasteWrapRef, closePaste)

  // 挂载时获取应用版本号（关于弹框展示；失败静默显示占位）
  useEffect(() => {
    let alive = true
    window.api
      .getVersion()
      .then((v) => {
        if (alive && typeof v === 'string') setAppVersion(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Ctrl+F 聚焦搜索框（跨模式一致：单文件聚焦内容搜索，文件夹聚焦文件名搜索；
  // 粘贴弹窗/右键菜单打开时不抢占焦点）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return
      if (pasteSide !== null || menu !== null || aboutOpen) return
      e.preventDefault()
      const target = mode === 'folder' ? folderSearchRef.current : searchInputRef.current
      target?.focus()
      target?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, pasteSide, menu, aboutOpen, searchInputRef])

  // 差异导航快捷键：F7 下一处 / Shift+F7 上一处；粘贴弹窗或右键菜单打开时不抢占
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F7') return
      if (mode !== 'file' || pasteSide !== null || menu !== null || aboutOpen) return
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, go, pasteSide, menu, aboutOpen])

  // 差异文件导航快捷键：Alt+↓ 下一个 / Alt+↑ 上一个（仅从文件夹进入的单文件对比可用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
      if (pasteSide !== null || menu !== null || aboutOpen || folderEntryCursor === null) return
      e.preventDefault()
      goDiffFile(e.key === 'ArrowDown' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goDiffFile, pasteSide, menu, aboutOpen, folderEntryCursor])

  // 行级右键菜单
  const onRowContext = useCallback(
    (e: ReactMouseEvent, side: 'left' | 'right', cell: SideCell) => {
      e.preventDefault()
      const pane = side === 'left' ? paneL : paneR
      const sideName = side === 'left' ? '左侧' : '右侧'
      const items: ContextMenuItem[] = [
        {
          label: `复制${sideName}此行内容`,
          action: () => void window.api.setClipboard(cell.text ?? '')
        },
        {
          label: '复制文件名',
          action: () => void window.api.setClipboard(pane?.meta.name ?? '')
        },
        {
          label: '在文件夹中显示',
          disabled: !pane?.path,
          action: () => {
            if (pane?.path) void window.api.showInFolder(pane.path)
          }
        }
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [paneL, paneR]
  )

  const confirmPaste = useCallback(
    (side: 'left' | 'right', text: string) => {
      if (applyManualText(side, text)) setPasteSide(null)
    },
    [applyManualText]
  )

  const leftMeta = paneL?.meta ?? null
  const rightMeta = paneR?.meta ?? null

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <div className="logo-mark">
            <LogoIcon />
          </div>
          <div>
            <span className="logo-title">DiffLens</span>
            <span className="logo-sub">TEXT DIFF</span>
          </div>
        </div>
        <div className="header-spacer" />
        {mode === 'file' && (
          <>
            {folderState && (
              <button
                className="btn ghost"
                onClick={backToFolder}
                title="返回文件夹列表（扫描结果保留）"
              >
                ← 返回文件夹对比
              </button>
            )}
            {folderState && cursorIdx >= 0 && (
              <div
                className="tool-group diff-file-nav"
                title={
                  folderNavScope !== null
                    ? `在目录「${folderNavScope}/」的差异文件之间跳转（Alt+↓ / Alt+↑）；双击任意文件条目回到全局序列`
                    : '在文件夹的差异文件之间跳转（Alt+↓ / Alt+↑）'
                }
              >
                <button
                  className="nav-btn"
                  title="上一个差异文件（Alt+↑）"
                  disabled={cursorIdx <= 0}
                  onClick={() => goDiffFile(-1)}
                >
                  ▲
                </button>
                <span className="nav-count">{`${cursorIdx + 1} / ${diffFileEntries.length}`}</span>
                <button
                  className="nav-btn"
                  title="下一个差异文件（Alt+↓）"
                  disabled={cursorIdx >= diffFileEntries.length - 1}
                  onClick={() => goDiffFile(1)}
                >
                  ▼
                </button>
                <span className="diff-file-label">
                  差异文件{folderNavScope !== null ? ` · ${folderNavScope}/` : ''}
                </span>
              </div>
            )}
            <button className="btn ghost" onClick={() => void openPane('left')}>
              打开左侧
            </button>
            <button className="btn ghost" onClick={() => void openPane('right')}>
              打开右侧
            </button>
          </>
        )}
        {mode === 'file' && (
          <div className="tool-group export-wrap" ref={pasteWrapRef}>
            <button className="btn ghost" onClick={() => setPasteOpen((o) => !o)}>
              粘贴文本
            </button>
            {pasteOpen && (
              <div className="export-menu">
                <button
                  className="ctx-item"
                  onClick={() => {
                    setPasteOpen(false)
                    setPasteSide('left')
                  }}
                >
                  粘贴到左侧
                </button>
                <button
                  className="ctx-item"
                  onClick={() => {
                    setPasteOpen(false)
                    setPasteSide('right')
                  }}
                >
                  粘贴到右侧
                </button>
              </div>
            )}
          </div>
        )}
        {mode === 'file' && (
          <>
            <button className="btn ghost" onClick={handleClear}>
              清空
            </button>
            <button
              className="btn ghost"
              onClick={() => void startFolderCompare()}
              title="选择两个文件夹，对比全部文件差异"
            >
              对比文件夹
            </button>
          </>
        )}
        <button
          className="btn ghost about-btn"
          title="关于 DiffLens"
          onClick={() => setAboutOpen(true)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="12" cy="7.6" r="1.35" fill="currentColor" />
            <line
              x1="12"
              y1="10.6"
              x2="12"
              y2="17"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {mode === 'folder' && folderState ? (
        <FolderView
          view={folderView}
          leftDir={folderState.leftDir}
          rightDir={folderState.rightDir}
          entries={folderState.entries}
          truncated={folderState.truncated}
          total={folderState.total}
          scanning={folderScanning}
          saving={snapshotSaving}
          searchInputRef={folderSearchRef}
          progress={scanProgress}
          onlyDiff={folderOnlyDiff}
          onOnlyDiffChange={setFolderOnlyDiff}
          semantic={folderSemantic}
          onSemanticChange={handleSemanticChange}
          ignoreRules={folderIgnoreRules}
          onIgnoreRulesChange={handleIgnoreRulesChange}
          snapshot={snapshot}
          snapshotDiff={snapshotDiff}
          onSaveSnapshot={saveSnapshot}
          onLoadSnapshot={loadSnapshot}
          onExitSnapshot={exitSnapshot}
          onReopen={() => void startFolderCompare()}
          onRescan={() => {
            if (folderState)
              void runFolderScan(
                folderState.leftDir,
                folderState.rightDir,
                folderSemantic,
                folderIgnoreRules
              )
          }}
          onExit={exitFolder}
          onExport={(fmt) => void exportFolderReport(fmt)}
          onOpenEntry={(e) => void openFolderEntry(e)}
          onOpenDir={openDirScope}
        />
      ) : anyPane ? (
        <>
          <DiffView
            items={displayRows}
            leftMeta={leftMeta}
            rightMeta={rightMeta}
            activeRowId={activeRowId}
            searchQuery={searchQuery.trim()}
            onOpen={(s) => void openPane(s)}
            onRowContext={onRowContext}
            onDropFile={(s, f) => void dropPane(s, f)}
          />
          <Toolbar
            options={options}
            onOptionsChange={setOptions}
            summary={summary}
            navIndex={navIndex}
            navCount={changedRows.length}
            onNav={go}
            onExport={(fmt) => void exportReport(fmt)}
            computing={computing}
            onlyDiff={onlyDiff}
            onOnlyDiffChange={setOnlyDiff}
            onSwap={swapPanes}
            onOptionBlocked={(label) =>
              showToast(`「${label}」已包含在字符级对比中，关闭字符级后可单独设置`)
            }
            charModeDowngraded={diff?.charModeDowngraded ?? false}
            charModePartial={diff?.charModePartial ?? false}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchIndex={searchIndex}
            searchCount={searchHits.length}
            onSearchNav={goSearch}
            searchInputRef={searchInputRef}
            canPatch={canPatch}
          />
        </>
      ) : (
        <div className="diff-main">
          <EmptyPane
            side="left"
            onOpen={(s) => void openPane(s)}
            onDrop={(s, f) => void dropPane(s, f)}
          />
          <EmptyPane
            side="right"
            onOpen={(s) => void openPane(s)}
            onDrop={(s, f) => void dropPane(s, f)}
          />
        </div>
      )}

      <footer className="status-bar">
        {mode === 'folder' ? (
          <>
            <div className="status-left">
              <span className="status-item">文件夹对比 · 双击条目进入单文件对比</span>
            </div>
            <div className="status-spacer" />
          </>
        ) : (
          <>
            <div className="status-left">
              <span className="status-item">
                左：<b>{paneL ? paneL.meta.name : '—'}</b>
                {paneL ? ` · ${leftLines} 行` : ''}
              </span>
              <span className="status-item">
                右：<b>{paneR ? paneR.meta.name : '—'}</b>
                {paneR ? ` · ${rightLines} 行` : ''}
              </span>
              <span className="status-item">
                变更行：<b>{summary.changedLines}</b>
              </span>
            </div>
            <div className="status-spacer" />
            <div className="status-right">
              {computing ? (
                <span className="eq-badge busy">正在计算差异…</span>
              ) : summary.changedLines === 0 ? (
                <span className="eq-badge same">两文件内容完全一致</span>
              ) : (
                <span className="eq-badge diff">有差异</span>
              )}
            </div>
          </>
        )}
      </footer>

      {folderScanning && mode !== 'folder' && (
        <div className="computing-overlay">
          <span className="computing-ring" />
          <span>
            正在扫描文件夹…
            {scanProgress ? ` 已比对 ${scanProgress.done} / ${scanProgress.total}` : ''}
          </span>
        </div>
      )}

      {snapshotSaving && (
        <div className="computing-overlay">
          <span className="computing-ring" />
          <span>
            正在读取差异文件内容，准备快照…
            {snapshotProgress ? ` 已读取 ${snapshotProgress.done} / ${snapshotProgress.total}` : ''}
          </span>
        </div>
      )}

      {computing && (
        <div className="computing-overlay">
          <span className="computing-ring" />
          <span>正在计算差异…</span>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {aboutOpen && (
        <AboutModal
          version={appVersion}
          onClose={() => setAboutOpen(false)}
          onCopy={(text, label) => {
            void window.api.setClipboard(text)
            showToast(`${label}已复制到剪贴板`)
          }}
        />
      )}
      {pasteSide && (
        <TextInputModal
          title={`粘贴${pasteSide === 'left' ? '左侧' : '右侧'}文本`}
          onCancel={() => setPasteSide(null)}
          onConfirm={(t) => confirmPaste(pasteSide, t)}
        />
      )}
      {toasts.length > 0 && (
        <div className="toast-wrap">
          {toasts.map((t) => (
            <div className="toast" key={t.id}>
              <span className="toast-text">{t.text}</span>
              {t.action && (
                <button
                  className="toast-btn"
                  onClick={() => {
                    t.action!.onClick()
                    dismissToast(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
