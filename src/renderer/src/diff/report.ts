import { DiffOptions, DiffRow, DiffSummary, SideCell } from './diffEngine'

export type ReportFormat = 'html' | 'txt' | 'md' | 'patch'

export interface ReportContext {
  /** 左侧文件显示名；未选择为空串 */
  leftName: string
  /** 右侧文件显示名 */
  rightName: string
  /** 左侧编码标注 */
  leftEncoding: string
  /** 右侧编码标注 */
  rightEncoding: string
  /** 左侧文件完整路径（可选） */
  leftPath?: string
  /** 右侧文件完整路径（可选） */
  rightPath?: string
  /** 本次对比生效的比较选项（用于报告头部说明，可选） */
  options?: DiffOptions
  /** 字符级对比部分降级（部分超限块按行级配对，其余仍字符级；头部说明标注） */
  charModePartial?: boolean
  /** 生成器版本号（App 经 app:get-version 获取；尾部署名“生成于 DiffLens vX.Y.Z”） */
  version?: string
  /** 对照说明（快照基线内容对照场景：注明左侧为快照基线及其保存时间、右侧为当前文件） */
  compareNote?: string
  /** 左侧原始文本行数（countLines 口径；忽略空行开启时 rows 统计会偏小，优先用本字段） */
  leftLines?: number
  /** 右侧原始文本行数 */
  rightLines?: number
}

/** HTML 转义（文件夹报告复用） */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 格式化行号：传 width 时按位数右对齐（左补空格，用于纯文本报告对齐）；null 返回空串 */
function padNo(n: number | null, width?: number): string {
  if (n === null) return ''
  const s = String(n)
  return width !== undefined ? s.padStart(width) : s
}

/** 单元格文本（词级高亮段在 HTML 里渲染为 span） */
function cellHtml(cell: SideCell): string {
  if (cell.segs) {
    return cell.segs
      .map((s) => {
        const cls = s.kind === 'insert' ? 'ins' : s.kind === 'delete' ? 'del' : 'ct'
        return `<span class="${cls}">${esc(s.text)}</span>`
      })
      .join('')
  }
  return `<span>${esc(cell.text ?? '')}</span>`
}

const typeTag = (k: DiffRow['rowKind']): string =>
  k === 'added' ? '+' : k === 'removed' ? '−' : k === 'modified' ? '~' : ' '

/** ============ 差异分块（Hunk） ============ */

/** 变更块前后保留的上下文行数（GitHub 风格惯例） */
export const HUNK_CONTEXT = 3

/** 一段直接展示的行区间（含上下文），与相邻段之间被省略的相同行数 */
export interface ReportSegment {
  /** 段起始行索引（0 基，含上下文，含） */
  start: number
  /** 段结束行索引（0 基，含上下文，含） */
  end: number
  /** 段内变更行数 */
  changes: number
  /** 段前被省略的行数（首段可能非 0） */
  skippedBefore: number
  /** 段后被省略的行数（仅最后一段可能非 0） */
  skippedAfter: number
}

/**
 * 把全量 diff 行切分为"差异块"：每处变更前后各保留 context 行上下文，
 * 相邻区间重叠或紧邻时合并；两块之间的大段相同行交由渲染层折叠省略。
 * 无任何变更时返回单段全展示（不折叠）。
 */
export function buildSegments(rows: DiffRow[], context: number = HUNK_CONTEXT): ReportSegment[] {
  if (rows.length === 0) return []
  const changedIdx: number[] = []
  rows.forEach((r, i) => {
    if (r.isChanged) changedIdx.push(i)
  })
  if (changedIdx.length === 0) {
    return [{ start: 0, end: rows.length - 1, changes: 0, skippedBefore: 0, skippedAfter: 0 }]
  }

  // 变更 ±context 生成区间，重叠或紧邻（中间无省略行）时合并
  const ranges: Array<[number, number]> = []
  for (const idx of changedIdx) {
    const s = Math.max(0, idx - context)
    const e = Math.min(rows.length - 1, idx + context)
    const last = ranges[ranges.length - 1]
    if (last && s <= last[1] + 1) {
      last[1] = Math.max(last[1], e)
    } else {
      ranges.push([s, e])
    }
  }

  const segs: ReportSegment[] = []
  let cursor = 0
  for (const [s, e] of ranges) {
    let changes = 0
    for (let i = s; i <= e; i++) {
      if (rows[i].isChanged) changes++
    }
    segs.push({ start: s, end: e, changes, skippedBefore: s - cursor, skippedAfter: 0 })
    cursor = e + 1
  }
  segs[segs.length - 1].skippedAfter = rows.length - cursor
  return segs
}

/** ============ 人话总结 ============ */

