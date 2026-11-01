import { describe, it, expect } from 'vitest'
import type { FolderEntry } from '../../../preload/index'
import {
  parseSnapshot,
  diffSnapshot,
  snapshotDirsMatch,
  isDiffStatus,
  SNAPSHOT_VERSION,
  SNAPSHOT_FILE_MAX_BYTES,
  SNAPSHOT_CONTENTS_MAX_CHARS,
  type FolderSnapshot
} from './snapshotDiff'

/** 构造合法快照（v1：无 contents 字段，验证向后兼容加载） */
function makeSnapshot(overrides?: Partial<FolderSnapshot>): FolderSnapshot {
  return {
    version: 1,
    leftDir: 'C:/left',
    rightDir: 'D:/right',
    semantic: true,
    truncated: false,
    total: 2,
    entries: [
      { rel: 'a.txt', status: 'same', leftSize: 1, rightSize: 1 },
      { rel: 'b.txt', status: 'different', leftSize: 1, rightSize: 2 }
    ],
    savedAt: 1700000000000,
    ...overrides
  }
}

describe('parseSnapshot - 解析校验', () => {
  it('合法快照完整解析', () => {
    const snap = makeSnapshot()
    const parsed = parseSnapshot(JSON.stringify(snap))
    expect(parsed).toEqual(snap)
  })

  it('非法 JSON / 版本不符 / 顶层字段异常回退 null', () => {
    expect(parseSnapshot('{broken json!!')).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), version: 99 }))).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), leftDir: 42 }))).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), semantic: 'yes' }))).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), savedAt: 'no-time' }))).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), total: null }))).toBeNull()
  })

  it('任一条目形态异常整体回退 null（绝不部分加载）', () => {
    const bad1 = JSON.stringify({
      ...makeSnapshot(),
      entries: [
        { rel: 'a.txt', status: 'same', leftSize: 1, rightSize: 1 },
        { rel: 'b.txt', status: 'unknown', leftSize: 1, rightSize: 2 }
      ]
    })
    expect(parseSnapshot(bad1)).toBeNull()
    const bad2 = JSON.stringify({
      ...makeSnapshot(),
      entries: [{ rel: '', status: 'same', leftSize: 1, rightSize: 1 }]
    })
    expect(parseSnapshot(bad2)).toBeNull()
    const bad3 = JSON.stringify({
      ...makeSnapshot(),
      entries: [{ rel: 'a', status: 'same', leftSize: 'big', rightSize: 1 }]
    })
    expect(parseSnapshot(bad3)).toBeNull()
  })

  it('条目 approximate 可选字段类型校验', () => {
    const ok = JSON.stringify({
      ...makeSnapshot(),
      entries: [{ rel: 'big.bin', status: 'same', leftSize: 1, rightSize: 1, approximate: true }]
    })
    expect(parseSnapshot(ok)).not.toBeNull()
    const bad = JSON.stringify({
      ...makeSnapshot(),
      entries: [{ rel: 'big.bin', status: 'same', leftSize: 1, rightSize: 1, approximate: 'yes' }]
    })
    expect(parseSnapshot(bad)).toBeNull()
  })
})

describe('parseSnapshot - v2 内容字段（contents）', () => {
  const v2Snap = (): FolderSnapshot => ({
    ...makeSnapshot({ version: 2 }),
    contents: {
      'b.txt': { left: 'baseline left', right: 'baseline right' },
      'c.txt': { left: null, right: 'only right content' }
    }
  })

  it('v2 含 contents 完整解析（含 null 侧）', () => {
    const parsed = parseSnapshot(JSON.stringify(v2Snap()))
    expect(parsed).toEqual(v2Snap())
  })

  it('v2 无 contents 字段合法（纯状态快照：超限降级 / 全部读取失败的保存形态）', () => {
    const snap = makeSnapshot({ version: 2 })
    const parsed = parseSnapshot(JSON.stringify(snap))
    expect(parsed).toEqual(snap)
    expect(parsed?.contents).toBeUndefined()
  })

  it('v1（无 contents）与 v2 均可加载，其余版本拒绝', () => {
    expect(parseSnapshot(JSON.stringify(makeSnapshot()))).not.toBeNull()
    expect(parseSnapshot(JSON.stringify(makeSnapshot({ version: 2 }))))?.not.toBeNull()
    // 非法版本号经展开构造（version 字面量类型为 1|2，直接传入 3/0 会编译报错）
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), version: 3 }))).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot(), version: 0 }))).toBeNull()
  })

  it('contents 形态异常整体回退 null（绝不部分加载）', () => {
    // contents 非对象
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot({ version: 2 }), contents: 'x' }))).toBeNull()
    expect(parseSnapshot(JSON.stringify({ ...makeSnapshot({ version: 2 }), contents: [] }))).toBeNull()
    // 单条记录 left/right 非字符串也非 null
    expect(
      parseSnapshot(
        JSON.stringify({
          ...makeSnapshot({ version: 2 }),
          contents: { 'b.txt': { left: 42, right: 'ok' } }
        })
      )
    ).toBeNull()
    expect(
      parseSnapshot(
        JSON.stringify({
          ...makeSnapshot({ version: 2 }),
          contents: { 'b.txt': { left: 'ok', right: true } }
        })
      )
    ).toBeNull()
    // 单条记录非对象
    expect(
      parseSnapshot(
        JSON.stringify({ ...makeSnapshot({ version: 2 }), contents: { 'b.txt': 'plain' } })
      )
    ).toBeNull()
  })

  it('内容保存上限常量（单文件 2MB 对齐语义判等上限；总量 32MB）', () => {
    expect(SNAPSHOT_VERSION).toBe(2)
    expect(SNAPSHOT_FILE_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(SNAPSHOT_CONTENTS_MAX_CHARS).toBe(32 * 1024 * 1024)
  })
})

