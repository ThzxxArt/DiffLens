import type { FolderEntry, FolderEntryStatus } from '../../../preload/index'
import { esc, footLine, ignoreRulesLine, REPORT_CSS, REPORT_EXT, type ReportFormat } from './report'
import { SNAPSHOT_CHANGE_LABEL, type SnapshotDiffEntry } from './snapshotDiff'

/**
 * 文件夹对比报告生成器（HTML / 纯文本 / Markdown 三格式）。
 * 与单文件报告共用主题样式（REPORT_CSS）与转义工具；语义判等关闭时统计中语义同恒为 0。
 * 快照对照模式导出（snapshotEntries 提供）时条目表替换为变迁对照表（全量含 stable，
 * 与界面默认隐藏 stable 不同——报告口径为信息零丢失）。
 */

export type { ReportFormat }

/** 文件夹报告上下文 */
export interface FolderReportContext {
  leftDir: string
  rightDir: string
  /** 语义判等是否开启（报告头部说明判定口径） */
  semantic: boolean
  /** 条目因数量上限被截断（报告头部警示） */
  truncated: boolean
  /** 枚举总数（截断时为已遍历下限） */
  total: number
  /** 快照对照说明（快照对照模式导出时附注变迁统计与基线时间） */
  snapshotNote?: string
  /** 快照对照条目（对照模式导出时提供：条目表替换为变迁对照表） */
  snapshotEntries?: SnapshotDiffEntry[]
  /** 生成器版本号（尾部署名；可追溯报告由哪个版本产出） */
  version?: string
  /** 生效的忽略规则（非空时头部说明——被忽略条目不进报告，脱离应用后仍可辨识缺失原因） */
  ignoreRules?: string[]
}

/** 六类状态统计 */
export interface FolderStats {
  same: number
  semanticSame: number
  different: number
  leftOnly: number
  rightOnly: number
  unreadable: number
}

export function countFolderStats(entries: FolderEntry[]): FolderStats {
  const s: FolderStats = {
    same: 0,
    semanticSame: 0,
    different: 0,
    leftOnly: 0,
    rightOnly: 0,
    unreadable: 0
  }
  for (const e of entries) {
    if (e.status === 'same') s.same++
    else if (e.status === 'semantic-same') s.semanticSame++
    else if (e.status === 'different') s.different++
    else if (e.status === 'left-only') s.leftOnly++
    else if (e.status === 'right-only') s.rightOnly++
    else s.unreadable++
  }
  return s
}

/** 一句话结论：给不熟悉状态符号的人看 */
export function plainFolderSummary(stats: FolderStats, entriesLen: number): string {
  if (entriesLen === 0) return '两个文件夹内都没有文件'
  const diffTotal = stats.different + stats.leftOnly + stats.rightOnly
  if (diffTotal === 0) {
    return stats.semanticSame > 0
      ? `两文件夹内容完全一致（其中 ${stats.semanticSame} 个文件仅空白/换行差异）`
      : '两文件夹内容完全一致'
  }
  const parts: string[] = []
  if (stats.different > 0) parts.push(`内容不同 ${stats.different} 个`)
  if (stats.leftOnly > 0) parts.push(`仅左侧 ${stats.leftOnly} 个`)
  if (stats.rightOnly > 0) parts.push(`仅右侧 ${stats.rightOnly} 个`)
  const semNote = stats.semanticSame > 0 ? `（另有 ${stats.semanticSame} 个仅空白/换行差异，不计入不同）` : ''
  const unreadNote = stats.unreadable > 0 ? `；另有 ${stats.unreadable} 个文件无法读取（被占用/权限）` : ''
  return `共 ${diffTotal} 个文件存在差异：${parts.join('、')}${semNote}${unreadNote}`
}

/** 状态的人话标签 */
const STATUS_LABEL: Record<FolderEntryStatus, string> = {
  same: '相同',
  'semantic-same': '语义同',
  different: '不同',
  'left-only': '仅左侧',
  'right-only': '仅右侧',
  unreadable: '无法读取'
}

/**
 * 人类可读的文件大小（报告与 FolderView 列表共用同一实现）。
 * GB/TB 档必备：文件夹对比无单文件大小上限（10MB 只是全量比对上限，更大文件
 * 采样判定但大小字段照常显示），GB 级（视频/镜像）此前会显示为 1024.0 MB，
 * TB 级（虚拟机镜像/备份归档）同理会显示为 1024.0 GB——档位逐级补全。
 */
