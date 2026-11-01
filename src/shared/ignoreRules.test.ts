import { describe, it, expect } from 'vitest'
import {
  compileIgnoreRules,
  isIgnoreRulesArray,
  IGNORE_RULES_MAX,
  IGNORE_RULE_MAX_LEN
} from './ignoreRules'

/** 便捷断言：路径是否被忽略（isDir 缺省 false） */
function ignored(rules: string[], rel: string, isDir = false): boolean {
  return compileIgnoreRules(rules).matchesPath(rel, isDir)
}

describe('compileIgnoreRules - 名字与目录规则（既有语义回归）', () => {
  it('单段名字匹配：任意层级命中文件与目录', () => {
    expect(ignored(['temp'], 'temp')).toBe(true)
    expect(ignored(['temp'], 'a/temp')).toBe(true)
    expect(ignored(['temp'], 'a/b/temp', true)).toBe(true)
    expect(ignored(['temp'], 'temp.txt')).toBe(false)
    expect(ignored(['temp'], 'temporary')).toBe(false)
  })

  it('尾 / 目录专用：文件不命中', () => {
    expect(ignored(['node_modules/'], 'node_modules', true)).toBe(true)
    expect(ignored(['node_modules/'], 'node_modules')).toBe(false)
    expect(ignored(['node_modules/'], 'pkg/node_modules', true)).toBe(true)
    expect(ignored(['node_modules/'], 'a.txt')).toBe(false)
  })

  it('大小写不敏感（双侧）', () => {
    expect(ignored(['NODE_MODULES/'], 'node_modules', true)).toBe(true)
    expect(ignored(['node_modules/'], 'Node_Modules', true)).toBe(true)
    expect(ignored(['*.log'], 'a.LOG')).toBe(true)
  })

  it('扩展名通配 *.ext：任意层级后缀命中（段内 * 可匹配零字符，对齐 gitignore）', () => {
    expect(ignored(['*.log'], 'app.log')).toBe(true)
    expect(ignored(['*.log'], 'sub/app.log')).toBe(true)
    expect(ignored(['*.log'], 'app.log.txt')).toBe(false)
    expect(ignored(['*.log'], '.log')).toBe(true)
    // 非目录专用的通配规则同样可命中目录名
    expect(ignored(['*.log'], 'dump.log', true)).toBe(true)
  })

  it('目录专用通配（*.log/）仅匹配以 .log 结尾的目录名', () => {
    expect(ignored(['*.log/'], 'debug.log', true)).toBe(true)
    expect(ignored(['*.log/'], 'logs', true)).toBe(false)
    expect(ignored(['*.log/'], 'debug.log')).toBe(false)
  })

  it('多条规则任一命中即可', () => {
    const m = compileIgnoreRules(['temp', 'dist/', '*.tmp'])
    expect(m.matchesPath('dist', true)).toBe(true)
    expect(m.matchesPath('a.tmp')).toBe(true)
    expect(m.matchesPath('temp')).toBe(true)
    expect(m.matchesPath('keep.txt')).toBe(false)
  })
})

describe('compileIgnoreRules - 多段路径与前导 / 锚定', () => {
  it('多段路径从根锚定匹配（模式精确匹配路径；子树忽略由目录剪枝实现，与 gitignore 一致）', () => {
    expect(ignored(['src/temp'], 'src/temp')).toBe(true)
    expect(ignored(['src/temp'], 'src/temp', true)).toBe(true) // 目录命中 → BFS 整树剪枝
    expect(ignored(['src/temp'], 'src/temp/x.ts')).toBe(false) // 模式不匹配子路径（剪枝后不会被查询）
    expect(ignored(['src/temp'], 'src/deep/temp')).toBe(false) // 中间层不命中
    expect(ignored(['src/temp'], 'lib/temp')).toBe(false) // 其他分支不命中
  })

  it('多段路径尾 / 目录专用', () => {
    expect(ignored(['src/temp/'], 'src/temp', true)).toBe(true)
    expect(ignored(['src/temp/'], 'src/temp')).toBe(false)
  })

  it('前导 / 锚定：仅根级匹配（无前导 / 的单段名为任意层级）', () => {
    expect(ignored(['/build'], 'build', true)).toBe(true)
    expect(ignored(['/build'], 'build')).toBe(true) // 无尾 / 也匹配文件
    expect(ignored(['/build'], 'build/out/x.js')).toBe(false) // 子树由目录剪枝实现
    expect(ignored(['/build'], 'packages/app/build', true)).toBe(false)
    expect(ignored(['build'], 'packages/app/build', true)).toBe(true)
  })
})

