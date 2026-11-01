import { describe, it, expect } from 'vitest'
import {
  computeDiff,
  charGroupBudget,
  CHAR_DIFF_MAX_CHARS,
  CHAR_DIFF_GROUP_TOTAL_CHARS,
  CHAR_DIFF_BUDGET_MAX,
  type Seg
} from './diffEngine'

/** 拼接 segs 文本（信息无损校验：拼接结果必须等于原始行文本） */
const joinSegs = (segs: Seg[] | null): string => (segs ?? []).map((s) => s.text).join('')

describe('computeDiff - 空文本', () => {
  it('空 vs 空 不产生任何行', () => {
    const { rows, summary } = computeDiff('', '')
    expect(rows).toHaveLength(0)
    expect(summary.changedLines).toBe(0)
  })

  it('空 vs 非空 全部为新增行', () => {
    const { rows, summary } = computeDiff('', 'a\nb')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.rowKind === 'added')).toBe(true)
    expect(summary.inserted).toBe(2)
  })
})

describe('computeDiff - 全同 / 无差异', () => {
  it('内容完全相同：全部 unchanged', () => {
    const { rows, summary } = computeDiff('line1\nline2', 'line1\nline2')
    expect(summary.changedLines).toBe(0)
    expect(rows.every((r) => r.rowKind === 'unchanged')).toBe(true)
  })
})

describe('computeDiff - 行级增删', () => {
  it('新增行', () => {
    const { rows, summary } = computeDiff('a', 'a\nb')
    const added = rows.filter((r) => r.rowKind === 'added')
    expect(added).toHaveLength(1)
    expect(added[0].right.lineNo).toBe(2)
    expect(added[0].right.text).toBe('b')
    expect(added[0].left.lineNo).toBeNull()
    expect(summary.inserted).toBe(1)
  })

  it('删除行', () => {
    const { rows, summary } = computeDiff('a\nb', 'a')
    const removed = rows.filter((r) => r.rowKind === 'removed')
    expect(removed).toHaveLength(1)
    expect(removed[0].left.lineNo).toBe(2)
    expect(removed[0].left.text).toBe('b')
    expect(removed[0].right.lineNo).toBeNull()
    expect(summary.deleted).toBe(1)
  })
})

describe('computeDiff - 词级修改', () => {
  it('同一删除/新增配对为 modified 并产生 segs', () => {
    const { rows, summary } = computeDiff('hello world', 'hello moon')
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')
    expect(m).toBeDefined()
    expect(m!.left.segs).not.toBeNull()
    expect(m!.right.segs).not.toBeNull()
    expect(m!.left.segs!.some((s) => s.kind === 'delete' && s.text.includes('world'))).toBe(true)
    expect(m!.right.segs!.some((s) => s.kind === 'insert' && s.text.includes('moon'))).toBe(true)
    expect(m!.left.lineNo).toBe(1)
    expect(m!.right.lineNo).toBe(1)
  })

  it('删除多于新增时长侧补空槽', () => {
    const { rows } = computeDiff('a\nb', 'a')
    const removed = rows.find((r) => r.rowKind === 'removed')
    expect(removed!.right.text).toBeNull()
  })
})

describe('computeDiff - 多块修改与不配对增删', () => {
  it('多个独立修改块各自配对为 modified', () => {
    const { rows, summary } = computeDiff('a\nX\nb\nY\nc', 'a\nZ\nb\nW\nc')
    expect(summary.modified).toBe(2)
    const mods = rows.filter((r) => r.rowKind === 'modified')
    expect(mods[0].left.text).toBe('X')
    expect(mods[0].right.text).toBe('Z')
    expect(mods[1].left.text).toBe('Y')
    expect(mods[1].right.text).toBe('W')
  })

  it('删除多于新增时多余删除行降级为 removed', () => {
    const { summary } = computeDiff('l1\nl2\nl3\nl4', 'l1\nl9\nl4')
    // l2 与 l9 配对为修改，l3 无新增可配对 → removed
    expect(summary.modified).toBe(1)
    expect(summary.deleted).toBe(1)
  })

  it('新增多于删除时多余新增行保持 added', () => {
    const { rows, summary } = computeDiff('a\nc', 'a\nb1\nb2\nc')
    expect(summary.inserted).toBe(2)
    const added = rows.filter((r) => r.rowKind === 'added')
    expect(added.map((r) => r.right.text)).toEqual(['b1', 'b2'])
  })
})

describe('computeDiff - 忽略选项', () => {
  it('忽略大小写', () => {
    const { summary } = computeDiff('Alpha', 'alpha', { ignoreCase: true })
    expect(summary.changedLines).toBe(0)
  })

  it('忽略行首尾空白', () => {
    const { summary } = computeDiff('  value  ', 'value', { trimWhitespace: true })
    expect(summary.changedLines).toBe(0)
  })

  it('空白与大小写忽略选项组合生效', () => {
    const { summary } = computeDiff('  Alpha ', 'alpha', { trimWhitespace: true, ignoreCase: true })
    expect(summary.changedLines).toBe(0)
  })

  it('未开启忽略时同一纯净差异仍被识别', () => {
    const { summary } = computeDiff('  value  ', 'value')
    expect(summary.changedLines).toBeGreaterThan(0)
  })
})

describe('computeDiff - 忽略空行', () => {
  it('开启后单侧空行不产生差异', () => {
    const { summary } = computeDiff('a\n\nb', 'a\nb', { ignoreBlankLines: true })
    expect(summary.changedLines).toBe(0)
  })

  it('未开启时单侧空行仍被识别为删除', () => {
    const { summary } = computeDiff('a\n\nb', 'a\nb')
    expect(summary.deleted).toBe(1)
  })

  it('空行被剔除后内容行差异仍被识别', () => {
    const { rows, summary } = computeDiff('a\n\nb', 'a\nx\nb', { ignoreBlankLines: true })
    expect(summary.changedLines).toBe(1)
    expect(summary.inserted).toBe(1)
    // 行号保留原始文件位置（x 位于右侧第 2 行）
    const added = rows.find((r) => r.rowKind === 'added')
    expect(added!.right.lineNo).toBe(2)
  })

  it('两侧不同空白字符的空行互相判等', () => {
    const { summary } = computeDiff('a\n \nb', 'a\n\t\nb', { ignoreBlankLines: true })
    expect(summary.changedLines).toBe(0)
  })

  it('剔除空行后行号保留原值', () => {
    const { rows } = computeDiff('a\n\n\nb', 'a\n\n\nb', { ignoreBlankLines: true })
    expect(rows).toHaveLength(2)
    expect(rows[1].left.lineNo).toBe(4)
    expect(rows[1].right.lineNo).toBe(4)
  })
})