export function fmtSize(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  return `${(n / 1024 / 1024 / 1024 / 1024).toFixed(1)} TB`
}

/** ============ HTML 报告 ============ */

/** 文件夹报告追加样式：条目表状态列配色（叠加在 REPORT_CSS 之上） */
const FOLDER_EXTRA_CSS = `
  .f-table { border-collapse:collapse; width:100%; table-layout:fixed;
    font-family:Consolas,'JetBrains Mono',monospace; font-size:12.5px;
    border:1px solid rgba(148,163,255,.14); border-radius:12px; overflow:hidden; }
  .f-table col.c-st { width:76px; }
  .f-table col.c-chg { width:88px; }
  .f-table col.c-ls { width:88px; }
  .f-table col.c-rs { width:88px; }
  .f-table thead td { font-family:'Segoe UI','Microsoft YaHei',sans-serif; font-size:11px; color:#74809a;
    background:rgba(124,108,255,.08); border-bottom:1px solid rgba(148,163,255,.18);
    padding:6px 10px; text-align:left; letter-spacing:1px; }
  .f-table td { border-bottom:1px solid rgba(148,163,255,.08); padding:4px 10px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .f-table td.st { text-align:center; font-family:'Segoe UI','Microsoft YaHei',sans-serif;
    font-weight:700; font-size:12px; border-radius:4px; }
  .f-table td.sz { text-align:right; color:#74809a; font-variant-numeric:tabular-nums; }
  .f-table td.rel { word-break:break-all; white-space:normal; }
  .f-table tr.st-same td.st { color:#7ee2a8; background:rgba(34,197,94,.10); }
  .f-table tr.st-sem td.st { color:#22d3ee; background:rgba(34,211,238,.10); }
  .f-table tr.st-diff td.st { color:#f7a9a9; background:rgba(248,113,113,.10); }
  .f-table tr.st-left td.st { color:#c9bfff; background:rgba(124,108,255,.12); }
  .f-table tr.st-right td.st { color:#c9bfff; background:rgba(124,108,255,.12); }
  .f-table tr.st-unread td.st { color:#f6bd87; background:rgba(245,158,11,.10); }
  .f-table td.chg { text-align:center; font-family:'Segoe UI','Microsoft YaHei',sans-serif;
    font-weight:700; font-size:12px; border-radius:4px; }
  .f-table tr.chg-fixed td.chg, .f-table tr.chg-new td.chg { color:#7ee2a8; background:rgba(34,197,94,.10); }
  .f-table tr.chg-regressed td.chg { color:#f7a9a9; background:rgba(248,113,113,.10); }
  .f-table tr.chg-changed td.chg { color:#f6bd87; background:rgba(245,158,11,.10); }
  .f-table tr.chg-gone td.chg, .f-table tr.chg-stable td.chg { color:#74809a; background:rgba(148,163,255,.06); }
  .f-table tr:hover { background:rgba(34,211,238,.05); }
  .trunc-note { color:#f6bd87; font-size:12.5px; padding:8px 14px; border-radius:10px;
    background:rgba(245,158,11,.10); border:1px solid rgba(245,158,11,.35); margin-bottom:14px; }
  @media print {
    .f-table { border-color:#ccc; }
    .f-table td { border-color:#eee; }
    .f-table thead td { background:#f3f3f6; color:#666; }
    .trunc-note { color:#8a5a00; background:#fff7e6; border-color:#e8c07a; }
    .f-table tr.chg-fixed td.chg, .f-table tr.chg-new td.chg { color:#15803d; background:#e9f9ef; }
    .f-table tr.chg-regressed td.chg { color:#b91c1c; background:#fdeeee; }
    .f-table tr.chg-changed td.chg { color:#b45309; background:#fdf4e5; }
    .f-table tr.chg-gone td.chg, .f-table tr.chg-stable td.chg { color:#888; background:#f3f3f6; }
  }
`

