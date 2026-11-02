import { app } from 'electron'
import fs from 'fs'
import { join } from 'path'
import {
  parseScanCacheStore,
  putScanCache,
  emptyScanCacheStore,
  type ScanCacheStoreData
} from './scanCacheStore'
import type { ScanCacheEntry } from './folderScan'

/** 文件夹扫描增量缓存的跨会话持久化文件，位于 userData 目录 */
const scanCacheFile = (): string => join(app.getPath('userData'), 'scan-cache.json')

/** 读取持久化扫描缓存存储：文件不存在/损坏回退空存储，不影响扫描。
 *  异步读盘（渲染端未携带内存缓存时在 folder:scan handler 内惰性触发）—— */
export async function loadScanCacheStore(): Promise<ScanCacheStoreData> {
  try {
    return parseScanCacheStore(await fs.promises.readFile(scanCacheFile(), 'utf-8'))
  } catch {
    return emptyScanCacheStore()
  }
}

/** 落盘扫描缓存（读-改-写，异步 fire-and-forget）：
 *  写操作经内存 promise 链串行执行，避免并发覆盖丢失 LRU 目录对。 */
let scanCacheWrites: Promise<void> = Promise.resolve()

export function persistScanCache(leftDir: string, rightDir: string, cache: ScanCacheEntry[]): void {
  scanCacheWrites = scanCacheWrites.then(() => writeScanCache(leftDir, rightDir, cache))
}

async function writeScanCache(
  leftDir: string,
  rightDir: string,
  cache: ScanCacheEntry[]
): Promise<void> {
  try {
    const next = putScanCache(await loadScanCacheStore(), leftDir, rightDir, cache, Date.now())
    await fs.promises.writeFile(scanCacheFile(), JSON.stringify(next), 'utf-8')
  } catch {
    // 忽略写入失败
  }
}
