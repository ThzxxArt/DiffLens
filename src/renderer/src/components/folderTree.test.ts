import { describe, it, expect } from 'vitest'
import type { FolderEntry } from '../../../preload/index'
import {
  buildFolderTree,
  filterEntries,
  flattenFolderTree,
  collectEntries,
  relExt
} from './folderTree'

const E: FolderEntry[] = [
  { rel: 'a.txt', status: 'same', leftSize: 1, rightSize: 1 },
  { rel: 'sub/only-right.txt', status: 'right-only', leftSize: null, rightSize: 7 },
  { rel: 'sub/deep/x.ts', status: 'different', leftSize: 2, rightSize: 3 },
  { rel: 'z.md', status: 'semantic-same', leftSize: 1, rightSize: 2 }
]

describe('buildFolderTree', () => {
  it('按路径分段聚合目录与文件，同层名称字典序', () => {
    const root = buildFolderTree(E)
    // 根层：a.txt / sub / z.md（字典序）
    expect(root.children.map((c) => c.name)).toEqual(['a.txt', 'sub', 'z.md'])
    expect(root.children.map((c) => c.isDir)).toEqual([false, true, false])
    // sub 层：deep 目录 + only-right.txt
    const sub = root.children[1]
    expect(sub.children.map((c) => c.name)).toEqual(['deep', 'only-right.txt'])
    // deep 层：x.ts
    expect(sub.children[0].children[0].entry?.rel).toBe('sub/deep/x.ts')
  })

  it('目录聚合子树状态（different 优先）与文件计数', () => {
    const root = buildFolderTree(E)
    const deep = root.children[1].children[0]
    expect(deep.agg).toBe('different')
    expect(deep.fileCount).toBe(1)
    const sub = root.children[1]
    expect(sub.agg).toBe('different')
    expect(sub.fileCount).toBe(2)
    expect(root.agg).toBe('different')
    expect(root.fileCount).toBe(4)
  })

  it('仅同种子树聚合为 same；only 与语义同优先级次之', () => {
    const root = buildFolderTree([
      { rel: 'd/s.txt', status: 'same', leftSize: 1, rightSize: 1 },
      { rel: 'd2/l.txt', status: 'left-only', leftSize: 1, rightSize: null },
      { rel: 'd2/sem.txt', status: 'semantic-same', leftSize: 1, rightSize: 2 }
    ])
    expect(root.children[0].agg).toBe('same')
    // left-only(3) > semantic-same(2)
    expect(root.children[1].agg).toBe('left-only')
  })

  it('空条目集返回空根', () => {
    const root = buildFolderTree([])
    expect(root.children).toHaveLength(0)
    expect(root.fileCount).toBe(0)
  })
})

describe('flattenFolderTree', () => {
  it('全展开：深度递增、目录行在子行之前', () => {
    const rows = flattenFolderTree(buildFolderTree(E), () => true)
    expect(rows.map((r) => r.node.name)).toEqual([
      'a.txt', 'sub', 'deep', 'x.ts', 'only-right.txt', 'z.md'
    ])
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 2, 1, 0])
  })

  it('折叠目录：子树整体隐藏', () => {
    const rows = flattenFolderTree(buildFolderTree(E), (p) => p !== 'sub/deep')
    expect(rows.map((r) => r.node.name)).toEqual(['a.txt', 'sub', 'deep', 'only-right.txt', 'z.md'])
  })

  it('折叠顶层目录：整个子树隐藏', () => {
    const rows = flattenFolderTree(buildFolderTree(E), (p) => p !== 'sub')
    expect(rows.map((r) => r.node.name)).toEqual(['a.txt', 'sub', 'z.md'])
  })
})

