import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  scanFolders,
  semanticEquals,
  SEMANTIC_MAX_BYTES,
  type FolderEntry
} from './folderScan'

/** 以临时目录为根构造两个待对比文件夹 */
let leftDir: string
let rightDir: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'difflens-scan-'))
  leftDir = join(root, 'left')
  rightDir = join(root, 'right')
  await mkdir(leftDir, { recursive: true })
  await mkdir(rightDir, { recursive: true })
})

afterAll(async () => {
  await rm(join(leftDir, '..'), { recursive: true, force: true })
})

async function put(dir: 'left' | 'right', rel: string, content: string | Buffer): Promise<void> {
  const path = join(dir === 'left' ? leftDir : rightDir, rel)
  const idx = rel.lastIndexOf('/')
  if (idx >= 0) await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

const byRel = (entries: FolderEntry[], rel: string): FolderEntry | undefined =>
  entries.find((e) => e.rel === rel)

describe('scanFolders - 状态判定', () => {
  it('两侧内容一致判为 same，内容不同（同大小）判为 different，大小不同判为 different', async () => {
    await put('left', 'same.txt', 'hello')
    await put('right', 'same.txt', 'hello')
    await put('left', 'content-diff.txt', 'abc')
    await put('right', 'content-diff.txt', 'abd')
    await put('left', 'size-diff.txt', 'short')
    await put('right', 'size-diff.txt', 'much longer text')

    const r = await scanFolders(leftDir, rightDir)
    expect(r.truncated).toBe(false)
    expect(byRel(r.entries, 'same.txt')).toMatchObject({ status: 'same', leftSize: 5, rightSize: 5 })
    expect(byRel(r.entries, 'content-diff.txt')?.status).toBe('different')
    expect(byRel(r.entries, 'size-diff.txt')).toMatchObject({ status: 'different' })
  })

  it('单侧缺失判为 only，大小字段另一侧为 null', async () => {
    await put('left', 'only-left.txt', 'L')
    await put('right', 'only-right.txt', 'R')
    const r = await scanFolders(leftDir, rightDir)
    expect(byRel(r.entries, 'only-left.txt')).toMatchObject({
      status: 'left-only',
      leftSize: 1,
      rightSize: null
    })
    expect(byRel(r.entries, 'only-right.txt')).toMatchObject({
      status: 'right-only',
      leftSize: null,
      rightSize: 1
    })
  })

  it('递归子目录条目按相对路径对齐（统一 / 分隔）', async () => {
    await put('left', 'src/core/a.ts', 'export const a = 1\n')
    await put('right', 'src/core/a.ts', 'export const a = 2\n')
    await put('right', 'src/util/b.ts', 'export const b = 1\n')
    const r = await scanFolders(leftDir, rightDir)
    expect(byRel(r.entries, 'src/core/a.ts')?.status).toBe('different')
    expect(byRel(r.entries, 'src/util/b.ts')?.status).toBe('right-only')
  })

  it('二进制内容同样按字节判定（含 NUL 字节文件）', async () => {
    await put('left', 'bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x03]))
    await put('right', 'bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x04]))
    const r = await scanFolders(leftDir, rightDir)
    expect(byRel(r.entries, 'bin.dat')?.status).toBe('different')
  })

  it('symlink 被跳过（防环且不参与判定）', async () => {
    // 建一个指向已存在子目录的 symlink，不应出现在结果中也不应导致递归
    await symlink(join(leftDir, 'src'), join(leftDir, 'src-link'), 'dir').catch(() => {})
    const r = await scanFolders(leftDir, rightDir)
    expect(r.entries.some((e) => e.rel.startsWith('src-link/'))).toBe(false)
  })

  it('条目按相对路径字典序排序', async () => {
    const r = await scanFolders(leftDir, rightDir)
    const rels = r.entries.map((e) => e.rel)
    expect([...rels].sort()).toEqual(rels)
  })

  it('total 为两侧枚举文件数的较大值', async () => {
    const r = await scanFolders(leftDir, rightDir)
    const leftCount = r.entries.filter((e) => e.leftSize !== null).length
    const rightCount = r.entries.filter((e) => e.rightSize !== null).length
    expect(r.total).toBeGreaterThanOrEqual(Math.max(leftCount, rightCount))
  })
})

describe('scanFolders - 边界与选项', () => {
  it('两个空目录返回空结果', async () => {
    const emptyL = await mkdtemp(join(tmpdir(), 'difflens-empty-l-'))
    const emptyR = await mkdtemp(join(tmpdir(), 'difflens-empty-r-'))
    try {
      const r = await scanFolders(emptyL, emptyR)
      expect(r.entries).toEqual([])
      expect(r.total).toBe(0)
      expect(r.truncated).toBe(false)
    } finally {
      await rm(emptyL, { recursive: true, force: true })
      await rm(emptyR, { recursive: true, force: true })
    }
  })

  it('目录不存在时不再抛异常：该侧按无文件处理（另一侧条目为 only）', async () => {
    // 单目录 IO 失败降级（被锁/权限）而非整体失败：大目录下单点锁不丢弃全部结果
    const r = await scanFolders(join(leftDir, 'not-exist'), rightDir)
    expect(r.entries.length).toBeGreaterThan(0)
    expect(r.entries.every((e) => e.status === 'right-only')).toBe(true)
  })

  it('maxFiles 截断：条目不完整且 truncated 为 true', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-trunc-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-trunc-r-'))
    try {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(l, `f${i}.txt`), String(i))
        await writeFile(join(r, `f${i}.txt`), String(i))
      }
      const res = await scanFolders(l, r, { maxFiles: 2 })
      expect(res.truncated).toBe(true)
      expect(res.total).toBe(5)
      expect(res.entries.length).toBeLessThanOrEqual(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('截断后不再深入子目录（凑满即停，total 为已遍历下限）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-stop-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-stop-r-'))
    try {
      // 根目录 3 个文件 + 子目录 1 个文件，maxFiles=2：凑满后子目录不被遍历
      // （readdir 目录内条目顺序不保证，但 3 个根文件计入 total 与顺序无关）
      for (let i = 0; i < 3; i++) {
        await writeFile(join(l, `f${i}.txt`), String(i))
        await writeFile(join(r, `f${i}.txt`), String(i))
      }
      await mkdir(join(l, 'sub'), { recursive: true })
      await mkdir(join(r, 'sub'), { recursive: true })
      await writeFile(join(l, 'sub', 'inner.txt'), 'x')
      await writeFile(join(r, 'sub', 'inner.txt'), 'x')
      const res = await scanFolders(l, r, { maxFiles: 2 })
      expect(res.truncated).toBe(true)
      // 根目录 3 文件全部计入（当前目录统计完整），sub 未被深入
      expect(res.total).toBe(3)
      expect(res.entries.some((e) => e.rel.startsWith('sub/'))).toBe(false)
      expect(res.entries.length).toBeLessThanOrEqual(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('超过 maxContentBytes 的同大小文件：头部采样一致判 same 且带 approximate 标注', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-big-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-big-r-'))
    try {
      // 100KB 文件、maxContentBytes 压到 1KB：走采样路径；头部 8KB 一致 → same + approximate
      const head = Buffer.alloc(8 * 1024, 0x41)
      const tailL = Buffer.alloc(100 * 1024 - head.length, 0x01)
      const tailR = Buffer.alloc(100 * 1024 - head.length, 0x02)
      await writeFile(join(l, 'big.bin'), Buffer.concat([head, tailL]))
      await writeFile(join(r, 'big.bin'), Buffer.concat([head, tailR]))
      const res = await scanFolders(l, r, { maxContentBytes: 1024 })
      expect(byRel(res.entries, 'big.bin')).toMatchObject({ status: 'same', approximate: true })
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('采样头部不同直接判 different', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-head-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-head-r-'))
    try {
      await writeFile(join(l, 'big.bin'), Buffer.alloc(100 * 1024, 0x01))
      await writeFile(join(r, 'big.bin'), Buffer.alloc(100 * 1024, 0x02))
      const res = await scanFolders(l, r, { maxContentBytes: 1024 })
      expect(byRel(res.entries, 'big.bin')?.status).toBe('different')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })
})

describe('scanFolders - 语义判等', () => {
  /** 语义判等注入：同步解码（UTF-8 直读）+ 文本扩展名白名单 */
  const SEMANTIC = {
    maxBytes: SEMANTIC_MAX_BYTES,
    isTextFile: (rel: string): boolean => {
      const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
      return ['txt', 'md', 'json', 'ts'].includes(ext)
    },
    decode: async (buf: Buffer): Promise<string> => buf.toString('utf-8')
  }

  it('semanticEquals：空白/换行/空行差异判等，跨行重排判等，实质差异与大小写不判等', () => {
    expect(semanticEquals('a b', 'ab')).toBe(true)
    expect(semanticEquals('a\r\nb', 'a\nb')).toBe(true)
    expect(semanticEquals('a\n\n\nb', 'ab')).toBe(true)
    expect(semanticEquals('ab cd', 'ab\ncd')).toBe(true)
    expect(semanticEquals('abc', 'abd')).toBe(false)
    expect(semanticEquals('ABC', 'abc')).toBe(false)
    expect(semanticEquals('', '')).toBe(true)
  })

  it('仅空白/换行差异的文本文件判为 semantic-same（同大小与不同大小均覆盖）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-sem-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-sem-r-'))
    try {
      // 不同大小：行内空白差异（tab/空格/数量）
      await writeFile(join(l, 'ws.txt'), 'a\tb\nc d\n')
      await writeFile(join(r, 'ws.txt'), 'a b\nc  d\n')
      // 不同大小：CRLF vs LF
      await writeFile(join(l, 'crlf.txt'), 'line1\r\nline2\r\n')
      await writeFile(join(r, 'crlf.txt'), 'line1\nline2\n')
      // 排版重排（跨行重组）
      await writeFile(join(l, 'reflow.txt'), 'hello world\n')
      await writeFile(join(r, 'reflow.txt'), 'hello\nworld\n')
      const res = await scanFolders(l, r, { semantic: SEMANTIC })
      expect(byRel(res.entries, 'ws.txt')?.status).toBe('semantic-same')
      expect(byRel(res.entries, 'crlf.txt')?.status).toBe('semantic-same')
      expect(byRel(res.entries, 'reflow.txt')?.status).toBe('semantic-same')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('实质内容差异与大小写差异仍判 different', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-sem2-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-sem2-r-'))
    try {
      await writeFile(join(l, 'real.txt'), 'value = 1\n')
      await writeFile(join(r, 'real.txt'), 'value = 2\n')
      await writeFile(join(l, 'case.txt'), 'Config\n')
      await writeFile(join(r, 'case.txt'), 'config\n')
      const res = await scanFolders(l, r, { semantic: SEMANTIC })
      expect(byRel(res.entries, 'real.txt')?.status).toBe('different')
      expect(byRel(res.entries, 'case.txt')?.status).toBe('different')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('非文本扩展名与超大小上限的条目不参与语义判等（保持字节级 different）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-sem3-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-sem3-r-'))
    try {
      // 非文本扩展名（.bin 不在白名单）：仅空白差异仍判 different
      await writeFile(join(l, 'data.bin'), 'a b\n')
      await writeFile(join(r, 'data.bin'), 'ab\n')
      // 大小超上限（注入 maxBytes=4）：仅空白差异仍判 different
      await writeFile(join(l, 'big.txt'), 'aaaa bbbb\n')
      await writeFile(join(r, 'big.txt'), 'aaaabbbb\n')
      const res = await scanFolders(l, r, {
        semantic: { ...SEMANTIC, maxBytes: 4 }
      })
      expect(byRel(res.entries, 'data.bin')?.status).toBe('different')
      expect(byRel(res.entries, 'big.txt')?.status).toBe('different')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('未开启语义判等时空白差异保持字节级 different（行为与 0.6.2 一致）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-sem4-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-sem4-r-'))
    try {
      await writeFile(join(l, 'ws.txt'), 'a b\n')
      await writeFile(join(r, 'ws.txt'), 'ab\n')
      const res = await scanFolders(l, r)
      expect(byRel(res.entries, 'ws.txt')?.status).toBe('different')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('字节一致的文件不受语义开关影响（仍判 same，不触发解码）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-sem5-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-sem5-r-'))
    let decoded = 0
    try {
      await writeFile(join(l, 'same.txt'), 'same content\n')
      await writeFile(join(r, 'same.txt'), 'same content\n')
      const res = await scanFolders(l, r, {
        semantic: { ...SEMANTIC, decode: async (b) => { decoded++; return b.toString('utf-8') } }
      })
      expect(byRel(res.entries, 'same.txt')?.status).toBe('same')
      expect(decoded).toBe(0)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('单文件 IO 失败（模拟被锁）标记 unreadable，不影响其余条目判定', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-sem6-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-sem6-r-'))
    try {
      // 正常差异文件 + 失败文件（decode 抛异常模拟读取后置失败，如 Windows 文件锁）
      await writeFile(join(l, 'ok.txt'), 'a\n')
      await writeFile(join(r, 'ok.txt'), 'b\n')
      await writeFile(join(l, 'locked.txt'), 'x y\n')
      await writeFile(join(r, 'locked.txt'), 'xy\n')
      const res = await scanFolders(l, r, {
        semantic: {
          ...SEMANTIC,
          decode: async (b) => {
            if (b.toString('utf-8').includes('x')) throw new Error('EBUSY')
            return b.toString('utf-8')
          }
        }
      })
      expect(byRel(res.entries, 'ok.txt')?.status).toBe('different')
      expect(byRel(res.entries, 'locked.txt')?.status).toBe('unreadable')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })
})

describe('scanFolders - 受控并发内容比对', () => {
  it('跨多个并发批次的混合状态全部判定正确且排序不变', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-conc-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-conc-r-'))
    try {
      // 40 个大小一致的条目 > 2×SCAN_CONCURRENCY(16)，覆盖至少 3 个并发批次；
      // 状态混排：偶数 same / 奇数 different / 尾部两个单侧
      const total = 40
      for (let i = 0; i < total; i++) {
        const same = i % 2 === 0
        const content = same ? `c${i}` : `L${i}`
        const contentR = same ? `c${i}` : `R${i}`
        await writeFile(join(l, `f${String(i).padStart(2, '0')}.txt`), content)
        await writeFile(join(r, `f${String(i).padStart(2, '0')}.txt`), contentR)
      }
      await writeFile(join(l, 'zz-only-left.txt'), 'L')
      await writeFile(join(r, 'zz-only-right.txt'), 'R')

      const res = await scanFolders(l, r)
      expect(res.entries).toHaveLength(total + 2)
      // 每个条目状态正确（并发写回槽位不丢不错）
      for (let i = 0; i < total; i++) {
        const rel = `f${String(i).padStart(2, '0')}.txt`
        expect(byRel(res.entries, rel)?.status).toBe(i % 2 === 0 ? 'same' : 'different')
      }
      expect(byRel(res.entries, 'zz-only-left.txt')?.status).toBe('left-only')
      expect(byRel(res.entries, 'zz-only-right.txt')?.status).toBe('right-only')
      // 排序仍为字典序（输出顺序与并发执行顺序无关）
      const rels = res.entries.map((e) => e.rel)
      expect([...rels].sort()).toEqual(rels)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })
})

describe('scanFolders - 增量重扫（previous 缓存）', () => {
  /** 语义判等注入：同步解码 + 计数器（零 IO 断言的核心观察点） */
  const semWithCounter = (): {
    opts: {
      semantic: {
        maxBytes: number
        isTextFile: (rel: string) => boolean
        decode: (b: Buffer) => Promise<string>
      }
    }
    count: () => number
  } => {
    let decoded = 0
    return {
      opts: {
        semantic: {
          maxBytes: SEMANTIC_MAX_BYTES,
          isTextFile: (rel: string): boolean => {
            const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
            return ['txt', 'md', 'json', 'ts'].includes(ext)
          },
          decode: async (b: Buffer): Promise<string> => {
            decoded++
            return b.toString('utf-8')
          }
        }
      },
      count: () => decoded
    }
  }

  it('指纹一致零 IO：same 与语义同条目沿用判定，decode 计数零增长', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-inc1-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-inc1-r-'))
    try {
      // same（字节一致）+ semantic-same（仅空白差异，需解码判定）
      await writeFile(join(l, 'same.txt'), 'identical\n')
      await writeFile(join(r, 'same.txt'), 'identical\n')
      await writeFile(join(l, 'sem.txt'), 'a b\nc\n')
      await writeFile(join(r, 'sem.txt'), 'ab\nc\n')
      const sem = semWithCounter()
      const first = await scanFolders(l, r, sem.opts)
      expect(byRel(first.entries, 'same.txt')?.status).toBe('same')
      expect(byRel(first.entries, 'sem.txt')?.status).toBe('semantic-same')
      expect(sem.count()).toBe(2) // 首次：sem.txt 双侧各解码一次
      // 二次扫描携带缓存：指纹全部一致 → 全部零 IO 沿用
      const second = await scanFolders(l, r, { ...sem.opts, previous: first.cache })
      expect(byRel(second.entries, 'same.txt')?.status).toBe('same')
      expect(byRel(second.entries, 'sem.txt')?.status).toBe('semantic-same')
      expect(sem.count()).toBe(2) // 零增长
      // 缓存条目被原样再次产出（链式增量可用）
      expect(second.cache.length).toBe(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('语义开关翻转零 IO：semSame 非 null 条目纯内存组合 different ↔ semantic-same', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-inc2-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-inc2-r-'))
    try {
      await writeFile(join(l, 'sem.txt'), 'a b\nc\n')
      await writeFile(join(r, 'sem.txt'), 'ab\nc\n')
      // 第一次：语义开 → semantic-same（semSame = true 入缓存）
      const semOn = semWithCounter()
      const on1 = await scanFolders(l, r, semOn.opts)
      expect(byRel(on1.entries, 'sem.txt')?.status).toBe('semantic-same')
      expect(semOn.count()).toBe(2)
      // 第二次：语义关 + 缓存 → different（字节不同），零 IO
      const off = await scanFolders(l, r, { previous: on1.cache })
      expect(byRel(off.entries, 'sem.txt')?.status).toBe('different')
      expect(semOn.count()).toBe(2)
      // 第三次：语义再开 + 新缓存 → semantic-same，仍零 IO
      const semOn2 = semWithCounter()
      const on2 = await scanFolders(l, r, { ...semOn2.opts, previous: off.cache })
      expect(byRel(on2.entries, 'sem.txt')?.status).toBe('semantic-same')
      expect(semOn2.count()).toBe(0)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('上次未参与语义（semSame null）而本次开启：读内容补判', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-inc3-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-inc3-r-'))
    try {
      await writeFile(join(l, 'sem.txt'), 'a b\n')
      await writeFile(join(r, 'sem.txt'), 'ab\n')
      // 第一次：语义关 → different（semSame = null）
      const off = await scanFolders(l, r)
      expect(byRel(off.entries, 'sem.txt')?.status).toBe('different')
      // 第二次：语义开 + 缓存 → sem.txt 需补判（decode 2 次）
      const sem = semWithCounter()
      const on = await scanFolders(l, r, { ...sem.opts, previous: off.cache })
      expect(byRel(on.entries, 'sem.txt')?.status).toBe('semantic-same')
      expect(sem.count()).toBe(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('指纹变化（内容修改）重新判定，文件增删正确处理', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-inc4-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-inc4-r-'))
    try {
      await writeFile(join(l, 'a.txt'), 'v1\n')
      await writeFile(join(r, 'a.txt'), 'v1\n')
      await writeFile(join(l, 'gone.txt'), 'x\n')
      const first = await scanFolders(l, r)
      expect(byRel(first.entries, 'a.txt')?.status).toBe('same')
      expect(byRel(first.entries, 'gone.txt')?.status).toBe('left-only')
      // 修改右侧 a.txt（mtime 变化）+ 删除 gone.txt + 新增 new.txt
      await writeFile(join(r, 'a.txt'), 'v2 changed\n')
      await rm(join(l, 'gone.txt'))
      await writeFile(join(r, 'new.txt'), 'n\n')
      const second = await scanFolders(l, r, { previous: first.cache })
      expect(byRel(second.entries, 'a.txt')?.status).toBe('different')
      expect(second.entries.some((e) => e.rel === 'gone.txt')).toBe(false)
      expect(byRel(second.entries, 'new.txt')?.status).toBe('right-only')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('mtime 相同但指纹形状变化（单侧缺失变化）不误沿用', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-inc5-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-inc5-r-'))
    try {
      await writeFile(join(l, 'a.txt'), 'v1\n')
      await writeFile(join(r, 'a.txt'), 'v1\n')
      const first = await scanFolders(l, r)
      expect(byRel(first.entries, 'a.txt')?.status).toBe('same')
      // 删除右侧文件：same → left-only（缓存形状不一致，必须重判）
      await rm(join(r, 'a.txt'))
      const second = await scanFolders(l, r, { previous: first.cache })
      expect(byRel(second.entries, 'a.txt')?.status).toBe('left-only')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('本次截断忽略 previous 且 cache 产出为空（条目不完整不可信）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-inc6-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-inc6-r-'))
    try {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(l, `f${i}.txt`), String(i))
        await writeFile(join(r, `f${i}.txt`), String(i))
      }
      const first = await scanFolders(l, r)
      expect(first.cache.length).toBe(5)
      // 截断扫描：previous 被忽略（等同全量），cache 为空
      const second = await scanFolders(l, r, { maxFiles: 2, previous: first.cache })
      expect(second.truncated).toBe(true)
      expect(second.cache).toEqual([])
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('unreadable 不进缓存：故障恢复后重扫得到正确判定', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-inc7-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-inc7-r-'))
    try {
      await writeFile(join(l, 'ok.txt'), 'a\n')
      await writeFile(join(r, 'ok.txt'), 'b\n')
      await writeFile(join(l, 'locked.txt'), 'x y\n')
      await writeFile(join(r, 'locked.txt'), 'xy\n')
      // 第一次：locked.txt 解码抛异常（模拟 Windows 文件锁）→ unreadable
      const sem = semWithCounter()
      const patched = {
        semantic: {
          ...sem.opts.semantic,
          decode: async (b: Buffer): Promise<string> => {
            if (b.toString('utf-8').includes('x')) throw new Error('EBUSY')
            return b.toString('utf-8')
          }
        }
      }
      const first = await scanFolders(l, r, patched)
      expect(byRel(first.entries, 'ok.txt')?.status).toBe('different')
      expect(byRel(first.entries, 'locked.txt')?.status).toBe('unreadable')
      // unreadable 不进缓存（cache 仅 1 条 ok.txt）
      expect(first.cache.map((c) => c.rel)).toEqual(['ok.txt'])
      // 第二次：故障恢复（正常 decode）+ 缓存 → locked.txt 补判 semantic-same
      const second = await scanFolders(l, r, { ...sem.opts, previous: first.cache })
      expect(byRel(second.entries, 'ok.txt')?.status).toBe('different')
      expect(byRel(second.entries, 'locked.txt')?.status).toBe('semantic-same')
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })
})

describe('scanFolders - 忽略规则', () => {
  it('目录规则整树剪枝：子树不枚举、不计数、不出现在结果与缓存', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign1-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign1-r-'))
    try {
      await writeFile(join(l, 'keep.txt'), 'a')
      await writeFile(join(r, 'keep.txt'), 'a')
      // 深层子树：node_modules/pkg/dist/x.js（全部应被剪枝）
      for (const d of [l, r]) {
        await mkdir(join(d, 'node_modules', 'pkg', 'dist'), { recursive: true })
        await writeFile(join(d, 'node_modules', 'pkg', 'dist', 'x.js'), 'x')
        await writeFile(join(d, 'node_modules', 'pkg', 'y.js'), 'y')
      }
      const res = await scanFolders(l, r, { ignore: ['node_modules/'] })
      expect(res.entries.map((e) => e.rel)).toEqual(['keep.txt'])
      expect(res.total).toBe(1)
      expect(res.truncated).toBe(false)
      expect(res.cache.map((c) => c.rel)).toEqual(['keep.txt'])
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('扩展名通配与名字匹配跳过文件（大小写不敏感）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign2-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign2-r-'))
    try {
      for (const d of [l, r]) {
        await writeFile(join(d, 'keep.txt'), 'a')
        await writeFile(join(d, 'debug.LOG'), 'x')
        await writeFile(join(d, 'temp'), 't')
        await writeFile(join(d, 'other.txt'), 'o')
      }
      const res = await scanFolders(l, r, { ignore: ['*.log', 'temp'] })
      expect(res.entries.map((e) => e.rel).sort()).toEqual(['keep.txt', 'other.txt'])
      expect(res.total).toBe(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('被忽略文件不占用 maxFiles：原本截断的场景忽略后完整扫描', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign3-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign3-r-'))
    try {
      for (let i = 0; i < 5; i++) {
        await writeFile(join(l, `f${i}.txt`), String(i))
        await writeFile(join(r, `f${i}.txt`), String(i))
      }
      for (const d of [l, r]) {
        await mkdir(join(d, 'dist'), { recursive: true })
        for (let i = 0; i < 5; i++) await writeFile(join(d, 'dist', `b${i}.txt`), 'b')
      }
      // 无忽略 + maxFiles=6：截断
      const noIgnore = await scanFolders(l, r, { maxFiles: 6 })
      expect(noIgnore.truncated).toBe(true)
      // 忽略 dist/ 后仅 5 个文件：完整扫描
      const res = await scanFolders(l, r, { maxFiles: 6, ignore: ['dist/'] })
      expect(res.truncated).toBe(false)
      expect(res.total).toBe(5)
      expect(res.entries).toHaveLength(5)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('忽略规则变化后重扫：缓存未命中的重新纳入条目走全量判定', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign4-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign4-r-'))
    try {
      await writeFile(join(l, 'a.txt'), 'a')
      await writeFile(join(r, 'a.txt'), 'a')
      await mkdir(join(l, 'dist'), { recursive: true })
      await mkdir(join(r, 'dist'), { recursive: true })
      await writeFile(join(l, 'dist/x.txt'), 'x')
      await writeFile(join(r, 'dist/x.txt'), 'x')
      // 第一次：忽略 dist/
      const first = await scanFolders(l, r, { ignore: ['dist/'] })
      expect(first.entries.map((e) => e.rel)).toEqual(['a.txt'])
      // 第二次：去掉忽略规则 + 携带缓存 → dist/x.txt 未命中缓存，全量判定 same
      const second = await scanFolders(l, r, { previous: first.cache })
      expect(byRel(second.entries, 'a.txt')?.status).toBe('same')
      expect(byRel(second.entries, 'dist/x.txt')?.status).toBe('same')
      expect(second.cache.map((c) => c.rel).sort()).toEqual(['a.txt', 'dist/x.txt'])
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('多段路径从根锚定剪枝：仅命中该路径（其他分支同名目录不受影响）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign6-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign6-r-'))
    try {
      for (const d of [l, r]) {
        await mkdir(join(d, 'src', 'temp'), { recursive: true })
        await mkdir(join(d, 'lib', 'temp'), { recursive: true })
        await writeFile(join(d, 'src', 'temp', 'a.txt'), 'a')
        await writeFile(join(d, 'lib', 'temp', 'b.txt'), 'b')
        await writeFile(join(d, 'src', 'keep.txt'), 'k')
      }
      const res = await scanFolders(l, r, { ignore: ['src/temp'] })
      // src/temp 剪枝；lib/temp 同名目录在其他分支不受影响；被忽略文件不计入 total
      expect(res.entries.map((e) => e.rel)).toEqual(['lib/temp/b.txt', 'src/keep.txt'])
      expect(res.total).toBe(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('** 跨段剪枝与否定救回（父目录未被剪枝时子路径可被反否定）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign7-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign7-r-'))
    try {
      for (const d of [l, r]) {
        await mkdir(join(d, 'build', 'a', 'temp'), { recursive: true })
        await mkdir(join(d, 'build', 'special', 'temp'), { recursive: true })
        await writeFile(join(d, 'build', 'a', 'temp', 'd1.txt'), 'x')
        await writeFile(join(d, 'build', 'special', 'temp', 'd2.txt'), 'y')
        await writeFile(join(d, 'keep.txt'), 'k')
      }
      // build/a/temp 剪枝；build/special/temp 被否定救回（build 与 special 未被剪枝，BFS 正常下钻）
      const res = await scanFolders(l, r, { ignore: ['build/**/temp/', '!build/special/temp/'] })
      expect(res.entries.map((e) => e.rel)).toEqual(['build/special/temp/d2.txt', 'keep.txt'])
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('父目录被剪枝后否定规则救不回子项（gitignore 同款语义）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign8-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign8-r-'))
    try {
      for (const d of [l, r]) {
        await mkdir(join(d, 'node_modules', 'pkg'), { recursive: true })
        await writeFile(join(d, 'node_modules', 'pkg', 'keep.js'), 'k')
        await writeFile(join(d, 'app.js'), 'a')
      }
      // node_modules/ 目录命中即整树剪枝，!node_modules/pkg/keep.js 无法救回
      const res = await scanFolders(l, r, { ignore: ['node_modules/', '!node_modules/pkg/keep.js'] })
      expect(res.entries.map((e) => e.rel)).toEqual(['app.js'])
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('段内 ? 与字符类规则跳过文件（0.10.1 字符通配集成）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign9-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign9-r-'))
    try {
      for (const d of [l, r]) {
        await writeFile(join(d, 'keep.txt'), 'a')
        await writeFile(join(d, 'debug.log'), 'x')
        await writeFile(join(d, 'debug.leg'), 'x')
        await writeFile(join(d, 'main.c'), 'x')
        await writeFile(join(d, 'main.o'), 'x')
      }
      // *.l?g 命中 .log 与 .leg（? 匹配任意单字符）；*.[ch] 命中 .c 不命中 .o
      const res = await scanFolders(l, r, { ignore: ['*.l?g', '*.[ch]'] })
      expect(res.entries.map((e) => e.rel).sort()).toEqual(['keep.txt', 'main.o'])
      expect(res.total).toBe(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('空规则数组与全非法规则不产生任何剪枝（行为与无规则一致）', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-ign5-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-ign5-r-'))
    try {
      for (const d of [l, r]) {
        await writeFile(join(d, 'a.txt'), 'a')
        await mkdir(join(d, 'node_modules'), { recursive: true })
        await writeFile(join(d, 'node_modules', 'x.js'), 'x')
      }
      const empty = await scanFolders(l, r, { ignore: [] })
      expect(empty.entries).toHaveLength(2)
      // 全部为非法规则（空段 / ! 后为空 / 段内 **）：不产生任何剪枝
      const invalid = await scanFolders(l, r, { ignore: ['# note', 'a//b', '!', 'a**b'] })
      expect(invalid.entries).toHaveLength(2)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })
})

describe('scanFolders - 比对进度回调（onProgress）', () => {
  it('需读内容的条目按批推进进度：done 单调递增至 total', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-prog-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-prog-r-'))
    try {
      // 40 个大小一致条目（需读内容比对）+ 2 个单侧（无 IO）→ tasks = 40，3 个批次
      for (let i = 0; i < 40; i++) {
        await writeFile(join(l, `f${String(i).padStart(2, '0')}.txt`), `c${i}`)
        await writeFile(join(r, `f${String(i).padStart(2, '0')}.txt`), `c${i}`)
      }
      await writeFile(join(l, 'only-l.txt'), 'L')
      const events: Array<{ done: number; total: number }> = []
      const res = await scanFolders(l, r, {
        onProgress: (done, total) => events.push({ done, total })
      })
      expect(res.entries).toHaveLength(41)
      expect(events.length).toBeGreaterThan(0)
      // total 恒为需读内容的条目总数；done 单调递增且最终到达 total
      expect(events.every((e) => e.total === 40)).toBe(true)
      for (let i = 1; i < events.length; i++) {
        expect(events[i].done).toBeGreaterThan(events[i - 1].done)
      }
      expect(events[events.length - 1].done).toBe(40)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })

  it('全部条目零 IO（缓存命中/单侧缺失）时不触发进度回调', async () => {
    const l = await mkdtemp(join(tmpdir(), 'difflens-prog2-l-'))
    const r = await mkdtemp(join(tmpdir(), 'difflens-prog2-r-'))
    try {
      await writeFile(join(l, 'only-l.txt'), 'L')
      const events: Array<{ done: number; total: number }> = []
      await scanFolders(l, r, { onProgress: (done, total) => events.push({ done, total }) })
      expect(events).toHaveLength(0)
    } finally {
      await rm(l, { recursive: true, force: true })
      await rm(r, { recursive: true, force: true })
    }
  })
})
