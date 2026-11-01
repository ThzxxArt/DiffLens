import { describe, it, expect } from 'vitest'
import type { ScanCacheEntry } from './folderScan'
import {
  parseScanCacheStore,
  putScanCache,
  getScanCache,
  pairKey,
  emptyScanCacheStore,
  SCAN_CACHE_PAIRS_MAX,
  SCAN_CACHE_VERSION
} from './scanCacheStore'

/** 构造一条合法缓存条目 */
function entry(rel: string, status: ScanCacheEntry['status'] = 'same'): ScanCacheEntry {
  return { rel, leftFp: { size: 1, mtime: 100 }, rightFp: { size: 1, mtime: 100 }, status, semSame: null }
}

describe('pairKey - 目录对键归一化', () => {
  it('反斜杠转斜杠、去尾分隔符', () => {
    expect(pairKey('C:\\left\\', 'D:\\right\\')).toBe('c:/left|d:/right')
  })

  it('Windows 盘符大小写归一（其余路径段保留原大小写）', () => {
    expect(pairKey('d:/Foo', 'D:/Foo')).toBe('d:/Foo|d:/Foo')
    expect(pairKey('D:\\Foo', 'd:/Foo')).toBe('d:/Foo|d:/Foo')
    // 大小写敏感文件系统的不同路径不撞键
    expect(pairKey('/home/A', '/home/B')).toBe('/home/A|/home/B')
    expect(pairKey('/home/A', '/home/a')).not.toBe(pairKey('/home/A', '/home/A'))
  })
})

describe('parseScanCacheStore - 防御性解析', () => {
  it('空输入 / 非法 JSON / 版本不符回退空存储', () => {
    expect(parseScanCacheStore(null)).toEqual(emptyScanCacheStore())
    expect(parseScanCacheStore('')).toEqual(emptyScanCacheStore())
    expect(parseScanCacheStore('{broken json!!')).toEqual(emptyScanCacheStore())
    expect(parseScanCacheStore(JSON.stringify({ version: 999, pairs: {} }))).toEqual(
      emptyScanCacheStore()
    )
  })

  it('顶层结构异常（pairs 非对象）回退空存储', () => {
    expect(parseScanCacheStore(JSON.stringify({ version: 1, pairs: [] }))).toEqual(
      emptyScanCacheStore()
    )
    expect(parseScanCacheStore(JSON.stringify({ version: 1, pairs: 'x' }))).toEqual(
      emptyScanCacheStore()
    )
  })

  it('形态异常的 pair 被丢弃，合法 pair 保留', () => {
    const raw = JSON.stringify({
      version: 1,
      pairs: {
        'a|b': { cache: [entry('x.txt')], savedAt: 100 },
        bad: { cache: 'not-array', savedAt: 100 },
        bad2: { cache: [entry('y.txt')], savedAt: 'no-time' },
        bad3: null
      }
    })
    const data = parseScanCacheStore(raw)
    expect(Object.keys(data.pairs)).toEqual(['a|b'])
    expect(getScanCache(data, 'a', 'b')).toEqual([entry('x.txt')])
  })

  it('单条异常 entry 被过滤，其余条目保留', () => {
    const good = entry('keep.txt')
    const raw = JSON.stringify({
      version: 1,
      pairs: {
        'a|b': {
          cache: [
            good,
            { rel: 'x', status: 'unknown-status', leftFp: null, rightFp: null, semSame: null },
            { rel: '', status: 'same', leftFp: null, rightFp: null, semSame: null },
            { rel: 'y', status: 'same', leftFp: { size: 'big', mtime: 1 }, rightFp: null, semSame: null },
            { rel: 'z', status: 'same', leftFp: null, rightFp: null, semSame: 'maybe' },
            'garbage'
          ],
          savedAt: 200
        }
      }
    })
    const data = parseScanCacheStore(raw)
    expect(getScanCache(data, 'a', 'b')).toEqual([good])
  })
})