describe('computeDiff - 超长行词级防护', () => {
  it('任一侧超过阈值时跳过词级高亮，行仍为 modified', () => {
    const { rows, summary } = computeDiff('a'.repeat(5001), 'b'.repeat(5001))
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.segs).toBeNull()
    expect(m.right.segs).toBeNull()
  })

  it('恰好阈值长度仍产生词级高亮', () => {
    const { rows } = computeDiff('a'.repeat(5000), 'b'.repeat(5000))
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.segs).not.toBeNull()
    expect(m.right.segs).not.toBeNull()
  })

  it('一侧短一侧超长同样跳过', () => {
    const { rows } = computeDiff('short', 'z'.repeat(6000))
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.segs).toBeNull()
    expect(m.right.segs).toBeNull()
  })
})

describe('computeDiff - 忽略所有空白', () => {
  it('行内空格差异不再产生差异', () => {
    const { summary } = computeDiff('a b c', 'abc', { ignoreAllWhitespace: true })
    expect(summary.changedLines).toBe(0)
  })

  it('制表符与全角空格同样被忽略', () => {
    expect(computeDiff('a\tb', 'ab', { ignoreAllWhitespace: true }).summary.changedLines).toBe(0)
    expect(computeDiff('a　b', 'ab', { ignoreAllWhitespace: true }).summary.changedLines).toBe(0)
  })

  it('开启后行首尾空白差异自然被覆盖（trim 子集）', () => {
    const { summary } = computeDiff('  value  ', 'value', { ignoreAllWhitespace: true })
    expect(summary.changedLines).toBe(0)
  })

  it('缩进与符号间空白差异判等（代码场景）', () => {
    const { summary } = computeDiff(
      '    if (x) { return 1; }',
      'if(x){return 1;}',
      { ignoreAllWhitespace: true }
    )
    expect(summary.changedLines).toBe(0)
  })

  it('多行文本仅行内空白不同判为一致', () => {
    const { summary } = computeDiff('a b\nc  d\ne', 'ab\nc d\ne', { ignoreAllWhitespace: true })
    expect(summary.changedLines).toBe(0)
  })

  it('实际文字差异仍被识别且保留词级高亮', () => {
    const { rows, summary } = computeDiff('a b', 'a c', { ignoreAllWhitespace: true })
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.segs).not.toBeNull()
    expect(m.right.segs).not.toBeNull()
  })

  it('展示文本始终为原始行（不因归一化而改写）', () => {
    const { rows } = computeDiff('  a  b ', 'a b', { ignoreAllWhitespace: true })
    expect(rows[0].left.text).toBe('  a  b ')
    expect(rows[0].right.text).toBe('a b')
  })

  it('换行结构差异不受该选项影响（行级对比边界）', () => {
    const { summary } = computeDiff('ab cd', 'ab\ncd', { ignoreAllWhitespace: true })
    expect(summary.changedLines).toBeGreaterThan(0)
  })

  it('空行数量差异不受该选项影响（需配合忽略空行）', () => {
    const { summary } = computeDiff('a\n\nb', 'a\nb', { ignoreAllWhitespace: true })
    expect(summary.deleted).toBe(1)
    const both = computeDiff('a\n\nb', 'a\nb', { ignoreAllWhitespace: true, ignoreBlankLines: true })
    expect(both.summary.changedLines).toBe(0)
  })

  it('与忽略大小写组合生效', () => {
    const { summary } = computeDiff('A B', 'ab', {
      ignoreAllWhitespace: true,
      ignoreCase: true
    })
    expect(summary.changedLines).toBe(0)
  })

  it('未开启时行内空格差异仍被识别', () => {
    const { summary } = computeDiff('a b c', 'abc')
    expect(summary.changedLines).toBeGreaterThan(0)
  })
})

describe('computeDiff - 行切分细节', () => {
  it('结尾换行不产生多余空行', () => {
    const { rows, summary } = computeDiff('a\n', 'a')
    expect(rows).toHaveLength(1)
    expect(rows[0].rowKind).toBe('unchanged')
    expect(summary.changedLines).toBe(0)
  })
})

describe('computeDiff - 字符级对比（判等）', () => {
  it('跨行重组一致：换行位置不同判为一致（行级对比的边界在此补全）', () => {
    const { summary } = computeDiff('ab cd', 'ab\ncd', { charMode: true })
    expect(summary.changedLines).toBe(0)
  })

  it('空行数量差异不构成差异', () => {
    const { summary } = computeDiff('a\n\nb', 'ab', { charMode: true })
    expect(summary.changedLines).toBe(0)
  })

  it('行内空白差异不构成差异（隐含忽略所有空白）', () => {
    const { summary } = computeDiff('a b\tc', 'abc', { charMode: true })
    expect(summary.changedLines).toBe(0)
  })

  it('全角空格与中文内容正常判等', () => {
    const { summary } = computeDiff('你好 世界', '你好世界', { charMode: true })
    expect(summary.changedLines).toBe(0)
  })

  it('与忽略大小写组合生效', () => {
    const { summary } = computeDiff('AB CD', 'ab\ncd', { charMode: true, ignoreCase: true })
    expect(summary.changedLines).toBe(0)
  })

  it('实际字符差异仍被识别', () => {
    const { summary } = computeDiff('abc', 'abd', { charMode: true })
    expect(summary.changedLines).toBe(1)
  })

  it('完全一致且行结构相同：常规 unchanged 配对', () => {
    const { rows, summary } = computeDiff('a\nb', 'a\nb', { charMode: true })
    expect(summary.changedLines).toBe(0)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ rowKind: 'unchanged' })
    expect(rows[0].left.lineNo).toBe(1)
    expect(rows[0].right.lineNo).toBe(1)
    expect(rows[1].left.lineNo).toBe(2)
    expect(rows[1].right.lineNo).toBe(2)
  })

  it('一致但行数不等：短侧空槽仍为 unchanged，行数取较大侧', () => {
    const { rows, summary } = computeDiff('a\n\nb', 'ab', { charMode: true })
    expect(summary.changedLines).toBe(0)
    expect(rows).toHaveLength(3)
    expect(rows[1].left.lineNo).toBe(2)
    expect(rows[1].right.lineNo).toBeNull()
    expect(rows.every((r) => r.rowKind === 'unchanged')).toBe(true)
  })

  it('展示文本始终为原始行（不因归一化改写）', () => {
    const { rows } = computeDiff('  a  b ', 'a b', { charMode: true })
    expect(rows[0].left.text).toBe('  a  b ')
    expect(rows[0].right.text).toBe('a b')
  })
})