/** 变迁对照表的行 HTML（当前/基线状态缺失显示 —；大小取 current ?? baseline 与界面对照行一致） */
function snapshotRowHtml(e: SnapshotDiffEntry): string {
  const display = e.current ?? e.baseline!
  const cur = e.current ? STATUS_LABEL[e.current.status] : '—'
  const base = e.baseline ? STATUS_LABEL[e.baseline.status] : '—'
  return `<tr class="chg-${e.change}">
  <td class="chg">${SNAPSHOT_CHANGE_LABEL[e.change]}</td>
  <td class="rel">${esc(e.rel)}</td>
  <td class="st">${cur}</td>
  <td class="st">${base}</td>
  <td class="sz">${fmtSize(display.leftSize)}</td>
  <td class="sz">${fmtSize(display.rightSize)}</td>
</tr>`
}

function buildFolderHtml(
  entries: FolderEntry[],
  ctx: FolderReportContext,
  stats: FolderStats
): string {
  const verdictOk = stats.different + stats.leftOnly + stats.rightOnly === 0
  const semLine = ctx.semantic
    ? '判定口径：语义判等开启（空白/换行差异计为语义同，不计入不同）'
    : '判定口径：字节级严格比对（任何字节差异均计为不同）'
  // 对照模式：条目表替换为变迁对照表（全量含 stable），列结构随之切换
  const snaps = ctx.snapshotEntries
  const cols = snaps
    ? '<colgroup><col class="c-chg"><col><col class="c-st"><col class="c-st"><col class="c-ls"><col class="c-rs"></colgroup>'
    : '<colgroup><col class="c-st"><col><col class="c-ls"><col class="c-rs"></colgroup>'
  const headRow = snaps
    ? '<tr><td>变迁</td><td>相对路径</td><td>当前状态</td><td>基线状态</td><td style="text-align:right">左侧大小</td><td style="text-align:right">右侧大小</td></tr>'
    : '<tr><td>状态</td><td>相对路径</td><td style="text-align:right">左侧大小</td><td style="text-align:right">右侧大小</td></tr>'

  const rowsHtml = snaps
    ? snaps.map(snapshotRowHtml).join('\n')
    : entries
        .map((e) => {
          const cls =
            e.status === 'same'
              ? 'st-same'
              : e.status === 'semantic-same'
                ? 'st-sem'
                : e.status === 'different'
                  ? 'st-diff'
                  : e.status === 'left-only'
                    ? 'st-left'
                    : e.status === 'right-only'
                      ? 'st-right'
                      : 'st-unread'
          const approx = e.approximate ? ' <i title="超大文件，头部采样近似判定">≈</i>' : ''
          return `<tr class="${cls}">
  <td class="st">${STATUS_LABEL[e.status]}</td>
  <td class="rel">${esc(e.rel)}${approx}</td>
  <td class="sz">${fmtSize(e.leftSize)}</td>
  <td class="sz">${fmtSize(e.rightSize)}</td>
</tr>`
        })
        .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DiffLens 文件夹对比报告</title>
<style>${REPORT_CSS}${FOLDER_EXTRA_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <div class="hero-title">📁 DiffLens 文件夹对比报告</div>
  <div class="hero-time">生成于 ${new Date().toLocaleString('zh-CN')}</div>
  <div class="hero-opts">${esc(semLine)}</div>
  ${
    ctx.ignoreRules && ctx.ignoreRules.length > 0
      ? `<div class="hero-opts">忽略规则：${esc(ignoreRulesLine(ctx.ignoreRules))}（命中项不参与对比）</div>`
      : ''
  }
  ${ctx.snapshotNote ? `<div class="hero-opts">快照对照：${esc(ctx.snapshotNote)}</div>` : ''}
  <div class="verdict${verdictOk ? ' ok' : ''}">${esc(plainFolderSummary(stats, entries.length))}</div>
  <div class="files">
    <div class="file-card left">
      <div class="file-side">左侧目录</div>
      <div class="file-name">${esc(ctx.leftDir)}</div>
    </div>
    <div class="files-arrow">➜</div>
    <div class="file-card right">
      <div class="file-side">右侧目录</div>
      <div class="file-name">${esc(ctx.rightDir)}</div>
    </div>
  </div>
  <div class="stats">
    <div class="stat same"><div class="stat-num">${stats.same}</div><div class="stat-label">相同</div></div>
    <div class="stat rate"><div class="stat-num">${stats.semanticSame}</div><div class="stat-label">语义同</div></div>
    <div class="stat del"><div class="stat-num">${stats.different}</div><div class="stat-label">不同</div></div>
    <div class="stat"><div class="stat-num">${stats.leftOnly}</div><div class="stat-label">仅左侧</div></div>
    <div class="stat"><div class="stat-num">${stats.rightOnly}</div><div class="stat-label">仅右侧</div></div>
    ${stats.unreadable > 0 ? `<div class="stat mod"><div class="stat-num">${stats.unreadable}</div><div class="stat-label">无法读取</div></div>` : ''}
    <div class="stat ins"><div class="stat-num">${entries.length}</div><div class="stat-label">条目总数</div></div>
  </div>
</header>
${ctx.truncated ? `<div class="trunc-note">⚠ 文件数量超出上限（已发现 ${ctx.total}+ 个），以下仅包含部分条目，请人工确认完整性</div>` : ''}
<table class="f-table">
${cols}
<thead>${headRow}</thead>
<tbody>
${
  snaps
    ? snaps.length === 0
      ? '<tr><td colspan="6" style="text-align:center;color:#74809a;padding:24px">快照与当前结果都没有条目</td></tr>'
      : rowsHtml
    : entries.length === 0
      ? '<tr><td colspan="4" style="text-align:center;color:#74809a;padding:24px">两个文件夹内都没有文件</td></tr>'
      : rowsHtml
}
</tbody>
</table>
<div class="foot">由 DiffLens 生成 · 语义同 = 字节不同但剔除空白/换行后内容一致（双击条目可查看单文件差异明细）${ctx.version ? ` · v${esc(ctx.version)}` : ''}</div>
</div>
</body>
</html>`
}

/** ============ 纯文本报告 ============ */

function buildFolderTxt(
  entries: FolderEntry[],
  ctx: FolderReportContext,
  stats: FolderStats
): string {
  const lines = [
    '====== DiffLens 文件夹对比报告 ======',
    `左侧目录：${ctx.leftDir}`,
    `右侧目录：${ctx.rightDir}`,
    `对比时间：${new Date().toLocaleString('zh-CN')}`,
    `判定口径：${ctx.semantic ? '语义判等开启（空白/换行差异计为语义同）' : '字节级严格比对'}`,
    ...(ctx.ignoreRules && ctx.ignoreRules.length > 0
      ? [`忽略规则：${ignoreRulesLine(ctx.ignoreRules)}（命中项不参与对比）`]
      : []),
    ...(ctx.snapshotNote ? [`快照对照：${ctx.snapshotNote}`] : []),
    `结论：${plainFolderSummary(stats, entries.length)}`,
    `统计：相同 ${stats.same} ｜ 语义同 ${stats.semanticSame} ｜ 不同 ${stats.different} ｜ 仅左 ${stats.leftOnly} ｜ 仅右 ${stats.rightOnly}${stats.unreadable > 0 ? ` ｜ 无法读取 ${stats.unreadable}` : ''} ｜ 共 ${entries.length} 项`
  ]
  if (ctx.truncated) {
    lines.push(`⚠ 文件过多（${ctx.total}+），以下仅包含部分条目，请人工确认完整性`)
  }
  lines.push('----------------------------------')
  const snaps = ctx.snapshotEntries
  if (snaps) {
    // 变迁对照表：变迁 / 当前状态 / 基线状态 / 相对路径 / 大小（全量含 stable）
    if (snaps.length === 0) {
      lines.push('快照与当前结果都没有条目')
    } else {
      const width = Math.min(60, Math.max(...snaps.map((e) => e.rel.length)))
      for (const e of snaps) {
        const display = e.current ?? e.baseline!
        const rel = e.rel.length > width ? e.rel.slice(0, width - 1) + '…' : e.rel.padEnd(width)
        const cur = e.current ? STATUS_LABEL[e.current.status] : '—'
        const base = e.baseline ? STATUS_LABEL[e.baseline.status] : '—'
        lines.push(
          `${SNAPSHOT_CHANGE_LABEL[e.change].padEnd(4)} ${cur.padEnd(3)} ${base.padEnd(3)} ${rel} ${fmtSize(display.leftSize).padStart(9)}  ${fmtSize(display.rightSize).padStart(9)}`
        )
      }
    }
  } else if (entries.length === 0) {
    lines.push('两个文件夹内都没有文件')
  } else {
    // 路径列宽对齐（封顶 60，超长路径截断保持可读）
    const width = Math.min(60, Math.max(...entries.map((e) => e.rel.length)))
    for (const e of entries) {
      const rel = e.rel.length > width ? e.rel.slice(0, width - 1) + '…' : e.rel.padEnd(width)
      lines.push(
        `${STATUS_LABEL[e.status].padEnd(3)} ${rel} ${fmtSize(e.leftSize).padStart(9)}  ${fmtSize(e.rightSize).padStart(9)}${e.approximate ? '  ≈' : ''}`
      )
    }
  }
  lines.push('----------------------------------')
  lines.push(footLine(ctx.version))
  return lines.join('\n')
}

/** ============ Markdown 报告 ============ */

function buildFolderMd(
  entries: FolderEntry[],
  ctx: FolderReportContext,
  stats: FolderStats
): string {
  const out: string[] = [
    '# DiffLens 文件夹对比报告',
    '',
    `> 左侧目录：${ctx.leftDir}`,
    `> 右侧目录：${ctx.rightDir}`,
    `> 对比时间：${new Date().toLocaleString('zh-CN')}`,
    `> 判定口径：${ctx.semantic ? '语义判等开启（空白/换行差异计为语义同）' : '字节级严格比对'}`,
    ...(ctx.ignoreRules && ctx.ignoreRules.length > 0
      ? [`> 忽略规则：${ignoreRulesLine(ctx.ignoreRules)}（命中项不参与对比）`]
      : []),
    ...(ctx.snapshotNote ? [`> 快照对照：${ctx.snapshotNote}`] : []),
    `> 结论：${plainFolderSummary(stats, entries.length)}`,
    `> 统计：相同 ${stats.same} ｜ 语义同 ${stats.semanticSame} ｜ 不同 ${stats.different} ｜ 仅左 ${stats.leftOnly} ｜ 仅右 ${stats.rightOnly}${stats.unreadable > 0 ? ` ｜ 无法读取 ${stats.unreadable}` : ''} ｜ 共 ${entries.length} 项`,
    ''
  ]
  if (ctx.truncated) {
    out.push(`> ⚠ 文件过多（${ctx.total}+），以下仅包含部分条目，请人工确认完整性`, '')
  }
  const snaps = ctx.snapshotEntries
  if (snaps) {
    // 变迁对照表（全量含 stable）
    out.push('| 变迁 | 相对路径 | 当前状态 | 基线状态 | 左侧大小 | 右侧大小 |', '| --- | --- | --- | --- | --- | --- |')
    if (snaps.length === 0) {
      out.push('| （空） | 快照与当前结果都没有条目 | — | — | — | — |')
    } else {
      for (const e of snaps) {
        const display = e.current ?? e.baseline!
        const rel = e.rel.replace(/\|/g, '\\|')
        const cur = e.current ? STATUS_LABEL[e.current.status] : '—'
        const base = e.baseline ? STATUS_LABEL[e.baseline.status] : '—'
        out.push(`| ${SNAPSHOT_CHANGE_LABEL[e.change]} | \`${rel}\` | ${cur} | ${base} | ${fmtSize(display.leftSize)} | ${fmtSize(display.rightSize)} |`)
      }
    }
  } else {
    out.push('| 状态 | 相对路径 | 左侧大小 | 右侧大小 |', '| --- | --- | --- | --- |')
    if (entries.length === 0) {
      out.push('| （空） | 两个文件夹内都没有文件 | — | — |')
    } else {
      for (const e of entries) {
        const rel = e.rel.replace(/\|/g, '\\|')
        out.push(`| ${STATUS_LABEL[e.status]} | \`${rel}\`${e.approximate ? ' ≈' : ''} | ${fmtSize(e.leftSize)} | ${fmtSize(e.rightSize)} |`)
      }
    }
  }
  out.push('', `> ${footLine(ctx.version)}`)
  return out.join('\n')
}

/** 按格式生成文件夹对比报告字符串 */
export function buildFolderReport(
  entries: FolderEntry[],
  ctx: FolderReportContext,
  format: ReportFormat
): string {
  const stats = countFolderStats(entries)
  if (format === 'html') return buildFolderHtml(entries, ctx, stats)
  if (format === 'txt') return buildFolderTxt(entries, ctx, stats)
  return buildFolderMd(entries, ctx, stats)
}

/** 文件夹报告扩展名（与单文件报告一致） */
export { REPORT_EXT }