describe('putScanCache / getScanCache - 写入读取与 LRU', () => {
  it('写入后可按归一化键读取（盘上路径写法差异同键）', () => {
    let data = emptyScanCacheStore()
    data = putScanCache(data, 'C:\\left', 'D:\\right', [entry('a.txt')], 1000)
    expect(getScanCache(data, 'c:/left', 'd:/right')).toEqual([entry('a.txt')])
  })

  it('未写入的目录对返回 null', () => {
    const data = putScanCache(emptyScanCacheStore(), 'a', 'b', [entry('a.txt')], 1000)
    expect(getScanCache(data, 'x', 'y')).toBeNull()
  })

  it('写入条目为深拷贝（源数组后续修改不影响存储）', () => {
    const src = [entry('a.txt')]
    const data = putScanCache(emptyScanCacheStore(), 'a', 'b', src, 1000)
    src[0].rel = 'mutated.txt'
    expect(getScanCache(data, 'a', 'b')![0].rel).toBe('a.txt')
  })

  it('同目录对重复写入覆盖旧缓存', () => {
    let data = putScanCache(emptyScanCacheStore(), 'a', 'b', [entry('old.txt')], 1000)
    data = putScanCache(data, 'a', 'b', [entry('new.txt')], 2000)
    expect(getScanCache(data, 'a', 'b')!.map((c) => c.rel)).toEqual(['new.txt'])
    expect(Object.keys(data.pairs)).toHaveLength(1)
  })

  it(`超上限（${SCAN_CACHE_PAIRS_MAX} 对）按 savedAt 淘汰最旧，当前写入对保留`, () => {
    let data = emptyScanCacheStore()
    // 先写满 8 对，时间递增
    for (let i = 0; i < SCAN_CACHE_PAIRS_MAX; i++) {
      data = putScanCache(data, `l${i}`, `r${i}`, [entry(`f${i}.txt`)], 1000 + i)
    }
    // 第 9 对写入：最旧的 l0|r0 被淘汰
    data = putScanCache(data, 'newL', 'newR', [entry('new.txt')], 9000)
    expect(Object.keys(data.pairs)).toHaveLength(SCAN_CACHE_PAIRS_MAX)
    expect(getScanCache(data, 'l0', 'r0')).toBeNull()
    expect(getScanCache(data, 'l1', 'r1')).not.toBeNull()
    expect(getScanCache(data, 'newL', 'newR')).not.toBeNull()
  })

  it('重写旧目录对更新其 savedAt：下次淘汰跳过它', () => {
    let data = emptyScanCacheStore()
    for (let i = 0; i < SCAN_CACHE_PAIRS_MAX; i++) {
      data = putScanCache(data, `l${i}`, `r${i}`, [entry(`f${i}.txt`)], 1000 + i)
    }
    // 刷新最旧的 l0（savedAt 1000 → 8000）
    data = putScanCache(data, 'l0', 'r0', [entry('fresh.txt')], 8000)
    // 新对写入：淘汰的应是最旧的 l1（1001）
    data = putScanCache(data, 'newL', 'newR', [entry('new.txt')], 9000)
    expect(getScanCache(data, 'l0', 'r0')![0].rel).toBe('fresh.txt')
    expect(getScanCache(data, 'l1', 'r1')).toBeNull()
  })
})

describe('putScanCache 产出的存储可被 parseScanCacheStore 往返', () => {
  it('序列化 → 解析后条目与键完整保留', () => {
    let data = emptyScanCacheStore()
    data = putScanCache(data, 'C:\\l', 'D:\\r', [entry('a.txt', 'different')], 12345)
    const parsed = parseScanCacheStore(JSON.stringify(data))
    expect(parsed.version).toBe(SCAN_CACHE_VERSION)
    expect(getScanCache(parsed, 'c:/l', 'd:/r')).toEqual([entry('a.txt', 'different')])
  })
})