describe('computeDiff - 字符级对比（差异定位与回映射）', () => {
  it('行内替换配对 modified，segs 含 common/删除/新增段', () => {
    const { rows, summary } = computeDiff('cat', 'cap', { charMode: true })
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.segs).not.toBeNull()
    expect(m.right.segs).not.toBeNull()
    expect(m.left.segs!.some((s) => s.kind === 'common' && s.text === 'ca')).toBe(true)
    expect(m.left.segs!.some((s) => s.kind === 'delete' && s.text.includes('t'))).toBe(true)
    expect(m.right.segs!.some((s) => s.kind === 'insert' && s.text.includes('p'))).toBe(true)
  })

  it('行内删除显示为 modified（对侧行回拉），删除字符精确高亮', () => {
    const { rows, summary } = computeDiff('abcXYZdef', 'abcdef', { charMode: true })
    expect(summary.modified).toBe(1)
    expect(summary.deleted).toBe(0)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.lineNo).toBe(1)
    expect(m.right.lineNo).toBe(1)
    expect(m.left.segs!.some((s) => s.kind === 'delete' && s.text.includes('XYZ'))).toBe(true)
    // 右侧无新增字符：整行 common
    expect(m.right.segs!.every((s) => s.kind === 'common')).toBe(true)
  })

  it('行内新增显示为 modified，新增字符精确高亮', () => {
    const { rows, summary } = computeDiff('abcdef', 'abcXYZdef', { charMode: true })
    expect(summary.modified).toBe(1)
    expect(summary.inserted).toBe(0)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.right.segs!.some((s) => s.kind === 'insert' && s.text.includes('XYZ'))).toBe(true)
    expect(m.left.segs!.every((s) => s.kind === 'common')).toBe(true)
  })

  it('行尾追加（流尾跨界）同样回拉配对 modified', () => {
    const { rows, summary } = computeDiff('abc', 'abcXYZ', { charMode: true })
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.right.segs!.some((s) => s.kind === 'insert' && s.text.includes('XYZ'))).toBe(true)
  })

  it('行首插入（流首跨界）同样回拉配对 modified', () => {
    const { summary } = computeDiff('abc', 'XYZabc', { charMode: true })
    expect(summary.modified).toBe(1)
  })

  it('整行删除（跨行不跨界）保持 removed 语义，不误配对', () => {
    const { rows, summary } = computeDiff('aa\nbb\ncc', 'aa\ncc', { charMode: true })
    expect(summary.changedLines).toBe(1)
    expect(summary.deleted).toBe(1)
    const rem = rows.find((r) => r.rowKind === 'removed')!
    expect(rem.left.lineNo).toBe(2)
    expect(rem.left.text).toBe('bb')
    // 其余行锚定配对
    const anchor = rows.filter((r) => r.rowKind === 'unchanged')
    expect(anchor.map((r) => [r.left.lineNo, r.right.lineNo])).toEqual([
      [1, 1],
      [3, 2]
    ])
  })

  it('整行新增保持 added 语义', () => {
    const { rows, summary } = computeDiff('aa\ncc', 'aa\nbb\ncc', { charMode: true })
    expect(summary.inserted).toBe(1)
    const add = rows.find((r) => r.rowKind === 'added')!
    expect(add.right.lineNo).toBe(2)
    expect(add.right.text).toBe('bb')
  })

  it('多个独立修改块各自配对 modified，锚行穿插', () => {
    const { rows, summary } = computeDiff('a\nX\nb\nY\nc', 'a\nZ\nb\nW\nc', { charMode: true })
    expect(summary.modified).toBe(2)
    expect(summary.changedLines).toBe(2)
    const mods = rows.filter((r) => r.rowKind === 'modified')
    expect(mods[0].left.text).toBe('X')
    expect(mods[0].right.text).toBe('Z')
    expect(mods[1].left.text).toBe('Y')
    expect(mods[1].right.text).toBe('W')
    expect(rows.filter((r) => r.rowKind === 'unchanged')).toHaveLength(3)
  })

  it('删除文本中间的空白归入删除段（空白继承规则）', () => {
    const { rows, summary } = computeDiff('hello big world', 'hello world', { charMode: true })
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    const del = m.left.segs!.find((s) => s.kind === 'delete')!
    // 'big' 与其后空白一并划入删除段
    expect(del.text).toContain('big')
  })

  it('跨行变更配对：共享字符行锚定，变更行配 modified', () => {
    const { rows, summary } = computeDiff('ab', 'a\nx', { charMode: true })
    expect(summary.changedLines).toBe(1)
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.text).toBe('ab')
    expect(m.right.text).toBe('x')
    expect(m.left.segs!.some((s) => s.kind === 'delete' && s.text.includes('b'))).toBe(true)
    // 双侧行号序列各自单调不减（空槽跳过）
    const lNos = rows.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rNos = rows.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    expect([...lNos].sort((a, b) => a - b)).toEqual(lNos)
    expect([...rNos].sort((a, b) => a - b)).toEqual(rNos)
  })

  it('空 vs 非空全部为新增行', () => {
    const { rows, summary } = computeDiff('', 'a\nb', { charMode: true })
    expect(summary.inserted).toBe(2)
    expect(rows.every((r) => r.rowKind === 'added')).toBe(true)
  })

  it('空 vs 空 不产生任何行', () => {
    const { rows, summary } = computeDiff('', '', { charMode: true })
    expect(rows).toHaveLength(0)
    expect(summary.changedLines).toBe(0)
  })

  it('忽略大小写只影响判等，diff 定位按原字符', () => {
    const { summary } = computeDiff('Cat', 'car', { charMode: true, ignoreCase: true })
    // 'ca' 一致，t 与 r 为一处修改
    expect(summary.modified).toBe(1)
  })
})

