import { describe, it, expect } from 'vitest'
import type { FolderEntry } from '../../../preload/index'
import { buildFolderReport, countFolderStats, fmtSize, plainFolderSummary } from './folderReport'
import { diffSnapshot } from './snapshotDiff'

const ENTRIES: FolderEntry[] = [
  { rel: 'a.txt', status: 'same', leftSize: 5, rightSize: 5 },
  { rel: 'sem.txt', status: 'semantic-same', leftSize: 5, rightSize: 6 },
  { rel: 'b.txt', status: 'different', leftSize: 3, rightSize: 9 },
  { rel: 'only-l.txt', status: 'left-only', leftSize: 1, rightSize: null },
  { rel: 'sub/only-r.ts', status: 'right-only', leftSize: null, rightSize: 7 }
]

const CTX = { leftDir: 'C:/left', rightDir: 'D:/right', semantic: true, truncated: false, total: 5 }

describe('countFolderStats', () => {
  it('六类状态计数正确', () => {
    expect(
      countFolderStats([
        ...ENTRIES,
        { rel: 'locked.txt', status: 'unreadable' as const, leftSize: 1, rightSize: 1 }
      ])
    ).toEqual({
      same: 1,
      semanticSame: 1,
      different: 1,
      leftOnly: 1,
      rightOnly: 1,
      unreadable: 1
    })
  })

  it('空条目集全部为零', () => {
    expect(countFolderStats([])).toEqual({
      same: 0,
      semanticSame: 0,
      different: 0,
      leftOnly: 0,
      rightOnly: 0,
      unreadable: 0
    })
  })
})

