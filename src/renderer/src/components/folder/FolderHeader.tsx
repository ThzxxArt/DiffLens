import { useCallback, useRef, useState, type ReactElement } from 'react'
import type { ReportFormat } from '../../diff/report'
import { useDismiss } from '../../hooks/useDismiss'
import { FORMATS } from './folderViewConfig'

export interface FolderHeaderProps {
  leftDir: string
  rightDir: string
  scanning: boolean
  saving: boolean
  onRescan: () => void
  onReopen: () => void
  onSaveSnapshot: () => void
  onLoadSnapshot: () => void
  onExit: () => void
  onExport: (fmt: ReportFormat) => void
}

/** 文件夹顶部：两侧路径卡片 + 横排操作区（快照/导出下拉、重扫、重选、返回）。 */
export default function FolderHeader({
  leftDir,
  rightDir,
  scanning,
  saving,
  onRescan,
  onReopen,
  onSaveSnapshot,
  onLoadSnapshot,
  onExit,
  onExport
}: FolderHeaderProps): ReactElement {
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

  return (
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
          title={
            scanning ? '正在扫描文件夹' : '重新扫描当前两个目录（增量：未变更的文件直接沿用判定）'
          }
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
  )
}