describe('computeDiff - 字符级对比（超限降级）', () => {
  it('变更组流超限自动降级行级并携带降级标志', () => {
    // 单行全差异：组流 = (half+1) × 2 = CHAR_DIFF_MAX_CHARS + 2，超单组上限
    const half = CHAR_DIFF_MAX_CHARS / 2
    const left = 'a'.repeat(half + 1)
    const right = 'b'.repeat(half + 1)
    const result = computeDiff(left, right, { charMode: true })
    expect(result.charModeDowngraded).toBe(true)
    // 降级行级采用“忽略所有空白 + 忽略空行”语义：单行全不同判 modified
    const direct = computeDiff(left, right, {
      ignoreAllWhitespace: true,
      ignoreBlankLines: true
    })
    expect(result.summary).toEqual(direct.summary)
  })

  it('编辑距离超限快速降级（总量未超但差异过大）', () => {
    // 内部参数注入小阈值（10）：生产默认 5000，触发截断需跑满上限轮数迭代，测试以小值毫秒级构造
    const left = 'a'.repeat(2000)
    const right = 'b'.repeat(2000)
    const result = computeDiff(left, right, { charMode: true, charDiffMaxEdit: 10 })
    expect(result.charModeDowngraded).toBe(true)
    // 降级结果与等效行级选项直接计算一致
    const direct = computeDiff(left, right, {
      ignoreAllWhitespace: true,
      ignoreBlankLines: true
    })
    expect(result.summary).toEqual(direct.summary)
  })

  it('编辑距离在限内正常完成字符级对比', () => {
    const left = 'x'.repeat(4000)
    const right = 'y'.repeat(100) + 'x'.repeat(3900)
    const { summary, charModeDowngraded } = computeDiff(left, right, { charMode: true })
    expect(charModeDowngraded).toBeUndefined()
    expect(summary.changedLines).toBeGreaterThan(0)
  })

  it('大输入仅局部差异：行锚定后字符级完成，不降级（分块能力回归）', () => {
    // 旧实现（整篇流 diffChars）此输入必超限降级；分块后相同大行被锚定，
    // 唯一变更组只有第 2 行（b → c），字符级精确定位
    const left = 'a'.repeat(100001) + '\nb'
    const right = 'a'.repeat(100001) + '\nc'
    const result = computeDiff(left, right, { charMode: true })
    expect(result.charModeDowngraded).toBeUndefined()
    expect(result.summary.changedLines).toBe(1)
    expect(result.summary.modified).toBe(1)
    const m = result.rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.lineNo).toBe(2)
    expect(m.right.lineNo).toBe(2)
    expect(m.left.segs!.some((s) => s.kind === 'delete' && s.text.includes('b'))).toBe(true)
    expect(m.right.segs!.some((s) => s.kind === 'insert' && s.text.includes('c'))).toBe(true)
    // 首行 10 万字符的相同行锚定输出
    expect(result.rows.filter((r) => r.rowKind === 'unchanged')).toHaveLength(1)
  })

  it('变更组流恰好阈值不降级', () => {
    // 单行组流 = half + half = 恰好 CHAR_DIFF_MAX_CHARS（> 才降），编辑距离 1
    const half = CHAR_DIFF_MAX_CHARS / 2
    const left = 'a'.repeat(half - 1) + 'b'
    const right = 'a'.repeat(half)
    const { summary, charModeDowngraded } = computeDiff(left, right, { charMode: true })
    expect(charModeDowngraded).toBeUndefined()
    expect(summary.changedLines).toBe(1)
  })

  it('未开启 charMode 时不携带降级标志', () => {
    const { charModeDowngraded } = computeDiff('a', 'b', {})
    expect(charModeDowngraded).toBeUndefined()
  })
})

