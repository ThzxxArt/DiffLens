import type { ScanCacheEntry } from './folderScan'
import { normDir } from '../shared/pathNorm'

/**
 * 文件夹扫描增量缓存的跨会话持久化纯数据模块（无 electron/fs 依赖，vitest 直接测试）。
 * 磁盘读写由主进程调用方完成（userData/scan-cache.json）。
 *
 * 结构：{ version, pairs: { [目录对键]: { cache, savedAt } } }
 * - 目录对键归一化：反斜杠→斜杠、去尾分隔符、Windows 盘符小写
 *   （D:\Foo 与 d:/Foo 同键；大小写敏感文件系统的路径不强制小写，避免误撞键）；
 * - LRU 上限 8 对，按 savedAt 淘汰最旧（正在写入的目录对永不淘汰）；
 * - 解析全部防御性校验：JSON 非法 / 版本不符 → 整体回退空存储；
 *   单条缓存条目形态异常 → 丢弃该条（pair 内其余条目保留）。
 */

/** 存储结构版本（不兼容变更时递增，旧文件整体作废） */
export const SCAN_CACHE_VERSION = 1
/** 保存的目录对数量上限（超出按 savedAt 淘汰最旧） */
export const SCAN_CACHE_PAIRS_MAX = 8

export interface StoredScanCache {
  cache: ScanCacheEntry[]
  /** 写入时间戳（LRU 淘汰依据） */
  savedAt: number
}

export interface ScanCacheStoreData {
  version: number
  pairs: Record<string, StoredScanCache>
}

/** 空存储（解析失败/文件不存在时的回退） */
export const emptyScanCacheStore = (): ScanCacheStoreData => ({
  version: SCAN_CACHE_VERSION,
  pairs: {}
})

/** 目录对键：两个归一化路径（shared/pathNorm）以 | 拼接（| 不出现在路径合法字符中） */
export function pairKey(leftDir: string, rightDir: string): string {
  return `${normDir(leftDir)}|${normDir(rightDir)}`
}

/** 缓存条目的合法状态值 */
const CACHE_STATUSES = ['same', 'semantic-same', 'different', 'left-only', 'right-only']

function isFingerprint(v: unknown): v is { size: number; mtime: number } {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Record<string, unknown>
  return (
    typeof f.size === 'number' &&
    Number.isFinite(f.size) &&
    typeof f.mtime === 'number' &&
    Number.isFinite(f.mtime)
  )
}

/** 单条缓存条目形态校验（盘上数据不可信，逐字段防御） */
function isCacheEntry(v: unknown): v is ScanCacheEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  if (typeof e.rel !== 'string' || e.rel === '') return false
  if (typeof e.status !== 'string' || !CACHE_STATUSES.includes(e.status)) return false
  if (e.leftFp !== null && !isFingerprint(e.leftFp)) return false
  if (e.rightFp !== null && !isFingerprint(e.rightFp)) return false
  if (e.semSame !== null && typeof e.semSame !== 'boolean') return false
  if (e.approximate !== undefined && typeof e.approximate !== 'boolean') return false
  return true
}

/**
 * 解析持久化文本为存储对象：JSON 非法 / 版本不符 / 顶层结构异常回退空存储；
 * 单个 pair 或单条 entry 异常仅丢弃该部分，其余保留。
 */
export function parseScanCacheStore(raw: string | null | undefined): ScanCacheStoreData {
  if (!raw) return emptyScanCacheStore()
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (obj.version !== SCAN_CACHE_VERSION) return emptyScanCacheStore()
    if (typeof obj.pairs !== 'object' || obj.pairs === null || Array.isArray(obj.pairs)) {
      return emptyScanCacheStore()
    }
    const pairs: Record<string, StoredScanCache> = {}
    for (const [key, val] of Object.entries(obj.pairs as Record<string, unknown>)) {
      if (typeof val !== 'object' || val === null) continue
      const p = val as Record<string, unknown>
      if (!Array.isArray(p.cache) || typeof p.savedAt !== 'number' || !Number.isFinite(p.savedAt)) {
        continue
      }
      const cache = p.cache.filter(isCacheEntry)
      pairs[key] = { cache, savedAt: p.savedAt }
    }
    return { version: SCAN_CACHE_VERSION, pairs }
  } catch {
    return emptyScanCacheStore()
  }
}

/**
 * 写入/更新一对目录的缓存（LRU 上限淘汰）：
 * 深拷贝条目（防调用方后续复用引用）；超上限按 savedAt 升序淘汰最旧，
 * 当前写入的目录对（savedAt = now，最新）不在淘汰之列。
 */
export function putScanCache(
  data: ScanCacheStoreData,
  leftDir: string,
  rightDir: string,
  cache: ScanCacheEntry[],
  now: number
): ScanCacheStoreData {
  const pairs: Record<string, StoredScanCache> = { ...data.pairs }
  const key = pairKey(leftDir, rightDir)
  pairs[key] = { cache: cache.map((c) => ({ ...c })), savedAt: now }
  const keys = Object.keys(pairs)
  if (keys.length > SCAN_CACHE_PAIRS_MAX) {
    const others = keys.filter((k) => k !== key).sort((a, b) => pairs[a].savedAt - pairs[b].savedAt)
    const overflow = keys.length - SCAN_CACHE_PAIRS_MAX
    for (let i = 0; i < overflow && i < others.length; i++) delete pairs[others[i]]
  }
  return { version: SCAN_CACHE_VERSION, pairs }
}

/** 读取一对目录的缓存（不存在返回 null，调用方按无缓存全量扫描） */
export function getScanCache(
  data: ScanCacheStoreData,
  leftDir: string,
  rightDir: string
): ScanCacheEntry[] | null {
  const hit = data.pairs[pairKey(leftDir, rightDir)]
  return hit !== undefined ? hit.cache : null
}
