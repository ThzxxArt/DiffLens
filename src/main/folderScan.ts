import { readdir, stat, readFile, open } from 'fs/promises'
import { join } from 'path'
import { compileIgnoreRules, type IgnoreMatcher } from '../shared/ignoreRules'

/**
 * 文件夹对比的纯逻辑模块（仅依赖 node:fs，vitest 以真实临时目录直接测试）。
 * 递归枚举两侧目录（跳过 symlink 防环）、按相对路径对齐、字节级内容判定；
 * 全部 IO 走异步 fs（libuv 线程池），不阻塞主进程事件循环。
 */

/** 单个文件条目的对比状态 */
export type FolderEntryStatus =
  'same' | 'semantic-same' | 'different' | 'left-only' | 'right-only' | 'unreadable'

export interface FolderEntry {
  /** 相对路径（统一 / 分隔，含子目录前缀） */
  rel: string
  status: FolderEntryStatus
  /** 左侧文件字节数；该侧不存在为 null */
  leftSize: number | null
  /** 右侧文件字节数；该侧不存在为 null */
  rightSize: number | null
  /** 超过全量比对上限、仅采样头部判定的近似结果（status 为 same 时可能出现） */
  approximate?: boolean
}

/** 单侧文件指纹（size + mtimeMs）：增量重扫的"内容是否变化"判定依据。
 *  与 rsync/make 同款取舍：mtime 未变即视为内容未变（手动改回时间戳的极端场景不防） */
export interface FileFingerprint {
  size: number
  mtime: number
}

/**
 * 增量重扫的缓存条目：上次扫描的单条判定结果（按双侧指纹沿用，避免重复 IO）。
 * - status 为 same（含采样近似）/ only 类：指纹一致即可零 IO 沿用；
 * - 字节不同类（different / semantic-same）：semSame 非 null 时语义开关翻转可纯内存
 *   组合出新状态（different ↔ semantic-same 零 IO），null 表示上次未参与语义判定；
 * - unreadable（被锁/权限）不进缓存：下次重扫重试。
 */
export interface ScanCacheEntry {
  rel: string
  leftFp: FileFingerprint | null
  rightFp: FileFingerprint | null
  status: 'same' | 'semantic-same' | 'different' | 'left-only' | 'right-only'
  approximate?: boolean
  /** 上次是否参与过语义判等及其结果（null = 未参与：语义关闭 / 非文本 / 超大小上限） */
  semSame: boolean | null
}

export interface ScanResult {
  /** 全部条目（按相对路径字典序排序） */
  entries: FolderEntry[]
  /** 因超出文件数量上限被截断（条目不完整，界面提示人工确认） */
  truncated: boolean
  /** 枚举发现的文件总数（截断时为已遍历下限：凑满上限即停止深入，不再统计剩余子树） */
  total: number
  /** 本次结果生成的增量重扫缓存（unreadable 不含；截断时为空数组——条目不完整不可信） */
  cache: ScanCacheEntry[]
}

export interface ScanOptions {
  /** 单侧文件数量上限（默认 10000） */
  maxFiles?: number
  /** 全量字节比对的文件大小上限（默认 10MB，超出仅采样头部 8KB 近似判定） */
  maxContentBytes?: number
  /** 语义判等（可选）：字节级判 different 的文本文件二次判等，剔除空白后一致 → semantic-same */
  semantic?: SemanticOptions
  /** 增量重扫缓存（可选）：上次扫描返回的 cache，指纹一致的条目零 IO 沿用判定 */
  previous?: ScanCacheEntry[]
  /**
   * 忽略规则（gitignore 简化子集含高级 glob，可选）：按完整相对路径判定——
   * 命中的目录整树剪枝（不枚举不计数，被忽略项不占用 maxFiles 也不计入 total/truncated）、
   * 命中的文件跳过。支持多段路径 / `**` 跨段 / 段内 `*` 通配 / `!` 否定（最后匹配优先）。
   * 规则变化的缓存失效由指纹机制天然覆盖：未命中条目走全量判定。
   */
  ignore?: string[]
  /**
   * 比对进度回调（可选）：需读内容的条目按受控并发分批比对，每批完成后触发一次；
   * done 为已完成条目数，total 为需读内容的条目总数（缓存命中的零 IO 条目不计入）。
   */
  onProgress?: (done: number, total: number) => void
}

/**
 * 语义判等的依赖注入（folderScan 保持纯逻辑可测，解码与扩展名判定由调用方注入）。
 * 生产环境 decode 走主进程解码 worker（大缓冲不阻塞事件循环），测试注入同步实现。
 */
