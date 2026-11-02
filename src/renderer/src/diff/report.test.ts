import { describe, it, expect } from 'vitest'
import { computeDiff, type DiffRow } from './diffEngine'
import {
  buildHtmlReport,
  buildTxtReport,
  buildMarkdownReport,
  buildPatchReport,
  canBuildPatch,
  buildReport,
  buildSegments,
  plainSummary,
  plainOptions,
  REPORT_EXT
} from './report'

const ctx = { leftName: 'a.txt', rightName: 'b.txt', leftEncoding: 'UTF-8', rightEncoding: 'UTF-8' }

/** 便捷构造行集：u=unchanged, a=added, r=removed, m=modified */
function rowsOf(kinds: string[]): DiffRow[] {
  let n = 0
  return kinds.map((k) => {
    const id = `t${n++}`
    const changed = k !== 'u'
    const left = { lineNo: k === 'a' ? null : n, text: k === 'a' ? null : `L${n}`, segs: null }
    const right = { lineNo: k === 'r' ? null : n, text: k === 'r' ? null : `R${n}`, segs: null }
    return {
      id,
      rowKind: (k === 'a'
        ? 'added'
        : k === 'r'
          ? 'removed'
          : k === 'm'
            ? 'modified'
            : 'unchanged') as DiffRow['rowKind'],
      isChanged: changed,
      left,
      right
    }
  })
}

describe('buildSegments - 差异分块', () => {
  it('空行集返回空段', () => {
    expect(buildSegments([])).toEqual([])
  })

  it('无任何变更时单段全展示且无省略', () => {
    const segs = buildSegments(rowsOf(['u', 'u', 'u', 'u']))
    expect(segs).toEqual([{ start: 0, end: 3, changes: 0, skippedBefore: 0, skippedAfter: 0 }])
  })

  it('单处居中变更保留前后 3 行上下文，其余省略', () => {
    const rows = rowsOf(['u', 'u', 'u', 'u', 'u', 'm', 'u', 'u', 'u', 'u', 'u'])
    const segs = buildSegments(rows)
    expect(segs).toEqual([{ start: 2, end: 8, changes: 1, skippedBefore: 2, skippedAfter: 2 }])
  })

  it('变更在开头/结尾时区间收敛到边界', () => {
    const rows = rowsOf(['m', 'u', 'u', 'u', 'u', 'm'])
    const segs = buildSegments(rows)
    expect(segs).toEqual([{ start: 0, end: 5, changes: 2, skippedBefore: 0, skippedAfter: 0 }])
  })

  it('相近变更（间距不超过 2×context+1）合并为同段', () => {
    const rows = rowsOf(['u', 'u', 'u', 'u', 'u', 'm', 'u', 'u', 'u', 'm', 'u', 'u', 'u', 'u'])
    // 变更 5 与 9：区间 [2,8] 与 [6,12] 重叠 → 单段 [2,12]
    const segs = buildSegments(rows)
    expect(segs).toHaveLength(1)
    expect(segs[0].start).toBe(2)
    expect(segs[0].end).toBe(12)
    expect(segs[0].changes).toBe(2)
  })

  it('远距变更分为两段，段间省略数正确', () => {
    const kinds = Array.from({ length: 30 }, () => 'u')
    kinds[2] = 'm'
    kinds[20] = 'm'
    const segs = buildSegments(rowsOf(kinds))
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ start: 0, end: 5, changes: 1, skippedBefore: 0 })
    expect(segs[1]).toMatchObject({
      start: 17,
      end: 23,
      changes: 1,
      skippedBefore: 11,
      skippedAfter: 6
    })
  })

  it('自定义 context=0 时仅展示变更行本身', () => {
    const rows = rowsOf(['u', 'u', 'u', 'm', 'u', 'u'])
    const segs = buildSegments(rows, 0)
    expect(segs).toEqual([{ start: 3, end: 3, changes: 1, skippedBefore: 3, skippedAfter: 2 }])
  })
})

