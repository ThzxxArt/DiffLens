/**
 * 文件夹对比忽略规则的纯逻辑模块（无 electron/fs 依赖，vitest 直接测试）。
 * 位于 src/shared：主进程 folderScan 与渲染端 FolderView（无效规则提示）打包各自引用同一源文件，
 * 两进程无法共享运行时模块但可共享源码（与 preload 类型反向引用同理）。
 *
 * gitignore 简化子集（0.10.0 高级 glob，0.10.1 段内字符通配）：
 * - `name`：名字匹配（任意层级命中文件与目录）
 * - `name/`：目录名匹配（任意层级，仅目录）
 * - `*.ext` / `a*b`：段内 `*` 通配（匹配任意字符，位置不限；段即 / 切分的路径片段）
 * - `a?c` / `lo?g`：段内 `?` 单字符通配（匹配恰好一个字符，不跨段）
 * - `*.[ch]` / `log[0-9].txt` / `[!abc]`：段内字符类（支持范围与 `!` 取反）
 * - `src/temp`：多段路径（从根锚定匹配）
 * - `/build`：前导 `/` 锚定（仅根级匹配；无前导 `/` 的单段名为任意层级）
 * - `**`：整段跨段通配（匹配零或多段，如 build、**、cache 三段模式命中 build 下任意深度的
 *   cache；尾部 `**` 需至少一段——`a/**` 不匹配 a 自身，与 gitignore 一致）
 * - `!pattern`：否定规则（同一路径以最后一条匹配的规则为准，与 gitignore 一致）
 *
 * 语义约定：
 * - 大小写不敏感（Windows 文件系统语义）
 * - `#` 开头注释与空白行静默跳过（不计入无效规则）
 * - 父目录被剪枝后其子项无法被否定规则救回（BFS 剪枝语义，与 gitignore 一致）
 * - 非法规则（段内 `**`、空段、`!` 后为空、仅分隔符等）跳过并记入 invalid 清单供 UI 提示
 */

/** 规则条数上限（UI 与主进程 IPC 双重防御） */
export const IGNORE_RULES_MAX = 50
/** 单条规则长度上限 */
export const IGNORE_RULE_MAX_LEN = 500

/** 编译后的匹配器：对完整相对路径判定（含否定规则仲裁） */
export interface IgnoreMatcher {
  /** 相对路径（统一 / 分隔，含文件/目录自身）是否被忽略；isDir 缺省按文件判定 */
  matchesPath: (rel: string, isDir?: boolean) => boolean
  /** 被跳过的无效规则原文（供 UI 提示；注释与空白行不计入） */
  invalid: readonly string[]
}

/** 编译后的单段形态：字面量（=== 快路径）/ 段内通配（正则）/ 跨段通配 */
interface SegPattern {
  kind: 'literal' | 'wild' | 'globstar'
  /** literal 的字面值（已小写） */
  lit?: string
  /** wild 的整段正则（已锚定 ^$） */
  re?: RegExp
}

interface CompiledRule {
  /** 段序列（已编译；已小写） */
  segs: SegPattern[]
  /** 目录专用（尾部 /） */
  dirOnly: boolean
  /** 否定规则（! 前缀） */
  negate: boolean
  /** 从根锚定（多段或前导 /）；否则任意层级起匹配 */
  anchored: boolean
}

/** 单个非通配字符的正则转义（段内通配构造共用；`*` `?` `[` 由调用方先行分流） */
const escCh = (c: string): string => (/[$()*+.?[\\\]^{|}]/.test(c) ? '\\' + c : c)

/**
 * 解析 seg[start] 起始的字符类（`[abc]` / `[a-z]` / `[!abc]`）：
 * 返回正则片段与消费终点；未闭合或类体为空（`[]` / `[!]`）返回 null，
 * 调用方按字面量 `[` 处理（gitignore 同款语义）。
 * 类体仅转义反斜杠，`-` 保留以支持范围；非前导 `^` 在 JS 正则类内本就是字面量。
 */
function parseCharClass(seg: string, start: number): { re: string; next: number } | null {
  let j = start + 1
  let neg = false
  if (seg[j] === '!' || seg[j] === '^') {
    neg = true
    j++
  }
  let body = ''
  while (j < seg.length && seg[j] !== ']') {
    body += seg[j] === '\\' ? '\\\\' : seg[j]
    j++
  }
  if (j >= seg.length || body === '') return null
  return { re: `[${neg ? '^' : ''}${body}]`, next: j + 1 }
}

/**
 * 段内通配模式编译为锚定正则片段：
 * `*` = 任意字符（≥0 个）、`?` = 恰好一个字符、`[...]` = 字符类（含取反）；
 * 未闭合/空类与无法构成合法正则的类体（如反转范围 [z-a]）由调用方回退字面量。
 */