/** 一句话结论：给不熟悉 diff 符号的人看（无差异 / 增删改汇总，为 0 的项省略） */
export function plainSummary(summary: DiffSummary): string {
  if (summary.changedLines === 0) return '两文件内容完全一致'
  const parts: string[] = []
  if (summary.inserted > 0) parts.push(`新增 ${summary.inserted} 行`)
  if (summary.deleted > 0) parts.push(`删除 ${summary.deleted} 行`)
  if (summary.modified > 0) parts.push(`修改 ${summary.modified} 行`)
  return `共 ${summary.changedLines} 处不同：${parts.join('、')}`
}

/** 已生效比较选项的人话描述（报告头部展示；无选项生效时说明为严格对比） */
export function plainOptions(options?: DiffOptions, extra?: { charModePartial?: boolean }): string {
  // 字符级对比为最强空白语义（全部空白与换行都不参与判等），单独描述并遮蔽空白类子选项；
  // 大内容按“行锚定 + 变更组分块”计算，不再整篇受字符量上限约束，总预算随输入规模自适应；
  // 部分降级（逐组预算制）时标注部分差异过大的块按行级对比
  if (options?.charMode) {
    const base = extra?.charModePartial
      ? '字符级对比（忽略全部空白与换行；部分差异过大的块按行级对比）'
      : '字符级对比（忽略全部空白与换行，大内容自动分块计算，预算随规模自适应）'
    const on = [base]
    if (options.ignoreCase) on.push('忽略大小写')
    return on.join('、')
  }
  const on: string[] = []
  // 忽略所有空白为行首尾空白的超集，同时开启时只列前者，避免误导
  if (options?.ignoreAllWhitespace) on.push('忽略所有空白')
  else if (options?.trimWhitespace) on.push('忽略行首尾空白')
  if (options?.ignoreCase) on.push('忽略大小写')
  if (options?.ignoreBlankLines) on.push('忽略空行')
  return on.length > 0 ? on.join('、') : '无（严格逐字符对比）'
}

const headLines = (ctx: ReportContext, summary: DiffSummary, title: string): string[] => [
  title,
  `对比：${ctx.leftName || '（未选择）'}${ctx.leftEncoding ? ` (${ctx.leftEncoding})` : ''}${
    ctx.leftPath ? ` [${ctx.leftPath}]` : ''
  }  →  ${ctx.rightName || '（未选择）'}${ctx.rightEncoding ? ` (${ctx.rightEncoding})` : ''}${
    ctx.rightPath ? ` [${ctx.rightPath}]` : ''
  }`,
  `对比时间：${new Date().toLocaleString('zh-CN')}`,
  `比较选项：${plainOptions(ctx.options, { charModePartial: ctx.charModePartial })}`,
  // 对照说明（快照基线内容对照场景）：报告脱离应用后仍可辨识左侧数据来源与时间点
  ...(ctx.compareNote ? [`对照说明：${ctx.compareNote}`] : []),
  `结论：${plainSummary(summary)}`,
  `变更统计：新增 ${summary.inserted} ｜ 删除 ${summary.deleted} ｜ 修改 ${summary.modified}` +
    // 字符级模式追加字符粒度统计（码点数；超长防护行无法细分不计入）
    (ctx.options?.charMode ? ` ｜ 字符 +${summary.charsAdded} / −${summary.charsDeleted}` : '')
]

/** 尾部署名行：携带生成器版本号（可追溯报告由哪个版本产出；未提供时与历史格式一致；文件夹报告复用） */
export const footLine = (version?: string): string =>
  `生成于 DiffLens${version ? ` v${version}` : ''}`

/** 忽略规则说明行文案（文件夹报告头部；超 5 条截断避免单行过长，全文规则可在应用内查看） */
export const ignoreRulesLine = (rules: string[]): string => {
  const head = rules.slice(0, 5).join('、')
  return rules.length > 5 ? `${head} 等 ${rules.length} 条` : head
}

/** ============ HTML 报告 ============ */