describe('fmtSize - 人类可读文件大小', () => {
  it('null 占位为 —', () => {
    expect(fmtSize(null)).toBe('—')
  })

  it('B / KB / MB / GB / TB 各档正确换算（含边界值）', () => {
    expect(fmtSize(0)).toBe('0 B')
    expect(fmtSize(1023)).toBe('1023 B')
    expect(fmtSize(1024)).toBe('1.0 KB')
    expect(fmtSize(1024 * 1024)).toBe('1.0 MB')
    expect(fmtSize(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(fmtSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
    expect(fmtSize(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB')
    expect(fmtSize(1.5 * 1024 * 1024 * 1024 * 1024)).toBe('1.5 TB')
  })

  it('GB 级文件不再显示为 1024.0 MB（0.10.3 修复锚）', () => {
    // 文件夹对比无单文件大小上限，GB 级文件（视频/镜像）大小字段照常显示
    expect(fmtSize(500 * 1024 * 1024 * 1024)).toBe('500.0 GB')
    expect(fmtSize(1024 * 1024 * 1024)).not.toBe('1024.0 MB')
  })

  it('TB 级文件不再显示为 1024.0 GB（0.10.4 档位延续修复锚）', () => {
    // TB 级（虚拟机镜像/备份归档）与 GB 修复同源：大小字段照常显示，档位逐级补全
    expect(fmtSize(3 * 1024 * 1024 * 1024 * 1024)).toBe('3.0 TB')
    expect(fmtSize(1024 * 1024 * 1024 * 1024)).not.toBe('1024.0 GB')
  })
})

describe('plainFolderSummary', () => {
  it('空文件夹给出无文件结论', () => {
    expect(plainFolderSummary(countFolderStats([]), 0)).toBe('两个文件夹内都没有文件')
  })

  it('完全一致（无语义同）', () => {
    const stats = countFolderStats([{ rel: 'a', status: 'same', leftSize: 1, rightSize: 1 }])
    expect(plainFolderSummary(stats, 1)).toBe('两文件夹内容完全一致')
  })

  it('完全一致但有语义同时附加说明', () => {
    const stats = countFolderStats([
      { rel: 'a', status: 'same', leftSize: 1, rightSize: 1 },
      { rel: 'b', status: 'semantic-same', leftSize: 1, rightSize: 2 }
    ])
    expect(plainFolderSummary(stats, 2)).toBe(
      '两文件夹内容完全一致（其中 1 个文件仅空白/换行差异）'
    )
  })

  it('存在差异时完整罗列并附语义同说明', () => {
    const s = countFolderStats(ENTRIES)
    expect(plainFolderSummary(s, ENTRIES.length)).toBe(
      '共 3 个文件存在差异：内容不同 1 个、仅左侧 1 个、仅右侧 1 个（另有 1 个仅空白/换行差异，不计入不同）'
    )
  })

  it('无语义同时不附加说明', () => {
    const stats = countFolderStats([{ rel: 'b', status: 'different', leftSize: 1, rightSize: 2 }])
    expect(plainFolderSummary(stats, 1)).toBe('共 1 个文件存在差异：内容不同 1 个')
  })
})

describe('buildFolderReport - HTML', () => {
  it('输出合法文档并包含目录、统计与条目明细', () => {
    const html = buildFolderReport(ENTRIES, CTX, 'html')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('DiffLens 文件夹对比报告')
    expect(html).toContain('C:/left')
    expect(html).toContain('D:/right')
    expect(html).toContain('判定口径：语义判等开启')
    expect(html).toContain('共 3 个文件存在差异')
    expect(html).toContain('sub/only-r.ts')
    expect(html).toContain('st-sem')
    expect(html).toContain('语义同')
  })

  it('语义关闭时判定口径为字节级严格比对', () => {
    const html = buildFolderReport(ENTRIES, { ...CTX, semantic: false }, 'html')
    expect(html).toContain('判定口径：字节级严格比对')
  })

  it('截断时输出警示行', () => {
    const html = buildFolderReport(ENTRIES, { ...CTX, truncated: true, total: 9999 }, 'html')
    expect(html).toContain('文件数量超出上限')
    expect(html).toContain('9999')
  })

  it('空条目集给出空提示', () => {
    const html = buildFolderReport([], { ...CTX, total: 0 }, 'html')
    expect(html).toContain('两个文件夹内都没有文件')
  })

  it('完全一致时 verdict 为绿色（ok）', () => {
    const html = buildFolderReport(
      [{ rel: 'a', status: 'same', leftSize: 1, rightSize: 1 }],
      CTX,
      'html'
    )
    expect(html).toContain('verdict ok')
    expect(html).toContain('两文件夹内容完全一致')
  })

  it('approximate 条目渲染 ≈ 标注', () => {
    const html = buildFolderReport(
      [{ rel: 'big.bin', status: 'same', leftSize: 1, rightSize: 1, approximate: true }],
      CTX,
      'html'
    )
    expect(html).toContain('≈')
  })
})

describe('buildFolderReport - 纯文本', () => {
  it('头部包含目录/口径/结论/统计，条目行含状态与大小', () => {
    const txt = buildFolderReport(ENTRIES, CTX, 'txt')
    expect(txt).toContain('====== DiffLens 文件夹对比报告 ======')
    expect(txt).toContain('左侧目录：C:/left')
    expect(txt).toContain('判定口径：语义判等开启')
    expect(txt).toContain('结论：共 3 个文件存在差异')
    expect(txt).toContain('相同 1 ｜ 语义同 1 ｜ 不同 1 ｜ 仅左 1 ｜ 仅右 1 ｜ 共 5 项')
    expect(txt).toContain('sub/only-r.ts')
    expect(txt).toContain('语义同')
    expect(txt).toContain('仅左侧')
  })

  it('超长路径截断对齐（宽度封顶 60）', () => {
    const longRel = `${'d'.repeat(80)}.txt`
    const txt = buildFolderReport(
      [{ rel: longRel, status: 'same', leftSize: 1, rightSize: 1 }],
      CTX,
      'txt'
    )
    expect(txt).toContain('…')
    expect(txt).not.toContain('d'.repeat(80))
  })

  it('截断时输出警示行', () => {
    const txt = buildFolderReport(ENTRIES, { ...CTX, truncated: true, total: 10000 }, 'txt')
    expect(txt).toContain('⚠ 文件过多（10000+）')
  })
})

describe('buildFolderReport - Markdown', () => {
  it('输出表格化报告（状态/路径/大小）与结论引用块', () => {
    const md = buildFolderReport(ENTRIES, CTX, 'md')
    expect(md.startsWith('# DiffLens 文件夹对比报告')).toBe(true)
    expect(md).toContain('> 结论：共 3 个文件存在差异')
    expect(md).toContain('| 状态 | 相对路径 | 左侧大小 | 右侧大小 |')
    expect(md).toContain('`sub/only-r.ts`')
    expect(md).toContain('| 语义同 |')
  })

  it('路径中的管道符被转义保持表格结构', () => {
    const md = buildFolderReport(
      [{ rel: 'a|b.txt', status: 'same', leftSize: 1, rightSize: 1 }],
      CTX,
      'md'
    )
    expect(md).toContain('a\\|b.txt')
  })

  it('空条目集表格给出占位行', () => {
    const md = buildFolderReport([], { ...CTX, total: 0 }, 'md')
    expect(md).toContain('两个文件夹内都没有文件')
  })
})

describe('buildFolderReport - 元信息增强（0.11.0）', () => {
  it('忽略规则进入三格式头部说明（有规则时；未提供时无该行）', () => {
    const rCtx = { ...CTX, ignoreRules: ['node_modules/', '*.log'] }
    expect(buildFolderReport(ENTRIES, rCtx, 'txt')).toContain(
      '忽略规则：node_modules/、*.log（命中项不参与对比）'
    )
    expect(buildFolderReport(ENTRIES, rCtx, 'md')).toContain('> 忽略规则：node_modules/、*.log')
    expect(buildFolderReport(ENTRIES, rCtx, 'html')).toContain('忽略规则：node_modules/、*.log')
    // 未提供时无该行（回归锚）
    expect(buildFolderReport(ENTRIES, CTX, 'txt')).not.toContain('忽略规则')
  })

  it('忽略规则超 5 条时截断为前 5 条 + 计数', () => {
    const rules = ['a/', 'b/', 'c/', 'd/', 'e/', 'f/', 'g/']
    const txt = buildFolderReport(ENTRIES, { ...CTX, ignoreRules: rules }, 'txt')
    expect(txt).toContain('忽略规则：a/、b/、c/、d/、e/ 等 7 条（命中项不参与对比）')
  })

  it('空规则数组不输出忽略规则行（与未提供一致）', () => {
    expect(buildFolderReport(ENTRIES, { ...CTX, ignoreRules: [] }, 'txt')).not.toContain('忽略规则')
  })

  it('版本号进入三格式尾部署名（未提供时保持历史格式）', () => {
    const vCtx = { ...CTX, version: '0.11.0' }
    expect(buildFolderReport(ENTRIES, vCtx, 'txt')).toContain('生成于 DiffLens v0.11.0')
    expect(buildFolderReport(ENTRIES, vCtx, 'md')).toContain('> 生成于 DiffLens v0.11.0')
    expect(buildFolderReport(ENTRIES, vCtx, 'html')).toContain('v0.11.0')
    expect(buildFolderReport(ENTRIES, CTX, 'txt')).toContain('生成于 DiffLens')
    expect(buildFolderReport(ENTRIES, CTX, 'txt')).not.toContain('v0.')
  })
})

describe('buildFolderReport - 快照对照表（snapshotEntries）', () => {
  const SNAP: FolderEntry[] = [
    { rel: 'fixed.txt', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'gone.txt', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'stable.txt', status: 'same', leftSize: 3, rightSize: 3 }
  ]
  const CUR: FolderEntry[] = [
    { rel: 'fixed.txt', status: 'same', leftSize: 2, rightSize: 2 },
    { rel: 'new.txt', status: 'right-only', leftSize: null, rightSize: 5 },
    { rel: 'stable.txt', status: 'same', leftSize: 3, rightSize: 3 }
  ]
  const snapshotEntries = diffSnapshot(SNAP, CUR).entries
  const SNAP_CTX = {
    ...CTX,
    snapshotNote: '修复 1 · 新增差异 0 · 新文件 1 · 已移除 1 · 仍有差异 0（基线 2026/1/1）',
    snapshotEntries
  }

  it('HTML：表头切换为变迁对照列，行含变迁标签与当前/基线状态配色', () => {
    const html = buildFolderReport(CUR, SNAP_CTX, 'html')
    expect(html).toContain('<td>变迁</td>')
    expect(html).toContain('<td>当前状态</td>')
    expect(html).toContain('<td>基线状态</td>')
    // 行级：fixed（不同→相同）与 stable（相同→相同）
    expect(html).toContain('chg-fixed')
    expect(html).toContain('已修复')
    expect(html).toContain('chg-stable')
    expect(html).toContain('保持一致')
    // 普通条目表头不再出现
    expect(html).not.toContain('<td>状态</td>')
  })

  it('HTML：gone 条目当前状态为 —，大小回退基线数据；new 条目基线状态为 —', () => {
    const html = buildFolderReport(CUR, SNAP_CTX, 'html')
    // 按表格行分块断言（tr 与单元格内容不在同一物理行）
    const trOf = (rel: string): string => html.split('<tr').find((c) => c.includes(rel)) ?? ''
    const goneRow = trOf('gone.txt')
    expect(goneRow).toContain('chg-gone')
    expect(goneRow).toContain('已移除')
    expect(goneRow).toContain('—')
    // gone 大小取基线（1 B / 2 B）
    expect(goneRow).toContain('1 B')
    expect(goneRow).toContain('2 B')
    const newRow = trOf('new.txt')
    expect(newRow).toContain('新文件')
    expect(newRow).toContain('—')
  })

  it('纯文本：行含变迁标签与当前/基线状态，快照口径说明保留', () => {
    const txt = buildFolderReport(CUR, SNAP_CTX, 'txt')
    expect(txt).toContain('快照对照：修复 1')
    expect(txt).toContain('已修复  相同  不同')
    expect(txt.split('\n').some((l) => l.includes('gone.txt'))).toBe(true)
    // gone 行：当前状态为 —（基线仍为 不同）
    expect(txt.split('\n').some((l) => l.includes('已移除') && l.includes('—'))).toBe(true)
  })

  it('Markdown：表格切换为变迁列结构', () => {
    const md = buildFolderReport(CUR, SNAP_CTX, 'md')
    expect(md).toContain('| 变迁 | 相对路径 | 当前状态 | 基线状态 | 左侧大小 | 右侧大小 |')
    expect(md).toContain('| 已修复 |')
    expect(md).toContain('| 已移除 |')
    expect(md).not.toContain('| 状态 | 相对路径 | 左侧大小 | 右侧大小 |')
  })

  it('不传 snapshotEntries 时保持普通条目表（回归锚）', () => {
    const html = buildFolderReport(ENTRIES, CTX, 'html')
    expect(html).toContain('<td>状态</td>')
    expect(html).not.toContain('<td>变迁</td>')
  })
})