describe('plainSummary - 人话总结', () => {
  it('无差异时给出一致结论', () => {
    expect(
      plainSummary({
        changedLines: 0,
        inserted: 0,
        deleted: 0,
        modified: 0,
        charsAdded: 0,
        charsDeleted: 0
      })
    ).toBe('两文件内容完全一致')
  })

  it('为 0 的项被省略', () => {
    expect(
      plainSummary({
        changedLines: 2,
        inserted: 2,
        deleted: 0,
        modified: 0,
        charsAdded: 5,
        charsDeleted: 0
      })
    ).toBe('共 2 处不同：新增 2 行')
  })

  it('三类变更齐全时完整罗列', () => {
    expect(
      plainSummary({
        changedLines: 9,
        inserted: 4,
        deleted: 3,
        modified: 2,
        charsAdded: 10,
        charsDeleted: 8
      })
    ).toBe('共 9 处不同：新增 4 行、删除 3 行、修改 2 行')
  })
})

describe('buildHtmlReport', () => {
  const { rows, summary } = computeDiff('line1\nline2', 'line1\nline3')

  it('输出合法 HTML 文档并包含核心信息', () => {
    const html = buildHtmlReport(rows, ctx, summary)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('DiffLens 差异报告')
    expect(html).toContain('a.txt')
    expect(html).toContain('b.txt')
  })

  it('Hero 区包含人话结论、文件卡与统计卡', () => {
    const html = buildHtmlReport(rows, ctx, summary)
    expect(html).toContain('共 1 处不同：修改 1 行')
    expect(html).toContain('class="verdict"')
    expect(html).toContain('file-card left')
    expect(html).toContain('file-card right')
    expect(html).toContain('stat ins')
    expect(html).toContain('stat rate')
  })

  it('包含差异统计与类型高亮语义', () => {
    const html = buildHtmlReport(rows, ctx, summary)
    expect(html).toContain('modified')
    expect(html).toContain('hunk-head')
  })

  it('内容完全一致时显示绿色一致结论', () => {
    const { rows, summary } = computeDiff('same', 'same')
    const html = buildHtmlReport(rows, ctx, summary)
    expect(html).toContain('两文件内容完全一致')
    expect(html).toContain('verdict ok')
  })

  it('多差异块时渲染目录锚点，单块时不渲染目录', () => {
    const left = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const right = left.replace('l2', 'X').replace('l16', 'Y')
    const multi = computeDiff(left, right)
    const html = buildHtmlReport(multi.rows, ctx, multi.summary)
    expect(html).toContain('toc-list')
    expect(html).toContain('href="#seg-2"')

    const single = computeDiff('a', 'b')
    const singleHtml = buildHtmlReport(single.rows, ctx, single.summary)
    expect(singleHtml).not.toContain('href="#seg-')
  })

  it('大段相同内容以折叠行呈现且保留全量数据', () => {
    const left = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
    const right = left.replace('l20', 'X')
    const { rows, summary } = computeDiff(left, right)
    const html = buildHtmlReport(rows, ctx, summary)
    expect(html).toContain('<details><summary>⋯ 相同内容')
    // 折叠段内仍包含被省略行的数据（信息零丢失）
    expect(html).toContain('l0')
    expect(html).toContain('l39')
  })

  it('两侧均为空时给出空内容提示', () => {
    const { rows, summary } = computeDiff('', '')
    const html = buildHtmlReport(rows, ctx, summary)
    expect(html).toContain('没有可对比的行')
  })
})

describe('plainOptions - 比较选项描述', () => {
  it('未传或空选项时说明为严格对比', () => {
    expect(plainOptions(undefined)).toBe('无（严格逐字符对比）')
    expect(plainOptions({})).toBe('无（严格逐字符对比）')
  })

  it('列出全部生效选项', () => {
    expect(
      plainOptions({ ignoreAllWhitespace: true, ignoreCase: true, ignoreBlankLines: true })
    ).toBe('忽略所有空白、忽略大小写、忽略空行')
    expect(plainOptions({ trimWhitespace: true, ignoreCase: true })).toBe(
      '忽略行首尾空白、忽略大小写'
    )
  })

  it('忽略所有空白遮蔽行首尾空白（超集不重复列出）', () => {
    expect(plainOptions({ ignoreAllWhitespace: true, trimWhitespace: true })).toBe('忽略所有空白')
  })

  it('字符级对比单独描述并遮蔽全部空白类选项', () => {
    expect(
      plainOptions({
        charMode: true,
        trimWhitespace: true,
        ignoreAllWhitespace: true,
        ignoreBlankLines: true
      })
    ).toBe('字符级对比（忽略全部空白与换行，大内容自动分块计算，预算随规模自适应）')
  })

  it('字符级对比与忽略大小写组合列出', () => {
    expect(plainOptions({ charMode: true, ignoreCase: true })).toBe(
      '字符级对比（忽略全部空白与换行，大内容自动分块计算，预算随规模自适应）、忽略大小写'
    )
  })

  it('字符级部分降级时描述标注部分块按行级对比', () => {
    expect(plainOptions({ charMode: true }, { charModePartial: true })).toBe(
      '字符级对比（忽略全部空白与换行；部分差异过大的块按行级对比）'
    )
    expect(plainOptions({ charMode: true, ignoreCase: true }, { charModePartial: true })).toBe(
      '字符级对比（忽略全部空白与换行；部分差异过大的块按行级对比）、忽略大小写'
    )
    // 未开启字符级时 partial 参数无效果
    expect(plainOptions({}, { charModePartial: true })).toBe('无（严格逐字符对比）')
  })
})