describe('compileIgnoreRules - ** 跨段通配', () => {
  it('build、**、cache 三段模式：build 下任意深度（含零段）的 cache', () => {
    expect(ignored(['build/**/cache'], 'build/cache', true)).toBe(true)
    expect(ignored(['build/**/cache'], 'build/a/cache', true)).toBe(true)
    expect(ignored(['build/**/cache'], 'build/a/b/cache', true)).toBe(true)
    expect(ignored(['build/**/cache'], 'build/a/b/cache/x.js')).toBe(false) // 子树由 cache 目录剪枝实现
    expect(ignored(['build/**/cache'], 'dist/a/cache', true)).toBe(false)
    expect(ignored(['build/**/cache'], 'build/a/temp', true)).toBe(false)
  })

  it('尾部 ** 需至少一段：a/** 不匹配 a 自身（对齐 gitignore）', () => {
    expect(ignored(['a/**'], 'a')).toBe(false)
    expect(ignored(['a/**'], 'a', true)).toBe(false)
    expect(ignored(['a/**'], 'a/b')).toBe(true)
    expect(ignored(['a/**'], 'a/b/c')).toBe(true)
    expect(ignored(['a/**'], 'x/a/b')).toBe(false) // 多段锚定根
  })

  it('前缀 **/：显式写法与单段名等价（任意层级）', () => {
    expect(ignored(['**/temp'], 'temp', true)).toBe(true)
    expect(ignored(['**/temp'], 'a/b/temp', true)).toBe(true)
    expect(ignored(['**/temp'], 'a/temptation')).toBe(false)
  })

  it('** 与段内通配组合', () => {
    expect(ignored(['**/*.min.js'], 'app.min.js')).toBe(true)
    expect(ignored(['**/*.min.js'], 'dist/app.min.js')).toBe(true)
    expect(ignored(['**/*.min.js'], 'app.js')).toBe(false)
  })
})

describe('compileIgnoreRules - 段内 * 通配', () => {
  it('* 位置不限，可匹配零字符（glob 惯例）', () => {
    expect(ignored(['a*b'], 'ab')).toBe(true)
    expect(ignored(['a*b'], 'axb')).toBe(true)
    expect(ignored(['a*b'], 'a-very-long-b')).toBe(true)
    expect(ignored(['a*b'], 'a/b')).toBe(false) // 不跨段
    expect(ignored(['*cache'], 'my-cache')).toBe(true)
    expect(ignored(['temp*'], 'temporary')).toBe(true)
  })

  it('段内多个 * 组合', () => {
    expect(ignored(['a*c*e'], 'abcde')).toBe(true)
    expect(ignored(['a*c*e'], 'ace')).toBe(true) // 段内 * 可匹配零字符
    expect(ignored(['a*c*e'], 'abcd')).toBe(false)
  })
})