describe('computeDiff - 字符级对比（分块锚定）', () => {
  it('大文件全同内容：行锚定判等，不降级且无差异（归一化流总量远超单组上限）', () => {
    // 20 万归一化字符（远超 CHAR_DIFF_MAX_CHARS 的 5 万），内容全同
    const text = Array.from({ length: 2000 }, () => 'a'.repeat(100)).join('\n')
    const { summary, charModeDowngraded, rows } = computeDiff(text, text, { charMode: true })
    expect(charModeDowngraded).toBeUndefined()
    expect(summary.changedLines).toBe(0)
    expect(rows).toHaveLength(2000)
    expect(rows.every((r) => r.rowKind === 'unchanged')).toBe(true)
  })

  it('大文件局部差异：差异行 modified 精确定位，其余行锚定 unchanged', () => {
    const base = Array.from({ length: 1000 }, (_, i) => `line-${i}-content`)
    const modified = [...base]
    modified[500] = 'line-500-CONTENT'
    const { rows, summary, charModeDowngraded } = computeDiff(base.join('\n'), modified.join('\n'), {
      charMode: true
    })
    expect(charModeDowngraded).toBeUndefined()
    expect(summary.changedLines).toBe(1)
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.lineNo).toBe(501)
    expect(m.right.lineNo).toBe(501)
    expect(m.left.segs!.some((s) => s.kind === 'delete' && s.text.includes('content'))).toBe(true)
    expect(m.right.segs!.some((s) => s.kind === 'insert' && s.text.includes('CONTENT'))).toBe(true)
    expect(rows.filter((r) => r.rowKind === 'unchanged')).toHaveLength(999)
    const lNos = rows.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rNos = rows.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    expect([...lNos].sort((a, b) => a - b)).toEqual(lNos)
    expect([...rNos].sort((a, b) => a - b)).toEqual(rNos)
  })

  it('多个变更组穿插锚行：各组独立回映射，行号全局单调', () => {
    const base = Array.from({ length: 30 }, (_, i) => `row${i}`)
    const modified = [...base]
    modified[5] = 'row5X'
    modified[15] = 'row15X'
    modified[25] = 'row25X'
    const { rows, summary, charModeDowngraded } = computeDiff(
      base.join('\n'),
      modified.join('\n'),
      { charMode: true }
    )
    expect(charModeDowngraded).toBeUndefined()
    expect(summary.modified).toBe(3)
    expect(summary.changedLines).toBe(3)
    const mods = rows.filter((r) => r.rowKind === 'modified')
    expect(mods.map((r) => r.left.lineNo)).toEqual([6, 16, 26])
    expect(mods.map((r) => r.right.lineNo)).toEqual([6, 16, 26])
    expect(rows.filter((r) => r.rowKind === 'unchanged')).toHaveLength(27)
    const lNos = rows.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rNos = rows.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    expect([...lNos].sort((a, b) => a - b)).toEqual(lNos)
    expect([...rNos].sort((a, b) => a - b)).toEqual(rNos)
  })

  it('组总流超预算：预算内组字符级、预算外组行级降级（部分降级，不再整体降级）', async () => {
    // 8 个变更组，每组流 6500 + 6501 = 13001（在单组上限内，编辑距离 1），总流 104008：
    // 自适应预算 = max(10 万, 52004) = 10 万（小输入取下限，与历史固定预算行为一致），
    // 前 7 组消耗 91007，第 8 组 13001 > 剩余 8993 → 行级配对（partial）
    const build = (withX: boolean): string => {
      const lines: string[] = []
      for (let i = 0; i < 8; i++) {
        lines.push(`same-${i}`)
        lines.push('a'.repeat(6500) + (withX ? 'X' : ''))
      }
      return lines.join('\n')
    }
    const result = computeDiff(build(false), build(true), { charMode: true })
    // 部分降级：不再整体降级
    expect(result.charModeDowngraded).toBeUndefined()
    expect(result.charModePartial).toBe(true)
    // 8 个组各 1:1 行配对输出 modified：前 7 组字符级（segs 字符粒度），
    // 第 8 组行级配对（超长行 > 5000 触发词级防护，segs 为 null，行仍 modified）
    expect(result.summary.modified).toBe(8)
    expect(result.summary.deleted).toBe(0)
    expect(result.summary.inserted).toBe(0)
    const mods = result.rows.filter((r) => r.rowKind === 'modified')
    expect(mods).toHaveLength(8)
    // 前 7 组字符级 segs 拼接无损；第 8 组词级防护 segs 为 null
    const noSegs = mods.filter((m) => m.left.segs === null)
    expect(noSegs).toHaveLength(1)
    for (const m of mods) {
      if (m.left.segs === null) continue
      expect(joinSegs(m.left.segs)).toBe(m.left.text)
      expect(joinSegs(m.right.segs)).toBe(m.right.text)
    }
    // 行号单调
    const lNos = result.rows.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rNos = result.rows.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    expect([...lNos].sort((a, b) => a - b)).toEqual(lNos)
    expect([...rNos].sort((a, b) => a - b)).toEqual(rNos)
  })

  it('单组流超上限：仅该组行级降级，其余组字符级（partial）', () => {
    // mid 锚行分隔两个变更组：组 1（cat↔cap）流小字符级；组 2 单行全差异 50002 > 上限 → 行级
    const left = ['head', 'cat', 'mid', 'a'.repeat(25001)]
    const right = ['head', 'cap', 'mid', 'b'.repeat(25001)]
    const result = computeDiff(left.join('\n'), right.join('\n'), { charMode: true })
    expect(result.charModeDowngraded).toBeUndefined()
    expect(result.charModePartial).toBe(true)
    // 组 1（cat↔cap）字符级精确定位：1 个 modified，字符粒度高亮
    const cat = result.rows.find(
      (r) => r.rowKind === 'modified' && r.left.text === 'cat'
    )!
    expect(cat.right.text).toBe('cap')
    expect(cat.left.segs!.some((s) => s.kind === 'delete' && s.text.includes('t'))).toBe(true)
    expect(cat.right.segs!.some((s) => s.kind === 'insert' && s.text.includes('p'))).toBe(true)
    // 组 2 行级配对：a…a ↔ b…b 配 modified（25001 > 5000 触发词级防护，segs 为 null）
    const big = result.rows.find(
      (r) => r.rowKind === 'modified' && (r.left.text ?? '').startsWith('a')
    )!
    expect(big.right.text).toBe('b'.repeat(25001))
    expect(big.left.segs).toBeNull()
    // 锚行保持 unchanged（head 与 mid）
    expect(result.rows.filter((r) => r.rowKind === 'unchanged')).toHaveLength(2)
  })

  it('单组编辑距离超限：仅该组行级降级，其余组字符级（partial，预算未耗尽）', () => {
    // charDiffMaxEdit 注入 10；mid 锚行分隔：组 1（cat↔cap）编辑距离 1 成功；
    // 组 2（a*2000 ↔ b*2000）编辑距离 4000 超限 → 行级
    const left = ['x', 'cat', 'mid', 'a'.repeat(2000)]
    const right = ['x', 'cap', 'mid', 'b'.repeat(2000)]
    const result = computeDiff(left.join('\n'), right.join('\n'), {
      charMode: true,
      charDiffMaxEdit: 10
    })
    expect(result.charModeDowngraded).toBeUndefined()
    expect(result.charModePartial).toBe(true)
    // 组 1 字符级完成（cat↔cap 1 个 modified）
    const cat = result.rows.find((r) => r.rowKind === 'modified' && r.left.text === 'cat')!
    expect(cat.right.text).toBe('cap')
    expect(cat.left.segs!.some((s) => s.kind === 'delete')).toBe(true)
    // 组 2 行级配对 modified（词级 segs）
    const big = result.rows.find(
      (r) => r.rowKind === 'modified' && (r.left.text ?? '').startsWith('a')
    )!
    expect(big.right.text).toBe('b'.repeat(2000))
  })

  it('全部组超限：整体降级行级（charModeDowngraded，不出现 partial）', () => {
    // 两个组都单行全差异超 5 万 → 零组完成字符级 → 整体降级
    const half = 25001
    const left = ['anchor', 'a'.repeat(half), 'mid', 'c'.repeat(half)]
    const right = ['anchor', 'b'.repeat(half), 'mid', 'd'.repeat(half)]
    const result = computeDiff(left.join('\n'), right.join('\n'), { charMode: true })
    expect(result.charModeDowngraded).toBe(true)
    expect(result.charModePartial).toBeUndefined()
    // 降级结果与等效行级选项直接计算一致
    const direct = computeDiff(left.join('\n'), right.join('\n'), {
      ignoreAllWhitespace: true,
      ignoreBlankLines: true
    })
    expect(result.summary).toEqual(direct.summary)
  })

  it('行级降级组内行数不等：相邻块按序配对，多余侧 added/removed', () => {
    // mid 锚行分隔：组 1（small↔small）字符级保底；
    // 组 2 左 [x*15000, only] 右 [y*15000, r1, r2]——组流 3 万在限内但编辑距离
    // 超 5000（x…↔y… 全替换）→ 行级配对：x…↔y… 与 only↔r1 配 modified，r2 多余 added
    const left = ['head', 'small-l', 'mid', 'x'.repeat(15000), 'only-left-line']
    const right = ['head', 'small-r', 'mid', 'y'.repeat(15000), 'r-line-1', 'r-line-2']
    const result = computeDiff(left.join('\n'), right.join('\n'), { charMode: true })
    expect(result.charModeDowngraded).toBeUndefined()
    expect(result.charModePartial).toBe(true)
    const mods = result.rows.filter((r) => r.rowKind === 'modified')
    // 组 1 small 配对 + 组 2 两对（x…↔y…、only↔r1）
    expect(mods).toHaveLength(3)
    expect(mods.some((m) => m.left.text === 'small-l' && m.right.text === 'small-r')).toBe(true)
    expect(mods.some((m) => (m.left.text ?? '').startsWith('x'))).toBe(true)
    expect(mods.some((m) => m.left.text === 'only-left-line' && m.right.text === 'r-line-1')).toBe(true)
    // 多余右侧 r2 → added；无 removed
    const added = result.rows.filter((r) => r.rowKind === 'added')
    expect(added.map((r) => r.right.text)).toEqual(['r-line-2'])
    expect(result.summary.deleted).toBe(0)
    // 锚行 head/mid unchanged
    expect(result.rows.filter((r) => r.rowKind === 'unchanged')).toHaveLength(2)
    // 行号单调
    const lNos = result.rows.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rNos = result.rows.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    expect([...lNos].sort((a, b) => a - b)).toEqual(lNos)
    expect([...rNos].sort((a, b) => a - b)).toEqual(rNos)
  })

  it('跨行重组落在变更组内：组内字符流判等，锚行 zip 输出', () => {
    // 行归一化无交集（'ab cd' vs 'ab\ncd'）→ 唯一变更组即全文，
    // 组内流全等 → 锚行输出，行为与旧整篇路径一致
    const { rows, summary } = computeDiff('ab cd', 'ab\ncd', { charMode: true })
    expect(summary.changedLines).toBe(0)
    expect(rows).toHaveLength(2)
    expect(rows[0].left.lineNo).toBe(1)
    expect(rows[0].right.lineNo).toBe(1)
    expect(rows[1].left.lineNo).toBeNull()
    expect(rows[1].right.lineNo).toBe(2)
  })
})