describe('报告头部比较选项说明', () => {
  const { rows, summary } = computeDiff('a b', 'ab', { ignoreAllWhitespace: true })
  const optCtx = {
    ...ctx,
    options: { ignoreAllWhitespace: true, ignoreCase: true }
  }

  it('纯文本头部包含比较选项行', () => {
    const txt = buildTxtReport(rows, optCtx, summary)
    expect(txt).toContain('比较选项：忽略所有空白、忽略大小写')
  })

  it('Markdown 头部包含比较选项行（引用块内）', () => {
    const md = buildMarkdownReport(rows, optCtx, summary)
    expect(md).toContain('> 比较选项：忽略所有空白、忽略大小写')
  })

  it('HTML Hero 区包含比较选项徽标', () => {
    const html = buildHtmlReport(rows, optCtx, summary)
    expect(html).toContain('hero-opts')
    expect(html).toContain('比较选项：忽略所有空白、忽略大小写')
  })

  it('未传选项时头部说明为严格对比', () => {
    const txt = buildTxtReport(rows, ctx, summary)
    expect(txt).toContain('比较选项：无（严格逐字符对比）')
  })
})

describe('buildTxtReport', () => {
  it('输出带增删改标记与人话结论的行式文本', () => {
    const { rows, summary } = computeDiff('a', 'a\nb')
    const txt = buildTxtReport(rows, ctx, summary)
    expect(txt).toContain('DiffLens')
    expect(txt).toContain('+')
    expect(txt).toContain('结论：共 1 处不同：新增 1 行')
  })

  it('字符级模式的统计行追加字符粒度统计；行级模式不追加（0.10.5）', () => {
    // 引擎用行级路径构造（词级 world↔moon：+4/−5 码点），报告层按 ctx.options.charMode 决定是否展示
    const { rows, summary } = computeDiff('hello world', 'hello moon')
    expect(summary.charsAdded).toBe(4)
    expect(summary.charsDeleted).toBe(5)
    const txt = buildTxtReport(rows, { ...ctx, options: { charMode: true } }, summary)
    expect(txt).toContain('变更统计：新增 0 ｜ 删除 0 ｜ 修改 1 ｜ 字符 +4 / −5')
    // HTML 统计卡同步追加
    const html = buildHtmlReport(rows, { ...ctx, options: { charMode: true } }, summary)
    expect(html).toContain('字符增删')
    expect(html).toContain('+4 / −5')
    // Markdown 头部引用块同步
    const md = buildMarkdownReport(rows, { ...ctx, options: { charMode: true } }, summary)
    expect(md).toContain('> 变更统计：新增 0 ｜ 删除 0 ｜ 修改 1 ｜ 字符 +4 / −5')
    // 行级模式（未传 options）不含字符统计
    const plain = buildTxtReport(rows, ctx, summary)
    expect(plain).toContain('变更统计：新增 0 ｜ 删除 0 ｜ 修改 1\n')
    expect(plain).not.toContain('字符 +')
  })

  it('行号按最大位数右对齐填充', () => {
    const left = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')
    const right = left.replace('l1', 'changed')
    const { rows, summary } = computeDiff(left, right)
    const txt = buildTxtReport(rows, ctx, summary)
    // 最大行号 12 → 宽度 2：行号 2 左补空格（修改行左右行号同样填充）
    expect(txt).toContain('~  2 | l1   ==>    2 | changed')
    // 段外相同行按分块省略：上下文 3 行展示 l0..l4，尾部省略 l5..l11 共 7 行
    expect(txt).toContain('⋯ 省略 7 行相同内容 ⋯')
  })

  it('行号位数一致时无额外填充', () => {
    const { rows, summary } = computeDiff('a\nc', 'a\nb')
    const txt = buildTxtReport(rows, ctx, summary)
    expect(txt).toContain('~ 2 | c   ==>   2 | b')
  })
})