describe('compileIgnoreRules - 段内 ? 单字符与字符类（0.10.1）', () => {
  it('? 匹配恰好一个任意字符（不足/超出均不命中）', () => {
    expect(ignored(['lo?g'], 'loog')).toBe(true)
    expect(ignored(['lo?g'], 'loXg')).toBe(true)
    expect(ignored(['lo?g'], 'log')).toBe(false)
    expect(ignored(['lo?g'], 'looog')).toBe(false)
    expect(ignored(['?.txt'], 'a.txt')).toBe(true)
    expect(ignored(['?.txt'], 'ab.txt')).toBe(false)
  })

  it('? 不跨段（单段模式只与整段匹配）', () => {
    // 单段规则按路径段整体匹配：'a?c' 不命中 'a/c'（两段）
    expect(ignored(['a?c'], 'a/c')).toBe(false)
    expect(ignored(['src/??/temp'], 'src/ab/temp', true)).toBe(true)
    expect(ignored(['src/??/temp'], 'src/a/temp', true)).toBe(false)
  })

  it('? 与 * 组合', () => {
    expect(ignored(['*.?s'], 'a.ts')).toBe(true)
    expect(ignored(['*.?s'], 'a.tsx')).toBe(false)
    expect(ignored(['a?*c'], 'abxc')).toBe(true)
  })

  it('[abc] 字符类命中类内单字符', () => {
    expect(ignored(['*.[ch]'], 'main.c')).toBe(true)
    expect(ignored(['*.[ch]'], 'main.h')).toBe(true)
    expect(ignored(['*.[ch]'], 'main.o')).toBe(false)
    expect(ignored(['*.[ch]'], 'main.cc')).toBe(false)
  })

  it('[a-z] 范围类', () => {
    expect(ignored(['file[0-9].txt'], 'file5.txt')).toBe(true)
    expect(ignored(['file[0-9].txt'], 'fileA.txt')).toBe(false)
    expect(ignored(['[a-c]x'], 'bx')).toBe(true)
    expect(ignored(['[a-c]x'], 'dx')).toBe(false)
  })

  it('[!abc] 取反类', () => {
    expect(ignored(['[!a].txt'], 'b.txt')).toBe(true)
    expect(ignored(['[!a].txt'], 'a.txt')).toBe(false)
    expect(ignored(['[!0-9]x'], 'ax')).toBe(true)
    expect(ignored(['[!0-9]x'], '5x')).toBe(false)
  })

  it('字符类大小写不敏感（[A-Z] 等效 [a-z]，双侧小写化后匹配）', () => {
    expect(ignored(['[A-Z].txt'], 'g.txt')).toBe(true)
    expect(ignored(['[A-Z].txt'], 'G.TXT')).toBe(true)
    expect(ignored(['[A-Z].txt'], '5.txt')).toBe(false)
  })

  it('未闭合 [ 与孤立 [ 按字面量方括号处理（gitignore 同款）', () => {
    expect(ignored(['a[b'], 'a[b')).toBe(true)
    expect(ignored(['a[b'], 'aab')).toBe(false)
    expect(ignored(['x['], 'x[')).toBe(true)
  })

  it('空类体 [] 与 [!] 退化为字面量方括号', () => {
    expect(ignored(['a[]b'], 'a[]b')).toBe(true)
    expect(ignored(['a[]b'], 'ab')).toBe(false)
    expect(ignored(['a[!]b'], 'a[!]b')).toBe(true)
  })

  it('无法构成合法正则的类体（反转范围 [z-a]）整段回退字面量匹配，不崩溃', () => {
    expect(ignored(['[z-a].txt'], '[z-a].txt')).toBe(true)
    expect(ignored(['[z-a].txt'], 'a.txt')).toBe(false)
  })

  it('字符通配与前导 / 锚定组合（仅根级匹配）', () => {
    expect(ignored(['/build[0-9]'], 'build7')).toBe(true)
    expect(ignored(['/build[0-9]'], 'build7/dist')).toBe(false)
    expect(ignored(['/build[0-9]'], 'pkg/build7')).toBe(false)
  })

  it('既有 * 语义与段内 ** 非法判定不受影响（回归锚）', () => {
    expect(ignored(['a*b'], 'axb')).toBe(true)
    expect(ignored(['a*b'], 'ab')).toBe(true)
    expect(ignored(['*.log'], 'app.log')).toBe(true)
    expect(ignored(['a**b'], 'axxb')).toBe(false)
  })
})

describe('compileIgnoreRules - 否定规则（! 最后匹配优先）', () => {
  it('否定救回：同路径最后一条匹配规则生效', () => {
    const m = compileIgnoreRules(['*.log', '!keep.log'])
    expect(m.matchesPath('app.log')).toBe(true)
    expect(m.matchesPath('keep.log')).toBe(false)
    expect(m.matchesPath('sub/keep.log')).toBe(false) // *.log 与 !keep.log 均按路径命中
  })

  it('否定顺序反转：! 在前则被后规则重新忽略', () => {
    expect(ignored(['!keep.log', '*.log'], 'keep.log')).toBe(true)
  })

  it('否定目录路径本身（父目录被剪枝时子项实际救不回，gitignore 同款语义）', () => {
    const m = compileIgnoreRules(['temp/', '!temp/keep/'])
    expect(m.matchesPath('temp', true)).toBe(true) // temp 目录被忽略 → BFS 剪枝，keep 实际救不回
    expect(m.matchesPath('temp/keep', true)).toBe(false) // 匹配器层面不忽略（剪枝后不会被查询）
  })

  it('** + 否定：深层路径可被精确否定救回（父目录未被剪枝时）', () => {
    const m = compileIgnoreRules(['build/**/temp/', '!build/special/temp/'])
    expect(m.matchesPath('build/a/temp', true)).toBe(true)
    expect(m.matchesPath('build/special/temp', true)).toBe(false)
    expect(m.matchesPath('build/special/temp/x.js')).toBe(false)
  })

  it('父目录被剪枝后子项无法反否定（BFS 剪枝语义，与 gitignore 一致）', () => {
    // node_modules/ 忽略 node_modules 目录本身 → BFS 剪枝，keep 永远不被枚举
    // 匹配器层面体现为：node_modules/keep.js 不因 !node_modules/keep.js 而改变
    // node_modules 目录的判定（剪枝依据）只受匹配 node_modules 路径的规则影响
    const m = compileIgnoreRules(['node_modules/', '!node_modules/keep.js'])
    expect(m.matchesPath('node_modules', true)).toBe(true) // 目录仍被剪枝
    expect(m.matchesPath('node_modules/keep.js')).toBe(false) // 假如被枚举到则不忽略
  })

  it('否定 + 前导 / 锚定组合', () => {
    const m = compileIgnoreRules(['/dist', '!/dist'])
    expect(m.matchesPath('dist', true)).toBe(false)
  })
})