describe('computeDiff - 字符级对比（字符换位专项）', () => {
  /**
   * 已知取舍的固化测试：换位场景（如 ab ↔ ba）下 jsdiff 的 Myers 对齐具有任意性
   * （LCS 长度 1，哪个字符被选为 common 不确定），个别 common 字符无法在同行视觉对齐。
   * 本组用例不锚定具体对齐结果，只断言对齐无关的安全不变量：
   * 1. 两侧均有变更字符的单行必然配对 modified（增删改计数稳定）
   * 2. segs 拼接无损（等于原始行文本，信息零丢失）
   * 3. 高亮不越侧（左侧无 insert 段、右侧无 delete 段）
   * 4. 展示文本始终为原文，行号序列单调
   */

  it('最小换位 ab↔ba：配对 modified，segs 拼接无损且高亮不越侧', () => {
    const { rows, summary } = computeDiff('ab', 'ba', { charMode: true })
    expect(summary.changedLines).toBe(1)
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.lineNo).toBe(1)
    expect(m.right.lineNo).toBe(1)
    // 不变量 2：拼接无损（对齐任意但原文可完整重建）
    expect(joinSegs(m.left.segs)).toBe('ab')
    expect(joinSegs(m.right.segs)).toBe('ba')
    // 不变量 3：不越侧
    expect(m.left.segs!.every((s) => s.kind !== 'insert')).toBe(true)
    expect(m.right.segs!.every((s) => s.kind !== 'delete')).toBe(true)
    // 不变量 4：展示为原文
    expect(m.left.text).toBe('ab')
    expect(m.right.text).toBe('ba')
  })

  it('长串换位 abc↔cba：不变量同样成立', () => {
    const { rows, summary } = computeDiff('abc', 'cba', { charMode: true })
    expect(summary.modified).toBe(1)
    expect(summary.changedLines).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(joinSegs(m.left.segs)).toBe('abc')
    expect(joinSegs(m.right.segs)).toBe('cba')
    expect(m.left.segs!.every((s) => s.kind !== 'insert')).toBe(true)
    expect(m.right.segs!.every((s) => s.kind !== 'delete')).toBe(true)
  })

  it('中文换位 你好↔好你：码点级处理，不变量成立', () => {
    const { rows, summary } = computeDiff('你好', '好你', { charMode: true })
    expect(summary.modified).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(joinSegs(m.left.segs)).toBe('你好')
    expect(joinSegs(m.right.segs)).toBe('好你')
    // 变更段按码点切分（不含半个代理对）：删除段与新增段的码点数一致为 1
    const lDel = m.left.segs!.filter((s) => s.kind === 'delete').map((s) => s.text).join('')
    const rIns = m.right.segs!.filter((s) => s.kind === 'insert').map((s) => s.text).join('')
    expect([...lDel]).toHaveLength(1)
    expect([...rIns]).toHaveLength(1)
  })

  it('多行局部换位：换位行配 modified，未换位行锚定 unchanged', () => {
    const { rows, summary } = computeDiff('ab\ncd', 'ba\ncd', { charMode: true })
    expect(summary.changedLines).toBe(1)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(m.left.lineNo).toBe(1)
    expect(m.right.lineNo).toBe(1)
    expect(joinSegs(m.left.segs)).toBe('ab')
    expect(joinSegs(m.right.segs)).toBe('ba')
    // 未换位行锚定：两侧第 2 行原样 unchanged
    const anchor = rows.filter((r) => r.rowKind === 'unchanged')
    expect(anchor).toHaveLength(1)
    expect(anchor[0].left.lineNo).toBe(2)
    expect(anchor[0].right.lineNo).toBe(2)
    expect(anchor[0].left.text).toBe('cd')
    expect(anchor[0].right.text).toBe('cd')
  })

  it('同行两处替换（ne-eq-ne 同行）：仅输出一个 modified，不重复行', () => {
    // 与换位同源的重复输出缺陷触发场景：aXbYc → aPbQc，
    // 两处替换被中间的 common 'b' 隔开为两个 ne 块且落在同一行
    const { rows, summary } = computeDiff('aXbYc', 'aPbQc', { charMode: true })
    expect(summary.changedLines).toBe(1)
    expect(summary.modified).toBe(1)
    const mods = rows.filter((r) => r.rowKind === 'modified')
    expect(mods).toHaveLength(1)
    expect(mods[0].left.lineNo).toBe(1)
    expect(mods[0].right.lineNo).toBe(1)
    // 单个 modified 内两处差异都可见（信息无损）
    expect(joinSegs(mods[0].left.segs)).toBe('aXbYc')
    expect(joinSegs(mods[0].right.segs)).toBe('aPbQc')
    expect(mods[0].left.segs!.some((s) => s.kind === 'delete' && s.text.includes('X'))).toBe(true)
    expect(mods[0].left.segs!.some((s) => s.kind === 'delete' && s.text.includes('Y'))).toBe(true)
    expect(mods[0].right.segs!.some((s) => s.kind === 'insert' && s.text.includes('P'))).toBe(true)
    expect(mods[0].right.segs!.some((s) => s.kind === 'insert' && s.text.includes('Q'))).toBe(true)
  })

  it('换位伴随跨行重组：对齐任意但增删改计数与行号单调恒成立', () => {
    // ab → b\na：换位同时换行位置变化。jsdiff 可能选 b 为 common（输出 modified(1,1)+added(右2)）
    // 也可能选 a 为 common（输出 modified(1,2)+added(右1)），配对行号随对齐漂移——
    // 断言只锚定不变量，禁锢"信息无损、无越侧、单调"三条安全底线
    const { rows, summary } = computeDiff('ab', 'b\na', { charMode: true })
    expect(summary.changedLines).toBe(2)
    expect(summary.modified).toBe(1)
    expect(summary.inserted).toBe(1)
    expect(summary.deleted).toBe(0)
    const m = rows.find((r) => r.rowKind === 'modified')!
    expect(joinSegs(m.left.segs)).toBe('ab')
    expect(joinSegs(m.right.segs)).not.toBe('')
    expect(m.left.segs!.every((s) => s.kind !== 'insert')).toBe(true)
    expect(m.right.segs!.every((s) => s.kind !== 'delete')).toBe(true)
    // 新增行：另一侧为空槽，文本取自右侧原文
    const add = rows.find((r) => r.rowKind === 'added')!
    expect(add.left.lineNo).toBeNull()
    expect(add.right.text).not.toBe('')
    // 不变量 4：双侧行号序列各自单调不减
    const lNos = rows.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rNos = rows.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    expect([...lNos].sort((a, b) => a - b)).toEqual(lNos)
    expect([...rNos].sort((a, b) => a - b)).toEqual(rNos)
  })
})