describe('buildMarkdownReport', () => {
  it('输出表格化报告，标题独立成行不进引用块', () => {
    const { rows, summary } = computeDiff('a', 'b')
    const md = buildMarkdownReport(rows, ctx, summary)
    expect(md.startsWith('# DiffLens 差异报告')).toBe(true)
    expect(md).not.toContain('> # DiffLens 差异报告')
    expect(md).toContain('| 类型 |')
    expect(md).toContain('| 左行号 |')
  })

  it('引用块包含人话结论', () => {
    const { rows, summary } = computeDiff('a', 'b')
    const md = buildMarkdownReport(rows, ctx, summary)
    expect(md).toContain('> 结论：共 1 处不同：修改 1 行')
  })

  it('管道符被转义以保持表格结构', () => {
    const { rows, summary } = computeDiff('a|b', 'a')
    const md = buildMarkdownReport(rows, ctx, summary)
    expect(md).toContain('a\\|b')
  })
})

describe('buildReport / REPORT_EXT', () => {
  it('按格式分发', () => {
    const { rows, summary } = computeDiff('x', 'y')
    expect(buildReport(rows, ctx, summary, 'html')).toContain('<!doctype html>')
    expect(buildReport(rows, ctx, summary, 'txt')).toContain('DiffLens')
    expect(buildReport(rows, ctx, summary, 'md')).toContain('# DiffLens 差异报告')
    expect(buildReport(rows, ctx, summary, 'patch')).toContain('@@ ')
  })

  it('扩展名映射正确', () => {
    expect(REPORT_EXT.html).toBe('html')
    expect(REPORT_EXT.txt).toBe('txt')
    expect(REPORT_EXT.md).toBe('md')
    expect(REPORT_EXT.patch).toBe('patch')
  })
})

describe('TXT / Markdown 分块省略（0.11.0）', () => {
  /** 30 行文件两处远距修改：分两段，段间 11 行相同省略（与 buildSegments 既有用例同构） */
  const makeRows = (): ReturnType<typeof computeDiff> => {
    const kinds = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const right = [...kinds]
    right[2] = 'X2'
    right[20] = 'X20'
    return computeDiff(kinds.join('\n'), right.join('\n'))
  }

  it('TXT：段间相同行以省略提示行替代，段内行保留', () => {
    const { rows, summary } = makeRows()
    const txt = buildTxtReport(rows, ctx, summary)
    expect(txt).toContain('⋯ 省略 11 行相同内容 ⋯')
    // 段内上下文行保留（变更 l2 的上下文 l0..l5）
    expect(txt).toContain('| l0')
    expect(txt).toContain('| l5')
    // 省略段内的行不再逐行输出
    expect(txt).not.toContain('| l10')
  })

  it('TXT：完全一致场景保持全量展示（留档语义，无省略）', () => {
    const { rows, summary } = computeDiff('a\nb\nc', 'a\nb\nc')
    const txt = buildTxtReport(rows, ctx, summary)
    expect(txt).toContain('| a')
    expect(txt).toContain('| c')
    expect(txt).not.toContain('省略')
  })

  it('Markdown：段间省略提示行 + 每段独立表格（重复表头）', () => {
    const { rows, summary } = makeRows()
    const md = buildMarkdownReport(rows, ctx, summary)
    expect(md).toContain('⋯ 省略 11 行相同内容 ⋯')
    // 两段 → 表头出现两次
    expect(md.split('| 类型 | 左行号 | 左文件 | 右行号 | 右文件 |').length).toBe(3)
    // 省略段内的行不进表格
    expect(md).not.toContain('`l10`')
  })

  it('Markdown：单段场景仅一个表格（回归锚）', () => {
    const { rows, summary } = computeDiff('a', 'b')
    const md = buildMarkdownReport(rows, ctx, summary)
    expect(md.split('| 类型 | 左行号 | 左文件 | 右行号 | 右文件 |').length).toBe(2)
    expect(md).not.toContain('省略')
  })
})