export interface SemanticOptions {
  /** 参与语义判等的单侧文件大小上限 */
  maxBytes: number
  /** 相对路径是否为文本文件（按扩展名判定，与打开文件对话框的清单对齐） */
  isTextFile: (rel: string) => boolean
  /** 解码文件字节为文本（BOM/编码探测由注入实现处理） */
  decode: (buf: Buffer) => Promise<string>
}

export { SEMANTIC_MAX_BYTES } from '../shared/limits'

/**
 * 语义判等：剔除全部空白（含换行，与字符级对比的判等语义一致）后拼接比较；
 * 大小写敏感（大小写差异在代码中多为实质差异，不忽略）。
 * 换行符 CRLF/LF、行尾空白、缩进、空行数量、排版重排（含跨行重组）均不构成差异。
 */
export function semanticEquals(left: string, right: string): boolean {
  const n = (s: string): string => s.replace(/\s+/g, '')
  return n(left) === n(right)
}

export const FOLDER_MAX_FILES = 10000
export const FOLDER_MAX_CONTENT_BYTES = 10 * 1024 * 1024
/** 近似判定的采样头部字节数 */
const SAMPLE_BYTES = 8 * 1024

/**
 * 内容比对的受控并发数：单侧缺失/大小不同直接判定（无 IO），
 * 大小一致的条目按此并发分批读取比对（批内 Promise.all，批间串行）。
 * 大目录下避免逐文件串行等待 IO；批内左右两文件也并行，实际排队 IO 约 2 倍并发。
 */
export const SCAN_CONCURRENCY = 16

/**
 * 手写 BFS 遍历目录树收集普通文件（相对路径统一 / 分隔，跳过 symlink 防环），
 * 凑满 maxFiles 即停止深入：readdir({recursive:true}) 只能枚举完整棵树、无法提前终止，
 * 误选超大目录（如含 node_modules）时枚举本身耗时数秒。
 * 截断后 total 为已遍历部分的文件数下限（剩余子树不再统计）。
 */
async function listFiles(
  root: string,
  maxFiles: number,
  ignore?: IgnoreMatcher
): Promise<{ files: Map<string, FileFingerprint>; truncated: boolean; total: number }> {
  const rels: string[] = []
  let total = 0
  let truncated = false
  const queue: Array<{ dir: string; prefix: string }> = [{ dir: root, prefix: '' }]
  while (queue.length > 0) {
    const { dir, prefix } = queue.shift()!
    // 单个目录不可读（权限/被锁）：跳过该目录继续扫描其余部分，不整体失败
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      // Dirent 为 lstat 语义：symlink 既非 file 也非 directory，天然跳过（防环）
      if (d.isDirectory()) {
        // 忽略规则按完整相对路径判定（支持多段/**/否定）：命中目录整树剪枝
        const rel = prefix === '' ? d.name : `${prefix}/${d.name}`
        if (ignore?.matchesPath(rel, true)) continue
        queue.push({ dir: join(dir, d.name), prefix: rel })
      } else if (d.isFile()) {
        // 命中的文件跳过（不计数，不占用 maxFiles）
        const rel = prefix === '' ? d.name : `${prefix}/${d.name}`
        if (ignore?.matchesPath(rel, false)) continue
        total++
        if (rels.length >= maxFiles) {
          truncated = true
        } else {
          rels.push(rel)
        }
      }
    }
    // 凑满即停：不再处理队列中剩余的子目录（当前目录统计完整，保证确定性）
    if (truncated) break
  }
  // 并行 stat（libuv 线程池排队，文件数量受 maxFiles 约束）；
  // 保留 size + mtimeMs 作为增量重扫指纹；单文件 stat 失败（被锁/权限）跳过该条目，不整体失败
  const stats = await Promise.allSettled(rels.map((rel) => stat(join(root, rel))))
  const files = new Map<string, FileFingerprint>()
  rels.forEach((rel, i) => {
    const s = stats[i]
    if (s.status === 'fulfilled') {
      files.set(rel, { size: s.value.size, mtime: s.value.mtimeMs })
    }
  })
  return { files, truncated, total }
}

/** 读取文件头部指定字节数（近似判定采样） */
async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * 对比两个文件夹：按相对路径对齐条目并判定内容异同。
 * 判定规则：单侧缺失 → only；大小一致且 ≤ maxContentBytes → 全量字节比对；
 * 大小不同（≤ 语义上限）或字节不同 → 字节级 different（开启语义判等时二次判等，
 * 剔除空白后一致改判 semantic-same）；超过全量比对上限 → 头部 8KB 采样近似判定。
 * 需读内容的条目按 SCAN_CONCURRENCY 受控并发执行（输出与顺序和串行实现完全一致）；
 * 单文件/单目录 IO 失败（被锁/权限，如 Windows Defender 占用）降级处理——
 * 文件标记 unreadable、目录跳过，不整体失败（大目录下单点锁不应丢弃全部结果）。
 *
 * 增量重扫（options.previous，本次枚举未截断时启用）：双侧指纹（size+mtime）与上次
 * 一致的条目零 IO 沿用判定——same/only 直接沿用；字节不同类在语义开关翻转时按缓存
 * semSame 纯内存组合（different ↔ semantic-same），仅"上次未参与语义判定而本次需要"
 * 的条目读内容补判。上次或本次截断、unreadable 条目不享用缓存（全量重判/重试）。
 */