function wildSegRegex(seg: string): string {
  let out = ''
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (c === '*') {
      out += '.*'
      i++
    } else if (c === '?') {
      out += '.'
      i++
    } else if (c === '[') {
      const cls = parseCharClass(seg, i)
      if (cls === null) {
        out += '\\['
        i++
      } else {
        out += cls.re
        i = cls.next
      }
    } else {
      out += escCh(c)
      i++
    }
  }
  return out
}

/** 编译单条规则文本（调用方已做 trim）；返回 null 表示无效或为注释/空白行 */
function compileOne(rule: string): CompiledRule | null {
  if (rule.length === 0 || rule.length > IGNORE_RULE_MAX_LEN) return null
  if (rule.startsWith('#')) return null
  let body = rule
  let negate = false
  if (body.startsWith('!')) {
    negate = true
    body = body.slice(1)
  }
  let dirOnly = false
  if (body.endsWith('/')) {
    dirOnly = true
    body = body.slice(0, -1)
  }
  let anchored = false
  if (body.startsWith('/')) {
    anchored = true
    body = body.slice(1)
  }
  if (body.length === 0) return null
  const rawSegs = body.split('/')
  if (rawSegs.some((s) => s.length === 0)) return null
  if (rawSegs.some((s) => s.includes('**') && s !== '**')) return null
  if (rawSegs.length > 1) anchored = true
  const lower = rawSegs.map((s) => s.toLowerCase())
  const segs: SegPattern[] = lower.map((s) => {
    if (s === '**') return { kind: 'globstar' }
    // 含段内通配字符（* ? [）才走正则编译，纯字面量走 === 快路径
    if (!/[*?[]/.test(s)) return { kind: 'literal', lit: s }
    try {
      return { kind: 'wild', re: new RegExp('^' + wildSegRegex(s) + '$') }
    } catch {
      // 类体无法构成合法正则（如反转范围 [z-a]）：整段退回字面量匹配，永不崩溃
      return { kind: 'literal', lit: s }
    }
  })
  return { segs, dirOnly, negate, anchored }
}

/** 模式段序列是否匹配路径段序列（自后向前 DP）。
 *  `**` 跨零或多段；尾段 `**` 需至少一段（`a/**` 不含 a 自身，对齐 gitignore） */
function matchSegs(pat: SegPattern[], path: string[]): boolean {
  const P = pat.length
  const L = path.length
  // dp[i][j] = pat[i..] 匹配 path[j..]
  const dp: boolean[][] = Array.from({ length: P + 1 }, () => new Array<boolean>(L + 1).fill(false))
  dp[P][L] = true
  for (let i = P - 1; i >= 0; i--) {
    for (let j = L; j >= 0; j--) {
      const seg = pat[i]
      if (seg.kind === 'globstar') {
        dp[i][j] =
          i === P - 1
            ? j < L // 尾部 **：吞掉剩余全部段（至少一段）
            : dp[i + 1][j] || (j < L && dp[i][j + 1]) // 非尾部：跨零段或多段
      } else if (seg.kind === 'literal') {
        dp[i][j] = j < L && path[j] === seg.lit && dp[i + 1][j + 1]
      } else {
        dp[i][j] = j < L && seg.re!.test(path[j]) && dp[i + 1][j + 1]
      }
    }
  }
  return dp[0][0]
}

/** 单条规则是否匹配路径（dirOnly 仅匹配目录；非锚定规则任意起点起匹配） */
function ruleMatches(rule: CompiledRule, pathSegs: string[], isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false
  if (rule.anchored) return matchSegs(rule.segs, pathSegs)
  for (let k = 0; k < pathSegs.length; k++) {
    if (matchSegs(rule.segs, pathSegs.slice(k))) return true
  }
  return false
}

/** 规则数组是否为可接受的 IPC 形态（folder:scan 防御性校验共用） */
export function isIgnoreRulesArray(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= IGNORE_RULES_MAX &&
    v.every((r) => typeof r === 'string' && r.length <= IGNORE_RULE_MAX_LEN)
  )
}

/** 编译规则串数组为匹配器（空数组 / 全部非法 → 永不匹配的空匹配器） */
export function compileIgnoreRules(rules: readonly string[]): IgnoreMatcher {
  const compiled: CompiledRule[] = []
  const invalid: string[] = []
  for (const r of rules) {
    if (compiled.length >= IGNORE_RULES_MAX) break
    if (typeof r !== 'string') continue
    const trimmed = r.trim()
    const c = compileOne(trimmed)
    if (c) compiled.push(c)
    else if (trimmed !== '' && !trimmed.startsWith('#')) invalid.push(trimmed)
  }
  const matchesPath = (rel: string, isDir?: boolean): boolean => {
    if (rel === '') return false
    const dir = isDir === true
    const segs = rel.toLowerCase().split('/')
    // 否定仲裁：从后往前找第一条匹配的规则，其否定性决定结果（gitignore 语义）
    for (let i = compiled.length - 1; i >= 0; i--) {
      if (ruleMatches(compiled[i], segs, dir)) return !compiled[i].negate
    }
    return false
  }
  return { matchesPath, invalid }
}
