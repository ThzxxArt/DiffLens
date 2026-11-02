import { useCallback } from 'react'
import type { PaneState } from '../app/types'
import type { DiffOptions, DiffResult, DiffRow, DiffSummary } from '../diff/diffEngine'
import { buildReport, REPORT_EXT, type ReportContext, type ReportFormat } from '../diff/report'
import type { FolderSnapshot } from '../diff/snapshotDiff'
import { stamp } from '../utils/stamp'
import type { ShowToast } from './useToast'

/** 单文件报告导出（HTML / TXT / Markdown / Patch），含快照内容对照说明。 */
export function useReportExport({
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
}: {
  diff: DiffResult | null
  rows: DiffRow[]
  paneL: PaneState | null
  paneR: PaneState | null
  summary: DiffSummary
  options: DiffOptions
  showToast: ShowToast
  canPatch: boolean
  appVersion: string
  leftLines: number
  rightLines: number
  snapshot: FolderSnapshot | null
}): (fmt: ReportFormat) => Promise<void> {
  return useCallback(
    async (fmt: ReportFormat) => {
      // 计算中（diff 为 null）不导出：正常情况下导出按钮已禁用，此处兜底防御
      if (!diff) return
      // Patch 兜底守卫（菜单项已禁用）：判等污染的行集无法产出可应用的 unified diff
      if (fmt === 'patch' && !canPatch) {
        showToast('当前比较选项把部分不同内容判为相同，Patch 无法表达，请关闭相关选项后导出')
        return
      }
      // 字符级对比降级时，报告头部按实际生效语义描述：
      // 整体降级按行级语义；部分降级保持字符级语义并标注部分块按行级
      const reportOptions: DiffOptions = diff.charModeDowngraded
        ? {
            ...options,
            charMode: false,
            ignoreAllWhitespace: true,
            ignoreBlankLines: true,
            trimWhitespace: false
          }
        : options
      // 快照基线内容对照场景：左侧面板为快照基线（encoding 为 0.10.0 起的既定标记），
      // 报告头部注明数据来源与基线保存时间——脱离应用后仍可辨识
      const isSnapshotCompare =
        snapshot !== null && paneL !== null && paneL.meta.encoding === '快照基线'
      const ctx: ReportContext = {
        leftName: paneL?.meta.name ?? '',
        rightName: paneR?.meta.name ?? '',
        leftEncoding: paneL?.meta.encoding ?? '',
        rightEncoding: paneR?.meta.encoding ?? '',
        leftPath: paneL?.path || undefined,
        rightPath: paneR?.path || undefined,
        options: reportOptions,
        ...(diff.charModePartial && !diff.charModeDowngraded ? { charModePartial: true } : {}),
        // 生成器版本号（可追溯）与原始文本行数（忽略空行开启时 rows 统计偏小）
        ...(appVersion !== '' ? { version: appVersion } : {}),
        ...(leftLines > 0 ? { leftLines } : {}),
        ...(rightLines > 0 ? { rightLines } : {}),
        ...(isSnapshotCompare
          ? {
              compareNote: `左侧为快照基线（保存于 ${new Date(snapshot!.savedAt).toLocaleString(
                'zh-CN'
              )}），右侧为当前文件`
            }
          : {})
      }
      // 尾部无换行标记（patch 格式专用）：splitLines 吃掉了尾部换行信息，按原文判定
      const tail =
        fmt === 'patch'
          ? {
              leftNoNewline: (paneL?.text ?? '') !== '' && !paneL!.text.endsWith('\n'),
              rightNoNewline: (paneR?.text ?? '') !== '' && !paneR!.text.endsWith('\n')
            }
          : undefined
      const content = buildReport(rows, ctx, summary, fmt, tail)
      const defaultName =
        fmt === 'patch'
          ? `DiffLens-patch-${stamp()}.${REPORT_EXT[fmt]}`
          : `DiffLens-report-${stamp()}.${REPORT_EXT[fmt]}`
      let res: { ok: boolean; path: string | null }
      try {
        res = await window.api.saveReport(content, defaultName)
      } catch {
        showToast('导出失败，请重试')
        return
      }
      if (res.ok && res.path) {
        const p = res.path
        showToast(`报告已保存：${p}`, {
          label: '打开文件夹',
          onClick: () => void window.api.showInFolder(p)
        })
      }
    },
    [
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
    ]
  )
}