/** 报告内嵌样式：延续应用暗色科幻主题，附带打印亮色与窄屏适配（零 JS，任意浏览器可开）；文件夹报告复用并追加条目表样式 */
export const REPORT_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body {
    font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;
    color:#dbe3f4;
    background:
      radial-gradient(1200px 600px at 20% -10%, rgba(124,108,255,.16), transparent 60%),
      radial-gradient(1000px 500px at 90% 110%, rgba(34,211,238,.12), transparent 55%),
      #0a0e17;
    padding:28px 18px 60px;
    line-height:1.5;
  }
  .wrap { max-width:1180px; margin:0 auto; }

  /* ---- Hero 概览 ---- */
  .hero {
    border:1px solid rgba(148,163,255,.32);
    border-radius:16px;
    background:linear-gradient(180deg, rgba(124,108,255,.12), rgba(14,20,32,.65));
    box-shadow:0 20px 60px rgba(0,0,0,.45), 0 0 30px rgba(124,108,255,.12);
    padding:22px 24px;
    margin-bottom:18px;
  }
  .hero-title {
    font-size:22px; font-weight:800; letter-spacing:.5px;
    background:linear-gradient(90deg,#c9bfff,#22d3ee);
    -webkit-background-clip:text; background-clip:text; color:transparent;
  }
  .hero-time { color:#74809a; font-size:12px; margin:2px 0 10px; }
  .hero-opts {
    color:#74809a; font-size:12px; margin:0 0 10px;
    padding:4px 10px; border-radius:8px; display:inline-block;
    background:rgba(148,163,255,.05); border:1px solid rgba(148,163,255,.14);
  }
  .verdict {
    font-size:16px; font-weight:700; color:#f6bd87;
    padding:8px 14px; border-radius:10px; margin-bottom:14px;
    background:rgba(245,158,11,.10); border:1px solid rgba(245,158,11,.35);
  }
  .verdict.ok {
    color:#7ee2a8; background:rgba(34,197,94,.10); border-color:rgba(34,197,94,.35);
  }

  .files { display:flex; align-items:stretch; gap:10px; margin-bottom:14px; }
  .file-card {
    flex:1; min-width:0; padding:10px 14px; border-radius:12px;
    background:rgba(148,163,255,.05); border:1px solid rgba(148,163,255,.18);
  }
  .file-card.left { border-left:3px solid #8b7cff; }
  .file-card.right { border-left:3px solid #22d3ee; }
  .file-side { font-size:11px; color:#74809a; letter-spacing:1px; }
  .file-name {
    font-family:Consolas,'JetBrains Mono',monospace; font-size:14px; font-weight:700;
    color:#dbe3f4; margin:3px 0 2px; word-break:break-all;
  }
  .file-meta { font-size:12px; color:#74809a; }
  .file-path {
    font-size:11px; color:#4d5a74; margin-top:3px; word-break:break-all;
  }
  .files-arrow {
    align-self:center; flex:none; color:#74809a; font-size:18px;
  }

  .stats { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
  .stat {
    flex:1; min-width:96px; text-align:center; padding:10px 8px; border-radius:12px;
    background:rgba(148,163,255,.05); border:1px solid rgba(148,163,255,.18);
  }
  .stat-num { font-size:22px; font-weight:800; font-variant-numeric:tabular-nums; }
  .stat-label { font-size:11px; color:#74809a; margin-top:2px; }
  .stat.ins .stat-num { color:#7ee2a8; }
  .stat.del .stat-num { color:#f7a9a9; }
  .stat.mod .stat-num { color:#f6bd87; }
  .stat.same .stat-num { color:#74809a; }
  .stat.rate .stat-num { color:#22d3ee; }

  .legend {
    display:flex; flex-wrap:wrap; gap:8px 18px; font-size:12px; color:#9aa7c2;
    padding:10px 14px; border-radius:10px; background:rgba(148,163,255,.04);
  }
  .legend .sw {
    display:inline-block; width:12px; height:12px; border-radius:3px;
    margin-right:5px; vertical-align:-1px;
  }
  .sw.add { background:rgba(34,197,94,.55); }
  .sw.del { background:rgba(248,113,113,.5); }
  .sw.mod { background:rgba(245,158,11,.5); }
  .sw.word-del { background:rgba(248,113,113,.3); text-decoration:line-through; }
  .sw.word-ins { background:rgba(34,197,94,.3); }

  /* ---- 差异分布目录 ---- */
  .toc {
    display:flex; gap:12px; align-items:flex-start; margin-bottom:18px;
    padding:10px 14px; border-radius:12px;
    background:rgba(148,163,255,.04); border:1px solid rgba(148,163,255,.14);
  }
  .toc-title { flex:none; font-size:12px; color:#74809a; letter-spacing:1px; padding-top:2px; }
  .toc-list {
    display:flex; flex-wrap:wrap; gap:6px 8px;
    max-height:120px; overflow:auto;
  }
  .toc-list a {
    font-size:12px; color:#9aa7c2; text-decoration:none;
    padding:2px 9px; border-radius:999px;
    background:rgba(124,108,255,.08); border:1px solid rgba(148,163,255,.16);
  }
  .toc-list a:hover { color:#fff; border-color:rgba(148,163,255,.4); }
  .toc-list b { color:#c9bfff; margin-right:6px; }
  .toc-list i { font-style:normal; color:#74809a; margin-left:6px; }

  /* ---- 明细表 ---- */
  .diff-table {
    border-collapse:collapse; width:100%; table-layout:fixed;
    font-family:Consolas,'JetBrains Mono',monospace; font-size:12.5px;
    border:1px solid rgba(148,163,255,.14); border-radius:12px; overflow:hidden;
  }
  .diff-table col.c-tag { width:26px; }
  .diff-table col.c-ln { width:48px; }
  .diff-table col.c-tx { width:calc((100% - 122px) / 2); }
  .diff-table thead td {
    font-family:'Segoe UI','Microsoft YaHei',sans-serif; font-size:11px; color:#74809a;
    background:rgba(124,108,255,.08); border-bottom:1px solid rgba(148,163,255,.18);
    padding:6px 8px; text-align:left; letter-spacing:1px;
  }
  .diff-table td {
    border-bottom:1px solid rgba(148,163,255,.08);
    padding:2px 8px; line-height:21px; white-space:pre-wrap; word-break:break-all;
    vertical-align:top;
  }
  .diff-table td.tag { text-align:right; color:#74809a; }
  .diff-table td.lnl, .diff-table td.lnr { text-align:right; color:#46536e; }
  .diff-table tr.added { background:rgba(34,197,94,.12); }
  .diff-table tr.removed { background:rgba(248,113,113,.10); }
  .diff-table tr.modified { background:rgba(245,158,11,.10); }
  .diff-table tbody > tr:hover { background:rgba(34,211,238,.07); }
  .cell.empty { color:transparent; }
  .ins { border-radius:2px; background:rgba(34,197,94,.3); }
  .del { border-radius:2px; background:rgba(248,113,113,.3); text-decoration:line-through; }

  /* 块标题与锚点定位高亮 */
  .hunk-head td {
    font-family:'Segoe UI','Microsoft YaHei',sans-serif; font-size:12px; color:#9aa7c2;
    background:rgba(124,108,255,.06); letter-spacing:.5px; padding:5px 10px;
  }
  .hunk-head b { color:#c9bfff; }
  tbody.hunk:target .hunk-head td {
    background:rgba(34,211,238,.14); color:#dbe3f4;
  }

  /* 折叠的相同内容段：点开即得全量行 */
  tr.skip td { padding:0; }
  tr.skip details { border-bottom:1px solid rgba(148,163,255,.08); }
  tr.skip summary {
    cursor:pointer; list-style:none; user-select:none;
    font-family:'Segoe UI','Microsoft YaHei',sans-serif;
    font-size:12px; color:#5d6b88; font-style:italic;
    padding:5px 10px; background:rgba(148,163,255,.03);
  }
  tr.skip summary:hover { color:#9aa7c2; background:rgba(148,163,255,.06); }
  tr.skip .fold-table { border:none; }
  tr.skip .fold-table td { color:#8d99b5; }
  tr.skip .fold-table tr.added, tr.skip .fold-table tr.removed,
  tr.skip .fold-table tr.modified { color:#dbe3f4; }

  .foot {
    margin-top:16px; color:#4d5a74; font-size:11px; text-align:center; letter-spacing:1px;
  }

  /* ---- 窄屏 ---- */
  @media (max-width:760px) {
    body { padding:14px 8px 40px; }
    .files { flex-direction:column; }
    .files-arrow { transform:rotate(90deg); align-self:center; }
    .diff-table col.c-tx { width:calc((100% - 122px) / 2); }
  }

  /* ---- 打印：自动切亮色 ---- */
  @media print {
    body { background:#fff; color:#111; padding:0; }
    .hero { border-color:#ccc; background:#fafafa; box-shadow:none; }
  .hero-title { color:#3a2f8f; -webkit-text-fill-color:#3a2f8f; }
  .hero-opts { background:#fafafa; border-color:#ddd; color:#666; }
    .verdict { color:#8a5a00; background:#fff7e6; border-color:#e8c07a; }
    .verdict.ok { color:#116639; background:#effaf3; border-color:#9fdcb6; }
    .file-card, .stat, .toc, .legend { background:#fafafa; border-color:#ddd; }
    .file-name, .stat-num, .toc-list b { color:#111; }
    .stat.ins .stat-num { color:#15803d; }
    .stat.del .stat-num { color:#b91c1c; }
    .stat.mod .stat-num { color:#b45309; }
    .stat.rate .stat-num { color:#0e7490; }
    .diff-table { border-color:#ccc; }
    .diff-table td { border-color:#eee; color:#111; }
    .diff-table thead td { background:#f3f3f6; color:#666; }
    .diff-table td.lnl, .diff-table td.lnr, td.tag { color:#888; }
    .diff-table tr.added { background:#e9f9ef; }
    .diff-table tr.removed { background:#fdeeee; }
    .diff-table tr.modified { background:#fdf4e5; }
    .cell.empty { color:transparent; }
    .ins { background:#b7f0c9; }
    .del { background:#f9c9c9; }
    tr.skip summary { background:#fafafa; color:#777; }
    .toc-list a { color:#333; background:#f3f3f6; border-color:#ddd; }
    a { text-decoration:none; }
  }
`

/** 统计卡 */
function statCard(cls: string, label: string, value: string | number): string {
  return `<div class="stat ${cls}"><div class="stat-num">${value}</div><div class="stat-label">${label}</div></div>`
}

/** 文件信息卡（名称/编码/行数/路径） */
function fileCard(
  side: 'left' | 'right',
  name: string,
  encoding: string,
  path: string | undefined,
  lines: number
): string {
  return `<div class="file-card ${side}">
  <div class="file-side">${side === 'left' ? '左侧 · 原始文件' : '右侧 · 对比文件'}</div>
  <div class="file-name">${esc(name || '（未选择）')}</div>
  <div class="file-meta">${esc(encoding || '未知编码')} · ${lines} 行</div>
  ${path ? `<div class="file-path">${esc(path)}</div>` : ''}
</div>`
}

/** 单行 HTML（主表与折叠内嵌表共用） */
function rowHtml(row: DiffRow): string {
  const tag = typeTag(row.rowKind)
  const l = row.left
  const r = row.right
  const lCls = row.rowKind === 'added' ? 'empty' : row.rowKind
  const rCls = row.rowKind === 'removed' ? 'empty' : row.rowKind
  return `<tr class="${row.rowKind}">
  <td class="tag">${tag}</td>
  <td class="lnl">${padNo(l.lineNo)}</td>
  <td class="cell ${lCls}">${cellHtml(l)}</td>
  <td class="lnr">${padNo(r.lineNo)}</td>
  <td class="cell ${rCls}">${cellHtml(r)}</td>
</tr>`
}

/** 折叠行：大段相同内容收进 details，点开即得全量行（信息零丢失） */
function skipHtml(count: number, slice: DiffRow[]): string {
  const inner = slice.map(rowHtml).join('\n')
  return `<tr class="skip"><td colspan="5">
  <details><summary>⋯ 相同内容 ${count} 行 · 点击展开 ⋯</summary>
  <table class="fold-table"><colgroup><col class="c-tag"><col class="c-ln"><col class="c-tx"><col class="c-ln"><col class="c-tx"></colgroup><tbody>
${inner}
  </tbody></table>
  </details>
</td></tr>`
}

/** 差异分布目录：多于一块时给出锚点导航（行号区间取段首/段尾行的行号，空槽取另一侧） */
function renderToc(rows: DiffRow[], segs: ReportSegment[]): string {
  if (segs.length <= 1) return ''
  const links = segs
    .map((s, i) => {
      const head = rows[s.start].left.lineNo ?? rows[s.start].right.lineNo ?? '·'
      const tail = rows[s.end].left.lineNo ?? rows[s.end].right.lineNo ?? '·'
      const range = head === tail ? `行 ${head}` : `行 ${head}–${tail}`
      return `<a href="#seg-${i + 1}"><b>${i + 1}</b>${range}<i>${s.changes} 处变更</i></a>`
    })
    .join('')
  return `<div class="toc"><span class="toc-title">差异分布</span><div class="toc-list">${links}</div></div>`
}

export function buildHtmlReport(rows: DiffRow[], ctx: ReportContext, summary: DiffSummary): string {
  const segs = buildSegments(rows)
  const unchanged = rows.length - summary.changedLines
  const rate = rows.length > 0 ? `${((summary.changedLines / rows.length) * 100).toFixed(1)}%` : '—'
  // 行数优先取原始文本口径（ctx 传入）：忽略空行开启时 rows 内空行被剔除、统计偏小
  const leftLines = ctx.leftLines ?? rows.filter((r) => r.left.lineNo !== null).length
  const rightLines = ctx.rightLines ?? rows.filter((r) => r.right.lineNo !== null).length
  const verdictOk = summary.changedLines === 0

  // 明细：段前折叠省略行 + 段内行（含块标题行）；最后补尾部折叠
  const bodyParts: string[] = []
  let cursor = 0
  segs.forEach((s, i) => {
    const headNo = rows[s.start].left.lineNo ?? rows[s.start].right.lineNo ?? '·'
    const tailNo = rows[s.end].left.lineNo ?? rows[s.end].right.lineNo ?? '·'
    const range = headNo === tailNo ? `行 ${headNo}` : `行 ${headNo} – ${tailNo}`
    const inner: string[] = [
      `<tr class="hunk-head"><td colspan="5">第 <b>${i + 1}</b> 块 · ${range} · ${s.changes} 处变更</td></tr>`
    ]
    if (s.skippedBefore > 0) inner.push(skipHtml(s.skippedBefore, rows.slice(cursor, s.start)))
    for (let j = s.start; j <= s.end; j++) inner.push(rowHtml(rows[j]))
    cursor = s.end + 1
    bodyParts.push(`<tbody class="hunk" id="seg-${i + 1}">\n${inner.join('\n')}\n</tbody>`)
  })
  if (segs.length > 0 && segs[segs.length - 1].skippedAfter > 0) {
    const last = segs[segs.length - 1]
    bodyParts.push(
      `<tbody class="hunk">\n${skipHtml(last.skippedAfter, rows.slice(cursor))}\n</tbody>`
    )
  }

  const emptyBody =
    rows.length === 0
      ? `<tbody><tr class="hunk-head"><td colspan="5">两侧均为空内容，没有可对比的行</td></tr></tbody>`
      : bodyParts.join('\n')

  const toc = rows.length === 0 ? '' : renderToc(rows, segs)

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DiffLens 差异报告</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <div class="hero-title">🔍 DiffLens 差异报告</div>
  <div class="hero-time">生成于 ${new Date().toLocaleString('zh-CN')}</div>
  <div class="hero-opts">比较选项：${esc(plainOptions(ctx.options, { charModePartial: ctx.charModePartial }))}</div>
  ${ctx.compareNote ? `<div class="hero-opts">对照说明：${esc(ctx.compareNote)}</div>` : ''}
  <div class="verdict${verdictOk ? ' ok' : ''}">${esc(plainSummary(summary))}</div>
  <div class="files">
    ${fileCard('left', ctx.leftName, ctx.leftEncoding, ctx.leftPath, leftLines)}
    <div class="files-arrow">➜</div>
    ${fileCard('right', ctx.rightName, ctx.rightEncoding, ctx.rightPath, rightLines)}
  </div>
  <div class="stats">
    ${statCard('ins', '新增行', `+${summary.inserted}`)}
    ${statCard('del', '删除行', `−${summary.deleted}`)}
    ${statCard('mod', '修改行', `~${summary.modified}`)}
    ${statCard('same', '未更改行', unchanged)}
    ${statCard('rate', '行变更率', rate)}
    ${
      ctx.options?.charMode
        ? statCard('rate', '字符增删', `+${summary.charsAdded} / −${summary.charsDeleted}`)
        : ''
    }
  </div>
  <div class="legend">
    <span><i class="sw add"></i>+ 新增行</span>
    <span><i class="sw del"></i>− 删除行</span>
    <span><i class="sw mod"></i>~ 修改行</span>
    <span><i class="sw word-ins"></i>绿底高亮 = 修改行里新增的文字</span>
    <span><i class="sw word-del"></i>红底删除线 = 修改行里被移除的文字</span>
  </div>
  ${toc}
</header>
<table class="diff-table">
<colgroup><col class="c-tag"><col class="c-ln"><col class="c-tx"><col class="c-ln"><col class="c-tx"></colgroup>
<thead><tr><td class="tag"></td><td class="lnl">#</td><td>左文件（原始）</td><td class="lnr">#</td><td>右文件（对比）</td></tr></thead>
${emptyBody}
</table>
<div class="foot">由 DiffLens 生成 · 相同内容段已折叠，点击可展开查看全部${ctx.version ? ` · v${esc(ctx.version)}` : ''}</div>
</div>
</body>
</html>`
}

/** ============ 纯文本报告 ============ */

/** 分块省略提示行（TXT / Markdown 共用文案）：与 HTML 折叠段同语义——段间相同行不再逐行输出 */
export const SEGMENT_SKIP_NOTE = (n: number): string => `⋯ 省略 ${n} 行相同内容 ⋯`

/** 把一段行区间渲染为 TXT 行式文本（行号右对齐共用逻辑） */
function txtSegmentLines(slice: DiffRow[], width: number): string[] {
  const out: string[] = []
  for (const row of slice) {
    const tag = typeTag(row.rowKind)
    if (row.rowKind === 'modified') {
      // 修改行：左/右并置
      const l = padNo(row.left.lineNo, width)
      const r = padNo(row.right.lineNo, width)
      out.push(`~ ${l} | ${row.left.text ?? ''}   ==>   ${r} | ${row.right.text ?? ''}`)
    } else {
      const no = padNo(row.rowKind === 'added' ? row.right.lineNo : row.left.lineNo, width)
      const text = row.rowKind === 'added' ? row.right.text : row.left.text
      out.push(`${tag} ${no} | ${text ?? ''}`)
    }
  }
  return out
}

/**
 * 纯文本报告：与 HTML 明细同款分块结构（buildSegments，上下文 3 行），
 * 段间相同行以省略提示行替代（大文件报告不再被相同行淹没，体积可控；
 * 完全一致场景无变更，单段全展示保持全量——留档语义）。
 */
export function buildTxtReport(rows: DiffRow[], ctx: ReportContext, summary: DiffSummary): string {
  const head = headLines(ctx, summary, '====== DiffLens 差异报告 ======')
  const lines = [...head, '----------------------------------']

  // 行号列宽取全部行号的最大位数，右对齐填充保证各行文本起始列一致
  let maxNo = 0
  for (const row of rows) {
    if (row.left.lineNo !== null && row.left.lineNo > maxNo) maxNo = row.left.lineNo
    if (row.right.lineNo !== null && row.right.lineNo > maxNo) maxNo = row.right.lineNo
  }
  const width = String(maxNo).length

  // 分块输出：段前省略（skippedBefore）+ 段内行；最后一段补尾部省略（skippedAfter）
  const segs = buildSegments(rows)
  for (const s of segs) {
    if (s.skippedBefore > 0) lines.push(SEGMENT_SKIP_NOTE(s.skippedBefore))
    lines.push(...txtSegmentLines(rows.slice(s.start, s.end + 1), width))
  }
  if (segs.length > 0) {
    const last = segs[segs.length - 1]
    if (last.skippedAfter > 0) lines.push(SEGMENT_SKIP_NOTE(last.skippedAfter))
  }

  lines.push('----------------------------------')
  lines.push(footLine(ctx.version))
  return lines.join('\n')
}

/** ============ Markdown 报告 ============ */

/** 单个行区间的 Markdown 表格（含表头；管道符转义与空行占位沿用既有规则） */
function mdSegmentTable(slice: DiffRow[]): string[] {
  const out: string[] = [
    '| 类型 | 左行号 | 左文件 | 右行号 | 右文件 |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const row of slice) {
    const tag = typeTag(row.rowKind)
    const lno = padNo(row.left.lineNo)
    const rno = padNo(row.right.lineNo)
    const ltext = (row.left.text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
    const rtext = (row.right.text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
    // 为空的行用占位符避免表格塌陷
    const lc = lno ? ltext : '>'
    const rc = rno ? rtext : '>'
    out.push(`| ${tag} | ${lno} | \`${lc}\` | ${rno} | \`${rc}\` |`)
  }
  return out
}

/**
 * Markdown 报告：与 HTML/TXT 同款分块结构（上下文 3 行）。
 * 段间相同行以省略提示行替代；Markdown 表格不可跨非表格行延续，
 * 故每个段独立成表（重复表头），省略行作为普通段落插在两表之间。
 */
export function buildMarkdownReport(
  rows: DiffRow[],
  ctx: ReportContext,
  summary: DiffSummary
): string {
  const head = headLines(ctx, summary, '# DiffLens 差异报告')
  // 标题独立成行（不套进引用块），其余元信息行以引用块展示
  const [title, ...meta] = head
  const out: string[] = [title, '', ...meta.map((h) => `> ${h}`), '']
  const segs = buildSegments(rows)
  segs.forEach((s, i) => {
    if (i > 0 || s.skippedBefore > 0) out.push('', '')
    if (s.skippedBefore > 0) out.push(SEGMENT_SKIP_NOTE(s.skippedBefore))
    out.push(...mdSegmentTable(rows.slice(s.start, s.end + 1)))
  })
  if (segs.length > 0) {
    const last = segs[segs.length - 1]
    if (last.skippedAfter > 0) out.push('', SEGMENT_SKIP_NOTE(last.skippedAfter))
  }
  out.push('', `> ${footLine(ctx.version)}`)
  return out.join('\n')
}

/** ============ Patch（标准 unified diff）报告 ============ */

/**
 * Patch 是否可从当前行集生成：判等类比较选项（忽略大小写/所有空白/字符级等）会把
 * 两侧实际不同的文本判为 unchanged（上下文行），unified diff 的上下文行必须双侧一致，
 * 否则产出的 patch 无法正确应用。逐行扫描精确判定——碰巧未触发判等差异的场景仍可导出。
 */
export function canBuildPatch(rows: DiffRow[]): boolean {
  for (const r of rows) {
    if (!r.isChanged && r.left.text !== r.right.text) return false
  }
  return true
}

/** 侧文本：unchanged 行两侧一致（canBuildPatch 已保证非污染；空槽行取非空侧） */
const ctxText = (row: DiffRow): string => row.left.text ?? row.right.text ?? ''

/**
 * 标准 unified diff 报告（git diff 风格，可直接 git apply / patch 消费）：
 * - 文件头 `--- a/{名}` / `+++ b/{名}`（优先完整路径，粘贴文本用显示名）；
 * - 每个差异分块（buildSegments，上下文 3 行）一个 hunk：`@@ -l,c +l,c @@`；
 * - modified 行展开为 `-旧` `+新` 两行，removed/added 单行 `-`/`+`，unchanged 为上下文行；
 * - 无变更 / 两侧空内容时仅输出文件头（空 diff）；
 * - 尾部无换行按 unified diff 惯例输出 `\ No newline at end of file`
 *   （原文本是否以换行结尾的信息由调用方经 tail 传入，DiffRow 不携带）。
 */
export function buildPatchReport(
  rows: DiffRow[],
  ctx: ReportContext,
  tail?: { leftNoNewline?: boolean; rightNoNewline?: boolean }
): string {
  const l = ctx.leftPath ?? ctx.leftName ?? 'left'
  const r = ctx.rightPath ?? ctx.rightName ?? 'right'
  const out: string[] = [`--- a/${l}`, `+++ b/${r}`]

  // 段内行序列：每行记录来源侧（L=旧/R=新），供尾部无换行标记定位；
  // modified 行展开为 -旧/+新 两行，body 与 rows 索引不一一对应，经 rowBodyStart 映射
  interface BodyLine {
    out: string
    fromLeft: boolean
    fromRight: boolean
  }
  const body: BodyLine[] = []
  /** rows[i] 在 body 中的起始索引 */
  const rowBodyStart: number[] = []
  for (const row of rows) {
    rowBodyStart.push(body.length)
    if (row.rowKind === 'unchanged') {
      body.push({ out: ` ${ctxText(row)}`, fromLeft: true, fromRight: true })
    } else if (row.rowKind === 'removed') {
      body.push({ out: `-${row.left.text ?? ''}`, fromLeft: true, fromRight: false })
    } else if (row.rowKind === 'added') {
      body.push({ out: `+${row.right.text ?? ''}`, fromLeft: false, fromRight: true })
    } else {
      // modified：旧文本行在前、新文本行在后（unified diff 惯例）
      body.push({ out: `-${row.left.text ?? ''}`, fromLeft: true, fromRight: false })
      body.push({ out: `+${row.right.text ?? ''}`, fromLeft: false, fromRight: true })
    }
  }
  /** rows[i] 的 body 结束索引（不含） */
  const bodyEndOfRow = (i: number): number =>
    i + 1 < rows.length ? rowBodyStart[i + 1] : body.length

  // 尾部无换行标记位置：每侧最后一个来源行之后（预计算避免逐行回扫）
  let lastLeftIdx = -1
  let lastRightIdx = -1
  body.forEach((b, i) => {
    if (b.fromLeft) lastLeftIdx = i
    if (b.fromRight) lastRightIdx = i
  })

  // 按 hunk 输出：每段计算双侧起始行号与行数（行号取段内首个非空槽；count 为 0 时
  // start 按惯例指向前一行的插入位置——此处取 0，覆盖文件开头新增的常见场景）；
  // 无变更段（完全一致场景的单段全展示）不输出 hunk——与 git diff 空输出一致
  const segs = buildSegments(rows)
  for (const s of segs) {
    if (s.changes === 0) continue
    const slice = rows.slice(s.start, s.end + 1)
    const leftNos = slice.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rightNos = slice.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    const lStart = leftNos.length > 0 ? leftNos[0] : 0
    const rStart = rightNos.length > 0 ? rightNos[0] : 0
    out.push(`@@ -${lStart},${leftNos.length} +${rStart},${rightNos.length} @@`)
    for (let i = rowBodyStart[s.start]; i < bodyEndOfRow(s.end); i++) {
      const b = body[i]
      out.push(b.out)
      if (tail?.leftNoNewline && i === lastLeftIdx) out.push('\\ No newline at end of file')
      if (tail?.rightNoNewline && i === lastRightIdx) out.push('\\ No newline at end of file')
    }
  }
  return out.join('\n')
}

/** 按格式生成报告字符串 */
export function buildReport(
  rows: DiffRow[],
  ctx: ReportContext,
  summary: DiffSummary,
  format: ReportFormat,
  tail?: { leftNoNewline?: boolean; rightNoNewline?: boolean }
): string {
  if (format === 'html') return buildHtmlReport(rows, ctx, summary)
  if (format === 'txt') return buildTxtReport(rows, ctx, summary)
  if (format === 'md') return buildMarkdownReport(rows, ctx, summary)
  return buildPatchReport(rows, ctx, tail)
}

export const REPORT_EXT: Record<ReportFormat, string> = {
  html: 'html',
  txt: 'txt',
  md: 'md',
  patch: 'patch'
}