export async function scanFolders(
  leftDir: string,
  rightDir: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const maxFiles = options.maxFiles ?? FOLDER_MAX_FILES
  const maxContentBytes = options.maxContentBytes ?? FOLDER_MAX_CONTENT_BYTES
  const semantic = options.semantic
  // 忽略规则编译一次双侧共用；空数组（无有效规则）不构造匹配器，走原有路径
  const ignore =
    options.ignore !== undefined && options.ignore.length > 0
      ? compileIgnoreRules(options.ignore)
      : undefined
  const left = await listFiles(leftDir, maxFiles, ignore)
  const right = await listFiles(rightDir, maxFiles, ignore)

  /** 条目是否参与语义判等：双侧存在、均在大小上限内、文本扩展名 */
  const semanticEligible = (rel: string, lSize: number, rSize: number): boolean =>
    semantic !== undefined &&
    lSize <= semantic.maxBytes &&
    rSize <= semantic.maxBytes &&
    semantic.isTextFile(rel)

  /** 本次或上次截断：条目集不完整，缓存不可信（本次产出的 cache 也置空） */
  const useCache = options.previous !== undefined && !left.truncated && !right.truncated
  const prevMap = new Map((useCache ? options.previous! : []).map((c) => [c.rel, c]))

  const rels = [...new Set([...left.files.keys(), ...right.files.keys()])].sort()
  // 预分配结果槽位：缓存命中/无 IO 的条目直接定案，需读内容的条目收集为任务并发执行
  const entries: FolderEntry[] = new Array(rels.length)
  const cache: Array<ScanCacheEntry | undefined> = new Array(rels.length)
  const tasks: { idx: number; run: () => Promise<void> }[] = []

  /** 双侧指纹与缓存条目一致（含单侧缺失形状一致；mtime 未变视为内容未变） */
  const fpHit = (
    prev: ScanCacheEntry,
    lFp: FileFingerprint | undefined,
    rFp: FileFingerprint | undefined
  ): boolean => {
    if ((prev.leftFp === null) !== (lFp === undefined)) return false
    if ((prev.rightFp === null) !== (rFp === undefined)) return false
    if (lFp !== undefined && (prev.leftFp!.size !== lFp.size || prev.leftFp!.mtime !== lFp.mtime))
      return false
    if (rFp !== undefined && (prev.rightFp!.size !== rFp.size || prev.rightFp!.mtime !== rFp.mtime))
      return false
    return true
  }

  rels.forEach((rel, idx) => {
    const lFp = left.files.get(rel)
    const rFp = right.files.get(rel)
    const lSize = lFp !== undefined ? lFp.size : null
    const rSize = rFp !== undefined ? rFp.size : null
    const prev = prevMap.get(rel)

    // ===== 增量缓存命中：零 IO 组合判定 =====
    if (prev !== undefined && fpHit(prev, lFp, rFp)) {
      if (prev.status === 'same') {
        entries[idx] = {
          rel,
          status: 'same',
          leftSize: lSize,
          rightSize: rSize,
          ...(prev.approximate ? { approximate: true } : {})
        }
        cache[idx] = prev
        return
      }
      if (prev.status === 'left-only' || prev.status === 'right-only') {
        entries[idx] = { rel, status: prev.status, leftSize: lSize, rightSize: rSize }
        cache[idx] = prev
        return
      }
      // 字节不同类：语义关闭或不适用 → different；开启且上次参与过 → 按 semSame 组合；
      // 开启但上次未参与（semSame null）→ 落到全量判定补判
      const semActive = semantic !== undefined && semanticEligible(rel, lSize ?? 0, rSize ?? 0)
      if (!semActive) {
        entries[idx] = { rel, status: 'different', leftSize: lSize, rightSize: rSize }
        cache[idx] = { ...prev, status: 'different' }
        return
      }
      if (prev.semSame !== null) {
        const status = prev.semSame ? 'semantic-same' : 'different'
        entries[idx] = { rel, status, leftSize: lSize, rightSize: rSize }
        cache[idx] = { ...prev, status }
        return
      }
    }

    // ===== 全量判定（缓存未命中 / 语义补判）=====
    if (lFp === undefined) {
      entries[idx] = { rel, status: 'right-only', leftSize: null, rightSize: rSize }
      cache[idx] = {
        rel,
        leftFp: null,
        rightFp: rFp ?? null,
        status: 'right-only',
        semSame: null
      }
    } else if (rFp === undefined) {
      entries[idx] = { rel, status: 'left-only', leftSize: lSize, rightSize: null }
      cache[idx] = { rel, leftFp: lFp, rightFp: null, status: 'left-only', semSame: null }
    } else if (lFp.size !== rFp.size && !semanticEligible(rel, lFp.size, rFp.size)) {
      // 大小不同且不参与语义判等（未开启/超上限/非文本）：无需读内容直接定案
      entries[idx] = { rel, status: 'different', leftSize: lSize, rightSize: rSize }
      cache[idx] = { rel, leftFp: lFp, rightFp: rFp, status: 'different', semSame: null }
    } else if (lFp.size === rFp.size && lFp.size > maxContentBytes) {
      // 大小一致但超过全量比对上限：头部采样近似判定，结果带 approximate 标注；
      // 单文件读取失败（被锁/权限，如 Windows Defender 占用）标记 unreadable，不整体失败
      tasks.push({
        idx,
        run: async () => {
          try {
            const [lHead, rHead] = await Promise.all([
              readHead(join(leftDir, rel), SAMPLE_BYTES),
              readHead(join(rightDir, rel), SAMPLE_BYTES)
            ])
            const same = lHead.equals(rHead)
            entries[idx] = same
              ? { rel, status: 'same', leftSize: lSize, rightSize: rSize, approximate: true }
              : { rel, status: 'different', leftSize: lSize, rightSize: rSize }
            cache[idx] = {
              rel,
              leftFp: lFp,
              rightFp: rFp,
              status: same ? 'same' : 'different',
              ...(same ? { approximate: true } : {}),
              semSame: null
            }
          } catch {
            entries[idx] = { rel, status: 'unreadable', leftSize: lSize, rightSize: rSize }
          }
        }
      })
    } else {
      // 大小一致（≤ 上限）全量字节比对；大小不同且均在语义上限内读两侧全量。
      // 字节 different 且开启语义判等时：同一批读取上接语义判等（避免二次 IO）；
      // 单文件读取/解码失败（被锁/权限）标记 unreadable，不整体失败
      tasks.push({
        idx,
        run: async () => {
          try {
            const [lBuf, rBuf] = await Promise.all([
              readFile(join(leftDir, rel)),
              readFile(join(rightDir, rel))
            ])
            if (lBuf.equals(rBuf)) {
              entries[idx] = { rel, status: 'same', leftSize: lSize, rightSize: rSize }
              cache[idx] = { rel, leftFp: lFp, rightFp: rFp, status: 'same', semSame: null }
              return
            }
            if (semanticEligible(rel, lFp!.size, rFp!.size)) {
              const [lt, rt] = await Promise.all([semantic!.decode(lBuf), semantic!.decode(rBuf)])
              if (semanticEquals(lt, rt)) {
                entries[idx] = { rel, status: 'semantic-same', leftSize: lSize, rightSize: rSize }
                cache[idx] = {
                  rel,
                  leftFp: lFp,
                  rightFp: rFp,
                  status: 'semantic-same',
                  semSame: true
                }
                return
              }
              entries[idx] = { rel, status: 'different', leftSize: lSize, rightSize: rSize }
              cache[idx] = {
                rel,
                leftFp: lFp,
                rightFp: rFp,
                status: 'different',
                semSame: false
              }
              return
            }
            entries[idx] = { rel, status: 'different', leftSize: lSize, rightSize: rSize }
            cache[idx] = { rel, leftFp: lFp, rightFp: rFp, status: 'different', semSame: null }
          } catch {
            entries[idx] = { rel, status: 'unreadable', leftSize: lSize, rightSize: rSize }
          }
        }
      })
    }
  })
  // 受控并发分批执行（批内并行、批间串行；单任务失败已在任务内部降级为 unreadable）；
  // 每批完成触发一次进度回调（调用方推送 UI 进度，异常由调用方防御）
  for (let i = 0; i < tasks.length; i += SCAN_CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + SCAN_CONCURRENCY).map((t) => t.run()))
    const done = Math.min(i + SCAN_CONCURRENCY, tasks.length)
    try {
      options.onProgress?.(done, tasks.length)
    } catch {
      // 进度回调异常不影响扫描
    }
  }
  const truncated = left.truncated || right.truncated
  return {
    entries,
    truncated,
    total: Math.max(left.total, right.total),
    // 截断时条目不完整：cache 置空防止下次误沿用（unreadable 槽位本就为 undefined）
    cache: truncated ? [] : (cache.filter((c) => c !== undefined) as ScanCacheEntry[])
  }
}