describe('charGroupBudget - 预算自适应（函数边界）', () => {
  it('小输入与空输入取下限（与历史固定预算一致）', () => {
    expect(charGroupBudget(0)).toBe(CHAR_DIFF_GROUP_TOTAL_CHARS)
    expect(charGroupBudget(1000)).toBe(CHAR_DIFF_GROUP_TOTAL_CHARS)
    expect(charGroupBudget(CHAR_DIFF_GROUP_TOTAL_CHARS)).toBe(CHAR_DIFF_GROUP_TOTAL_CHARS)
    expect(charGroupBudget(CHAR_DIFF_GROUP_TOTAL_CHARS * 2)).toBe(CHAR_DIFF_GROUP_TOTAL_CHARS)
  })

  it('大输入按总组流一半放宽（向上取整）', () => {
    // 总流 200002 → ceil(100001)
    expect(charGroupBudget(200002)).toBe(100001)
    // 总流 480800 → 240400
    expect(charGroupBudget(480800)).toBe(240400)
  })

  it('超上限封顶', () => {
    expect(charGroupBudget(CHAR_DIFF_BUDGET_MAX * 2)).toBe(CHAR_DIFF_BUDGET_MAX)
    expect(charGroupBudget(100_000_000)).toBe(CHAR_DIFF_BUDGET_MAX)
  })

  it('非有限输入回退下限', () => {
    expect(charGroupBudget(NaN)).toBe(CHAR_DIFF_GROUP_TOTAL_CHARS)
    expect(charGroupBudget(Infinity)).toBe(CHAR_DIFF_GROUP_TOTAL_CHARS)
    expect(charGroupBudget(-5)).toBe(CHAR_DIFF_GROUP_TOTAL_CHARS)
  })
})

