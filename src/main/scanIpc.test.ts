import { describe, it, expect } from 'vitest'
import type { ScanCacheEntry } from './folderScan'
import { isScanCacheEntries, resolveScanArgs } from './scanIpc'

/** 构造一条合法缓存条目（IPC 形态校验只看 rel/status 字符串字段） */
function entry(rel: string): ScanCacheEntry {
  return {
    rel,
    leftFp: { size: 1, mtime: 100 },
    rightFp: { size: 1, mtime: 100 },
    status: 'same',
    semSame: null
  }
}

/** 盘上缓存读取 stub：返回指定缓存并记录调用 */
function storedLoader(
  cache: ScanCacheEntry[] | null
): (() => ScanCacheEntry[] | null) & { calls: number } {
  const f = (): ScanCacheEntry[] | null => {
    f.calls++
    return cache
  }
  f.calls = 0
  return f
}

describe('isScanCacheEntries - IPC 形态校验', () => {
  it('合法缓存数组通过（rel/status 为字符串）', () => {
    expect(isScanCacheEntries([])).toBe(true)
    expect(isScanCacheEntries([entry('a.txt'), entry('b.txt')])).toBe(true)
  })

  it('非数组 / 含非对象 / rel 或 status 非字符串拒绝', () => {
    expect(isScanCacheEntries(null)).toBe(false)
    expect(isScanCacheEntries(undefined)).toBe(false)
    expect(isScanCacheEntries('cache')).toBe(false)
    expect(isScanCacheEntries([entry('a.txt'), null])).toBe(false)
    expect(isScanCacheEntries([entry('a.txt'), 'garbage'])).toBe(false)
    expect(isScanCacheEntries([{ rel: 42, status: 'same' }])).toBe(false)
    expect(isScanCacheEntries([{ rel: 'a.txt', status: 1 }])).toBe(false)
    expect(isScanCacheEntries([{ rel: 'a.txt' }])).toBe(false)
  })
})

describe('resolveScanArgs - 缓存源选择与忽略规则校验', () => {
  it('渲染端携带合法内存缓存：原样传递且不读盘（惰性）', async () => {
    const stored = storedLoader([entry('disk.txt')])
    const mem = [entry('mem.txt')]
    const r = await resolveScanArgs(mem, undefined, stored)
    expect(r.previous).toBe(mem)
    expect(stored.calls).toBe(0)
  })

  it('内存缓存为空数组（合法形态）：使用空数组，同样不注入盘上缓存', async () => {
    // 空数组是同目录上次扫描的最新形态（如空目录对），应优先于可能过期的盘上缓存
    const stored = storedLoader([entry('disk.txt')])
    const r = await resolveScanArgs([], undefined, stored)
    expect(r.previous).toEqual([])
    expect(stored.calls).toBe(0)
  })

  it('未携带 / 形态非法的内存缓存：回退盘上缓存（惰性读盘一次）', async () => {
    const disk = [entry('disk.txt')]
    for (const bad of [undefined, null, 'x', [{ rel: 1, status: 'same' }]] as unknown[]) {
      const stored = storedLoader(disk)
      const r = await resolveScanArgs(bad, undefined, stored)
      expect(r.previous).toBe(disk)
      expect(stored.calls).toBe(1)
    }
  })

  it('盘上缓存为 null 或空数组：不注入 previous（全量扫描）', async () => {
    expect(
      (await resolveScanArgs(undefined, undefined, storedLoader(null))).previous
    ).toBeUndefined()
    expect((await resolveScanArgs(undefined, undefined, storedLoader([]))).previous).toBeUndefined()
  })

  it('loadStored 为异步实现（生产 fs.promises 读盘）同样正确回退', async () => {
    // 0.10.3 异步化：生产 loadStored 返回 Promise，同步 stub 与异步 stub 行为一致
    const disk = [entry('disk.txt')]
    const asyncLoader = async (): Promise<ScanCacheEntry[] | null> => disk
    const r = await resolveScanArgs(undefined, undefined, asyncLoader)
    expect(r.previous).toBe(disk)
  })

  it('忽略规则合法字符串数组传递（空数组合法）', async () => {
    expect(
      (await resolveScanArgs(undefined, ['node_modules/', '*.log'], storedLoader(null))).ignore
    ).toEqual(['node_modules/', '*.log'])
    expect((await resolveScanArgs(undefined, [], storedLoader(null))).ignore).toEqual([])
  })

  it('忽略规则非法形态（非数组/含非字符串/超条数）整体忽略', async () => {
    expect((await resolveScanArgs(undefined, null, storedLoader(null))).ignore).toBeUndefined()
    expect(
      (await resolveScanArgs(undefined, 'node_modules/', storedLoader(null))).ignore
    ).toBeUndefined()
    expect((await resolveScanArgs(undefined, ['a', 42], storedLoader(null))).ignore).toBeUndefined()
    expect(
      (
        await resolveScanArgs(
          undefined,
          Array.from({ length: 51 }, () => 'a'),
          storedLoader(null)
        )
      ).ignore
    ).toBeUndefined()
  })

  it('组合：内存缓存非法 + 忽略规则合法 + 盘上缓存有效', async () => {
    const disk = [entry('disk.txt')]
    const stored = storedLoader(disk)
    const r = await resolveScanArgs([{ rel: 'bad' }], ['dist/'], stored)
    expect(r.previous).toBe(disk)
    expect(r.ignore).toEqual(['dist/'])
    expect(stored.calls).toBe(1)
  })
})
