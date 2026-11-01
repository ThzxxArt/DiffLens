import type { ScanCacheEntry } from './folderScan'
import { isIgnoreRulesArray } from '../shared/ignoreRules'

/**
 * folder:scan IPC 入参的防御性校验与增量缓存源选择（纯逻辑，无 electron/fs 依赖）。
 * 渲染端经 IPC 传入的数据不可信（跨进程边界），逐字段校验后由主进程 handler 组装扫描参数；
 * 此前该逻辑内联在 index.ts（覆盖率排除），抽出后可被 vitest 直接测试。
 */

/** previous（增量重扫缓存）是否为可接受的 IPC 形态：数组且每条含字符串 rel/status。
 *  只做形态级校验（渲染端数据来自上次扫描结果或损坏的偏好存储）；字段级合法性
 *  （指纹形态等）由 scanFolders 的指纹比对与 scanCacheStore 的解析校验兜底 */
export function isScanCacheEntries(v: unknown): v is ScanCacheEntry[] {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as ScanCacheEntry).rel === 'string' &&
        typeof (c as ScanCacheEntry).status === 'string'
    )
  )
}

export interface ResolvedScanArgs {
  /** 增量重扫缓存：渲染端携带的内存缓存优先（含空数组——同目录上次扫描的最新形态，
   *  阻止注入可能过期的盘上缓存）；形态非法/未携带时回退盘上持久化缓存；两者皆无则缺省 */
  previous?: ScanCacheEntry[]
  /** 忽略规则：仅接受合法字符串数组形态（isIgnoreRulesArray 校验，空数组合法），非法即忽略 */
  ignore?: string[]
}

/**
 * 组合 folder:scan 的入参校验与缓存源选择：
 * - previous 形态异常（非数组 / 条目缺字符串 rel/status）一律不沿用；
 * - previous 未携带或非法时经 loadStored 惰性读取盘上持久化缓存（非空才注入），
 *   惰性求值（await 仅在需要回退时发生）保证渲染端携带有效内存缓存时不产生读盘 IO；
 * - loadStored 可同步或异步（生产实现为 fs.promises 异步读盘，测试注入同步实现），
 *   异步化保证 IPC handler 内不再有同步 IO 阻塞主进程事件循环；
 * - ignoreRules 复用 isIgnoreRulesArray（数组形态 + 条数/单条长度上限）。
 */
export async function resolveScanArgs(
  previous: unknown,
  ignoreRules: unknown,
  loadStored: () => ScanCacheEntry[] | null | Promise<ScanCacheEntry[] | null>
): Promise<ResolvedScanArgs> {
  const mem = isScanCacheEntries(previous) ? previous : undefined
  const fallback = async (): Promise<ScanCacheEntry[] | undefined> => {
    const stored = await loadStored()
    return stored !== null && stored.length > 0 ? stored : undefined
  }
  const previousOut = mem !== undefined ? mem : await fallback()
  return {
    ...(previousOut !== undefined ? { previous: previousOut } : {}),
    ...(isIgnoreRulesArray(ignoreRules) ? { ignore: ignoreRules } : {})
  }
}