describe('computeDiff - 预算自适应行为固化', () => {
  it('大输入跨行重组组：预算随总流放宽，完成字符级的组多于固定预算', () => {
    // 每组左右字符流完全一致但行结构不同（左 1 行 / 右 2 行）：
    // - 字符级组：组内流全等 → 无变更字符 → 全部行按锚行输出（unchanged，0 变更行）
    // - 行级组：行归一化无判等行 → 左 1 行与右 2 行配对 → modified 1 + added 1
    // 组流 = (600+1)×2 = 1202，400 组总流 480800 → 自适应预算 240400 →
    // 前 200 组（240400/1202=200 整）字符级，第 201 组起行级。
    // 历史固定预算 10 万只能完成 83 组——行为放宽由此固化。
    const build = (side: 'left' | 'right'): string => {
      const lines: string[] = []
      for (let i = 0; i < 400; i++) {
        lines.push(`same-${i}`)
        if (side === 'left') {
          lines.push('a'.repeat(600) + 'K')
        } else {
          lines.push('a'.repeat(300))
          lines.push('a'.repeat(300) + 'K')
        }
      }
      return lines.join('\n')
    }
    const result = computeDiff(build('left'), build('right'), { charMode: true })
    expect(result.charModeDowngraded).toBeUndefined()
    expect(result.charModePartial).toBe(true)
    // 200 个行级组各产出 1 modified + 1 added；字符级组 0 变更行
    expect(result.summary.modified).toBe(200)
    expect(result.summary.inserted).toBe(200)
    expect(result.summary.changedLines).toBe(400)
    // 行号单调
    const lNos = result.rows.map((r) => r.left.lineNo).filter((n): n is number => n !== null)
    const rNos = result.rows.map((r) => r.right.lineNo).filter((n): n is number => n !== null)
    expect([...lNos].sort((a, b) => a - b)).toEqual(lNos)
    expect([...rNos].sort((a, b) => a - b)).toEqual(rNos)
  })

  it('总流未超下限两倍：行为与历史固定预算完全一致（回归锚）', () => {
    // 总流 104008 < 20 万：预算仍为下限 10 万，部分降级切分与 0.8.0 固化行为一致
    const build = (withX: boolean): string => {
      const lines: string[] = []
      for (let i = 0; i < 8; i++) {
        lines.push(`same-${i}`)
        lines.push('a'.repeat(6500) + (withX ? 'X' : ''))
      }
      return lines.join('\n')
    }
    const result = computeDiff(build(false), build(true), { charMode: true })
    expect(result.charModePartial).toBe(true)
    expect(
      result.rows.filter((r) => r.rowKind === 'modified' && r.left.segs === null)
    ).toHaveLength(1)
  })
})

describe('computeDiff - 字符粒度增删统计（0.10.5）', () => {
  it('行级 added / removed 行按整行文本码点计数', () => {
    // 新增行 '新增行'（3 码点）+ 删除行 'gone'（4 码点）
    const { summary } = computeDiff('gone\nkeep', 'keep\n新增行')
    expect(summary.inserted).toBe(1)
    expect(summary.charsAdded).toBe(3)
    expect(summary.deleted).toBe(1)
    expect(summary.charsDeleted).toBe(4)
  })

  it('modified 行按 segs 的增删段计数，common 段不计', () => {
    // 'hello world' → 'hello moon'：world(5) 删除、moon(4) 新增
    const { summary } = computeDiff('hello world', 'hello moon')
    expect(summary.modified).toBe(1)
    expect(summary.charsAdded).toBe(4)
    expect(summary.charsDeleted).toBe(5)
  })

  it('全角与 emoji 按码点计数（代理对不拆分）', () => {
    // '中文' → '中😀'：文(1 码点)删除、😀(1 码点)新增；UTF-16 长度下 😀 为 2
    const { summary } = computeDiff('中文', '中😀')
    expect(summary.charsAdded).toBe(1)
    expect(summary.charsDeleted).toBe(1)
  })

  it('字符级模式：modified 行的字符高亮段计入统计（跨行重组）', () => {
    // 组内回映射：'abcXYZdef' → 'abcdef' 删除 XYZ(3 码点)
    const { summary } = computeDiff('abcXYZdef', 'abcdef', { charMode: true })
    expect(summary.modified).toBe(1)
    expect(summary.charsDeleted).toBe(3)
    expect(summary.charsAdded).toBe(0)
  })

  it('超长行防护（segs 为 null）的 modified 行不计入字符统计', () => {
    const { summary } = computeDiff('a'.repeat(5001), 'b'.repeat(5001))
    expect(summary.modified).toBe(1)
    expect(summary.charsAdded).toBe(0)
    expect(summary.charsDeleted).toBe(0)
  })

  it('内容完全一致时字符统计为零', () => {
    const { summary } = computeDiff('same\nsame2', 'same\nsame2', { charMode: true })
    expect(summary.charsAdded).toBe(0)
    expect(summary.charsDeleted).toBe(0)
  })

  it('行级与字符级路径的统计口径一致（同输入同统计）', () => {
    const left = 'a\nbb\nccc'
    const right = 'a\nxx\nccc\ndddd'
    const lineLevel = computeDiff(left, right)
    const charMode = computeDiff(left, right, { charMode: true })
    expect(charMode.summary.charsAdded).toBe(lineLevel.summary.charsAdded)
    expect(charMode.summary.charsDeleted).toBe(lineLevel.summary.charsDeleted)
  })
})