describe('buildPatchReport - 标准 unified diff（0.11.0）', () => {
  it('输出文件头与 hunk 头，modified 行展开为 -旧/+新，unchanged 为上下文行', () => {
    const { rows } = computeDiff('line1\nline2\nline3', 'line1\nLINE2\nline3')
    const patch = buildPatchReport(rows, ctx)
    const lines = patch.split('\n')
    expect(lines[0]).toBe('--- a/a.txt')
    expect(lines[1]).toBe('+++ b/b.txt')
    // 单处修改：一个 hunk，起始行号 1（上下文 line1 在前）
    expect(patch).toContain('@@ -1,3 +1,3 @@')
    expect(lines).toContain(' line1')
    expect(lines).toContain('-line2')
    expect(lines).toContain('+LINE2')
    expect(lines).toContain(' line3')
  })

  it('多段差异输出多个 hunk，行号各自锚定', () => {
    const kinds = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const right = [...kinds]
    right[2] = 'X2'
    right[20] = 'X20'
    const { rows } = computeDiff(kinds.join('\n'), right.join('\n'))
    const patch = buildPatchReport(rows, ctx)
    const hunks = patch.split('\n').filter((l) => l.startsWith('@@'))
    expect(hunks).toHaveLength(2)
    // 第一段 [0,5]：左行号 1..6；第二段 [17,23]：左行号 18..24
    expect(hunks[0]).toBe('@@ -1,6 +1,6 @@')
    expect(hunks[1]).toBe('@@ -18,7 +18,7 @@')
  })

  it('整行增删：added 输出 + 行、removed 输出 - 行', () => {
    const { rows } = computeDiff('a\nb', 'a\nc\nd')
    const patch = buildPatchReport(rows, ctx)
    const lines = patch.split('\n')
    expect(lines).toContain('-b')
    expect(lines).toContain('+c')
    expect(lines).toContain('+d')
    // 纯删除行（未与新增配对）：removed 单行输出 -，上下文行原样
    const del = computeDiff('a\nb\nc', 'a\nc\nd')
    const delLines = buildPatchReport(del.rows, ctx).split('\n')
    expect(delLines).toContain('-b')
    expect(delLines).toContain(' a')
    expect(delLines).toContain(' c')
    expect(delLines).toContain('+d')
  })

  it('尾部无换行：按 unified diff 惯例输出标记行', () => {
    const { rows } = computeDiff('a\nb', 'a\nB')
    const patch = buildPatchReport(rows, ctx, { leftNoNewline: true, rightNoNewline: true })
    const lines = patch.split('\n')
    // 左右两侧末行均无换行：-b 与 +B 之后各跟一条标记
    expect(lines[lines.indexOf('-b') + 1]).toBe('\\ No newline at end of file')
    expect(lines[lines.indexOf('+B') + 1]).toBe('\\ No newline at end of file')
  })

  it('仅一侧尾部无换行时只输出该侧标记', () => {
    const { rows } = computeDiff('a\nb', 'a\nB')
    const patch = buildPatchReport(rows, ctx, { rightNoNewline: true })
    expect(patch).toContain('\\ No newline at end of file')
    // 标记紧跟 +B（最后一个右侧来源行）且全文仅一条
    const lines = patch.split('\n')
    expect(lines[lines.indexOf('+B') + 1]).toBe('\\ No newline at end of file')
    expect(lines.filter((l) => l === '\\ No newline at end of file')).toHaveLength(1)
  })

  it('无变更时仅输出文件头（空 diff）', () => {
    const { rows } = computeDiff('same', 'same')
    const patch = buildPatchReport(rows, ctx)
    expect(patch).toBe('--- a/a.txt\n+++ b/b.txt')
  })

  it('文件头使用共同父目录下的相对路径，不输出绝对路径', () => {
    const { rows } = computeDiff('a', 'b')
    const patch = buildPatchReport(rows, {
      ...ctx,
      leftPath: 'C:\\work\\old.txt',
      rightPath: 'C:/work/new.txt'
    })
    expect(patch).toContain('--- a/old.txt')
    expect(patch).toContain('+++ b/new.txt')
    expect(patch).not.toContain('C:/work')
  })

  it('嵌套目录保留共同父目录之后的相对路径', () => {
    const { rows } = computeDiff('a', 'b')
    const patch = buildPatchReport(rows, {
      ...ctx,
      leftPath: '/repo/src/old.txt',
      rightPath: '/repo/src/sub/new.txt'
    })
    expect(patch).toContain('--- a/old.txt')
    expect(patch).toContain('+++ b/sub/new.txt')
  })

  it('不同盘/不同根回退文件名，避免把绝对路径写进 patch', () => {
    const { rows } = computeDiff('a', 'b')
    const patch = buildPatchReport(rows, {
      ...ctx,
      leftPath: 'C:/left/old.txt',
      rightPath: 'D:/right/new.txt'
    })
    expect(patch).toContain('--- a/old.txt')
    expect(patch).toContain('+++ b/new.txt')
    expect(patch).not.toContain('C:/left')
    expect(patch).not.toContain('D:/right')
  })
})