describe('compileIgnoreRules - invalid 无效规则清单', () => {
  it('注释与空白行不计入 invalid', () => {
    const m = compileIgnoreRules(['', '   ', '# 构建产物', 'dist/'])
    expect(m.invalid).toEqual([])
    expect(m.matchesPath('dist', true)).toBe(true)
  })

  it('段内 ** 为非法（仅允许整段 **）', () => {
    const m = compileIgnoreRules(['a**b', 'build/**'])
    expect(m.invalid).toEqual(['a**b'])
    expect(m.matchesPath('axxb')).toBe(false)
    expect(m.matchesPath('build/x')).toBe(true)
  })

  it('空段（a//b、仅 /、! 后为空）非法', () => {
    const m = compileIgnoreRules(['a//b', '/', '!', '!/', 'ok/'])
    expect(m.invalid).toEqual(['a//b', '/', '!', '!/'])
    expect(m.matchesPath('ok', true)).toBe(true)
  })

  it('规则首尾空白被 trim（trim 后仍非法的按原文 trim 记录）', () => {
    const m = compileIgnoreRules(['  node_modules/  ', '  a**b  '])
    expect(m.matchesPath('node_modules', true)).toBe(true)
    expect(m.invalid).toEqual(['a**b'])
  })

  it('空数组与全非法输入产出永不匹配的匹配器', () => {
    const empty = compileIgnoreRules([])
    expect(empty.matchesPath('node_modules', true)).toBe(false)
    expect(empty.matchesPath('a.log')).toBe(false)
    expect(empty.invalid).toEqual([])
    const allInvalid = compileIgnoreRules(['/', '!', 'a**b'])
    expect(allInvalid.matchesPath('anything')).toBe(false)
    expect(allInvalid.invalid).toEqual(['/', '!', 'a**b'])
  })

  it('超长单条规则（> 500 字符）被忽略并记入 invalid', () => {
    const long = 'x'.repeat(IGNORE_RULE_MAX_LEN + 1)
    const m = compileIgnoreRules([long])
    expect(m.matchesPath(long)).toBe(false)
    expect(m.invalid).toEqual([long])
  })

  it('条数超上限截断（第 51 条有效规则起不生效）', () => {
    const rules = Array.from({ length: IGNORE_RULES_MAX + 5 }, (_, i) => `d${i}/`)
    const m = compileIgnoreRules(rules)
    expect(m.matchesPath('d0', true)).toBe(true)
    expect(m.matchesPath(`d${IGNORE_RULES_MAX - 1}`, true)).toBe(true)
    expect(m.matchesPath(`d${IGNORE_RULES_MAX}`, true)).toBe(false)
  })
})

describe('isIgnoreRulesArray - IPC 防御性校验', () => {
  it('合法字符串数组通过', () => {
    expect(isIgnoreRulesArray([])).toBe(true)
    expect(isIgnoreRulesArray(['node_modules/', '*.log', 'build/**/cache', '!keep.log'])).toBe(true)
  })

  it('非数组 / 含非字符串 / 超条数 / 超长条目拒绝', () => {
    expect(isIgnoreRulesArray(null)).toBe(false)
    expect(isIgnoreRulesArray('node_modules/')).toBe(false)
    expect(isIgnoreRulesArray(['a', 42])).toBe(false)
    expect(isIgnoreRulesArray(Array.from({ length: IGNORE_RULES_MAX + 1 }, () => 'a'))).toBe(false)
    expect(isIgnoreRulesArray(['x'.repeat(IGNORE_RULE_MAX_LEN + 1)])).toBe(false)
  })
})