describe('filterEntries', () => {
  it('onlyDiff 隐藏 same 与 semantic-same', () => {
    const out = filterEntries(E, { onlyDiff: true, statusFilter: null, query: '' })
    expect(out.map((e) => e.rel)).toEqual(['sub/only-right.txt', 'sub/deep/x.ts'])
  })

  it('statusFilter 只保留集合内状态', () => {
    const out = filterEntries(E, {
      onlyDiff: false,
      statusFilter: new Set(['right-only', 'semantic-same']),
      query: ''
    })
    expect(out.map((e) => e.rel)).toEqual(['sub/only-right.txt', 'z.md'])
  })

  it('query 子串搜索不区分大小写', () => {
    const out = filterEntries(E, { onlyDiff: false, statusFilter: null, query: 'X.TS' })
    expect(out.map((e) => e.rel)).toEqual(['sub/deep/x.ts'])
  })

  it('query 匹配路径中段（目录名）', () => {
    const out = filterEntries(E, { onlyDiff: false, statusFilter: null, query: 'deep' })
    expect(out.map((e) => e.rel)).toEqual(['sub/deep/x.ts'])
  })

  it('组合：onlyDiff + query 交集', () => {
    const out = filterEntries(E, { onlyDiff: true, statusFilter: null, query: 'z' })
    expect(out).toHaveLength(0)
  })

  it('空白 query 不过滤', () => {
    const out = filterEntries(E, { onlyDiff: false, statusFilter: null, query: '   ' })
    expect(out).toHaveLength(E.length)
  })
})

describe('filterEntries - 扩展名过滤', () => {
  const X: FolderEntry[] = [
    { rel: 'a.txt', status: 'same', leftSize: 1, rightSize: 1 },
    { rel: 'b.TXT', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'sub/x.ts', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'noext', status: 'left-only', leftSize: 1, rightSize: null },
    { rel: 'd/noext2', status: 'right-only', leftSize: null, rightSize: 1 }
  ]

  it('relExt 取文件名段扩展名（小写；无扩展名为空串；不误取目录名中的点）', () => {
    expect(relExt('a.txt')).toBe('txt')
    expect(relExt('A.TXT')).toBe('txt')
    expect(relExt('sub/x.ts')).toBe('ts')
    expect(relExt('noext')).toBe('')
    expect(relExt('v1.2.3/md')).toBe('')
    expect(relExt('archive.tar.gz')).toBe('gz')
  })

  it('exts 非空时只保留集合内扩展名（大小写不敏感，无扩展名归空串类目）', () => {
    const out = filterEntries(X, {
      onlyDiff: false,
      statusFilter: null,
      query: '',
      exts: new Set(['txt'])
    })
    expect(out.map((e) => e.rel)).toEqual(['a.txt', 'b.TXT'])
    const noExt = filterEntries(X, {
      onlyDiff: false,
      statusFilter: null,
      query: '',
      exts: new Set([''])
    })
    expect(noExt.map((e) => e.rel)).toEqual(['noext', 'd/noext2'])
  })

  it('多选扩展名取并集，与其他条件取交集（onlyDiff + exts）', () => {
    const out = filterEntries(X, {
      onlyDiff: true,
      statusFilter: null,
      query: '',
      exts: new Set(['txt', 'ts'])
    })
    // onlyDiff 过滤掉 same 的 a.txt，剩 b.TXT 与 sub/x.ts
    expect(out.map((e) => e.rel)).toEqual(['b.TXT', 'sub/x.ts'])
  })

  it('exts 为 null 或缺省时不过滤（向后兼容）', () => {
    expect(filterEntries(X, { onlyDiff: false, statusFilter: null, query: '', exts: null })).toHaveLength(5)
    expect(filterEntries(X, { onlyDiff: false, statusFilter: null, query: '' })).toHaveLength(5)
  })
})

describe('collectEntries', () => {
  it('收集子树全部文件条目', () => {
    const root = buildFolderTree(E)
    const sub = root.children[1]
    expect(collectEntries(sub).map((e) => e.rel)).toEqual(['sub/deep/x.ts', 'sub/only-right.txt'])
  })

  it('文件节点返回自身', () => {
    const root = buildFolderTree(E)
    expect(collectEntries(root.children[0]).map((e) => e.rel)).toEqual(['a.txt'])
  })
})