describe('canBuildPatch - 判等污染判定（0.11.0）', () => {
  it('严格对比下的行集恒可导出', () => {
    const { rows } = computeDiff('a\nb\nc', 'a\nB\nc')
    expect(canBuildPatch(rows)).toBe(true)
  })

  it('忽略大小写把不同文本判为相同时不可导出', () => {
    const { rows } = computeDiff('a\nb\nc', 'a\nB\nc', { ignoreCase: true })
    expect(canBuildPatch(rows)).toBe(false)
  })

  it('判等选项开启但未触发实际判等差异时仍可导出', () => {
    // 差异行 real 与 REAL 在忽略大小写下仍不同；相同行文本一致 → 无污染
    const { rows } = computeDiff('same\nreal diff', 'same\nreal diff x', { ignoreCase: true })
    expect(canBuildPatch(rows)).toBe(true)
  })

  it('字符级跨行重组判等的行集不可导出（上下文行两侧文本不同）', () => {
    const { rows } = computeDiff('ab cd', 'ab\ncd', { charMode: true })
    expect(canBuildPatch(rows)).toBe(false)
  })

  it('完全一致的空变更行集可导出', () => {
    const { rows } = computeDiff('same', 'same')
    expect(canBuildPatch(rows)).toBe(true)
  })

  it('忽略空行导致行号不连续时不可导出（hunk 计数会错位）', () => {
    const { rows } = computeDiff('a\n\nb', 'a\n\nB', { ignoreBlankLines: true })
    // rows 为 a(1) 与 b/B(3)，空行被剔除；patch 无法表达省略的行
    expect(canBuildPatch(rows)).toBe(false)
  })

  it('忽略空行但文件中没有空行时仍可导出', () => {
    const { rows } = computeDiff('a\nb', 'a\nB', { ignoreBlankLines: true })
    expect(canBuildPatch(rows)).toBe(true)
  })
})

describe('报告元信息增强（0.11.0）', () => {
  const { rows, summary } = computeDiff('a', 'b')

  it('版本号进入三格式尾部署名（未提供时保持历史格式）', () => {
    const vCtx = { ...ctx, version: '0.11.0' }
    expect(buildTxtReport(rows, vCtx, summary)).toContain('生成于 DiffLens v0.11.0')
    expect(buildMarkdownReport(rows, vCtx, summary)).toContain('> 生成于 DiffLens v0.11.0')
    expect(buildHtmlReport(rows, vCtx, summary)).toContain('v0.11.0')
    // 未提供时与历史格式一致（回归锚）
    expect(buildTxtReport(rows, ctx, summary)).toContain('生成于 DiffLens')
    expect(buildTxtReport(rows, ctx, summary)).not.toContain('v0.')
  })

  it('对照说明进入头部（TXT/MD/HTML 三格式）', () => {
    const nCtx = { ...ctx, compareNote: '左侧为快照基线（保存于 2026/8/20），右侧为当前文件' }
    expect(buildTxtReport(rows, nCtx, summary)).toContain(
      '对照说明：左侧为快照基线（保存于 2026/8/20），右侧为当前文件'
    )
    expect(buildMarkdownReport(rows, nCtx, summary)).toContain('> 对照说明：左侧为快照基线')
    expect(buildHtmlReport(rows, nCtx, summary)).toContain('对照说明：')
    // 未提供时无该行（回归锚）
    expect(buildTxtReport(rows, ctx, summary)).not.toContain('对照说明')
  })

  it('HTML 文件卡行数优先取原始文本口径（ctx.leftLines）', () => {
    // 原始文本 3 行；ctx 声明 3 行时文件卡用 3（rows 口径在忽略空行时会偏小）
    const lCtx = { ...ctx, leftLines: 3, rightLines: 5 }
    const html = buildHtmlReport(rows, lCtx, summary)
    expect(html).toContain('3 行')
    expect(html).toContain('5 行')
  })
})