describe('isDiffStatus / snapshotDirsMatch', () => {
  it('different / only / unreadable 计为有差异，same / semantic-same 不计', () => {
    expect(isDiffStatus('different')).toBe(true)
    expect(isDiffStatus('left-only')).toBe(true)
    expect(isDiffStatus('right-only')).toBe(true)
    expect(isDiffStatus('unreadable')).toBe(true)
    expect(isDiffStatus('same')).toBe(false)
    expect(isDiffStatus('semantic-same')).toBe(false)
  })

  it('目录对一致才可对照', () => {
    const snap = makeSnapshot()
    expect(snapshotDirsMatch(snap, 'C:/left', 'D:/right')).toBe(true)
    expect(snapshotDirsMatch(snap, 'C:/other', 'D:/right')).toBe(false)
    expect(snapshotDirsMatch(snap, 'C:/left', 'D:/other')).toBe(false)
  })

  it('路径归一化后比较：盘符大小写/反斜杠/尾分隔符的同目录异写视为一致', () => {
    const snap = makeSnapshot()
    // Windows 大小写不敏感文件系统：C:\left 与 c:/left/ 为同一目录
    expect(snapshotDirsMatch(snap, 'c:/left/', 'd:\\right\\')).toBe(true)
    expect(snapshotDirsMatch(snap, 'C:\\left', 'D:\\right')).toBe(true)
    // 大小写敏感文件系统：路径段大小写不同仍是不同目录（不误判一致）
    expect(snapshotDirsMatch(snap, 'C:/Left', 'D:/right')).toBe(false)
    expect(snapshotDirsMatch(snap, 'C:/left', 'D:/Right')).toBe(false)
  })
})

describe('diffSnapshot - 状态变迁对照', () => {
  const base: FolderEntry[] = [
    { rel: 'fixed.txt', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'regr.txt', status: 'same', leftSize: 1, rightSize: 1 },
    { rel: 'gone.txt', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'changed.txt', status: 'left-only', leftSize: 1, rightSize: null },
    { rel: 'stable.txt', status: 'same', leftSize: 1, rightSize: 1 },
    { rel: 'sem-fixed.txt', status: 'different', leftSize: 1, rightSize: 2 }
  ]
  const cur: FolderEntry[] = [
    { rel: 'fixed.txt', status: 'same', leftSize: 2, rightSize: 2 },
    { rel: 'regr.txt', status: 'different', leftSize: 1, rightSize: 9 },
    { rel: 'new.txt', status: 'right-only', leftSize: null, rightSize: 3 },
    { rel: 'changed.txt', status: 'different', leftSize: 1, rightSize: 5 },
    { rel: 'stable.txt', status: 'semantic-same', leftSize: 1, rightSize: 2 },
    { rel: 'sem-fixed.txt', status: 'semantic-same', leftSize: 1, rightSize: 2 }
  ]

  it('六类变迁全部正确判定并统计', () => {
    const r = diffSnapshot(base, cur)
    expect(r.stats).toEqual({
      fixed: 2, // fixed.txt、sem-fixed.txt（→ semantic-same 也算无差异）
      regressed: 1, // regr.txt
      new: 1, // new.txt
      gone: 1, // gone.txt
      changed: 1, // changed.txt（left-only → different）
      stable: 1 // stable.txt（same → semantic-same 双方均无差异）
    })
  })

  it('条目按 rel 字典序排序并携带双侧原始条目', () => {
    const r = diffSnapshot(base, cur)
    expect(r.entries.map((e) => e.rel)).toEqual([...r.entries.map((e) => e.rel)].sort())
    const gone = r.entries.find((e) => e.rel === 'gone.txt')!
    expect(gone.current).toBeNull()
    expect(gone.baseline?.status).toBe('different')
    const added = r.entries.find((e) => e.rel === 'new.txt')!
    expect(added.baseline).toBeNull()
    expect(added.current?.status).toBe('right-only')
    const both = r.entries.find((e) => e.rel === 'stable.txt')!
    expect(both.current?.status).toBe('semantic-same')
    expect(both.baseline?.status).toBe('same')
  })

  it('双侧空集 / 单侧空集', () => {
    expect(diffSnapshot([], []).entries).toEqual([])
    const onlyCur = diffSnapshot([], cur)
    expect(onlyCur.stats.new).toBe(cur.length)
    expect(onlyCur.stats.stable).toBe(0)
    const onlyBase = diffSnapshot(base, [])
    expect(onlyBase.stats.gone).toBe(base.length)
  })

  it('unreadable 计为有差异（恢复读取后判 same → fixed）', () => {
    const r = diffSnapshot(
      [{ rel: 'locked.txt', status: 'unreadable', leftSize: 1, rightSize: 1 }],
      [{ rel: 'locked.txt', status: 'same', leftSize: 1, rightSize: 1 }]
    )
    expect(r.entries[0].change).toBe('fixed')
  })
})
