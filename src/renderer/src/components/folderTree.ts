import type { FolderEntry, FolderEntryStatus } from '../../../preload/index'

/**
 * 文件夹条目树（A5 子目录树形展示的纯逻辑层，渲染由 FolderView 负责）。
 * 平铺 rel 聚合为目录/文件树，目录聚合子树状态，扁平化为虚拟滚动行序列。
 */

/** 树节点（目录或文件） */
export interface TreeNode {
  /** 显示名（路径最后一段；根节点为空串） */
  name: string
  /** 相对完整路径（文件为其 rel；目录为其前缀路径，无尾斜杠） */
  path: string
  isDir: boolean
  /** 文件节点挂原始条目 */
  entry?: FolderEntry
  /** 子节点（目录节点独有；同层按名称字典序） */
  children: TreeNode[]
  /** 目录节点：子树叶子的状态聚合（优先级 different > unreadable > only > semantic-same > same） */
  agg?: FolderEntryStatus
  /** 目录节点：子树文件总数 */
  fileCount?: number
}

/** 扁平化后的虚拟滚动行 */
export interface TreeRow {
  node: TreeNode
  /** 缩进深度（根的直接子节点为 0） */
  depth: number
}

/** 状态聚合优先级：数值大者优先（目录徽章展示最值得关注的子树状态：different > unreadable > only > 语义同 > 相同） */
const AGG_RANK: Record<FolderEntryStatus, number> = {
  different: 5,
  unreadable: 4,
  'left-only': 3,
  'right-only': 3,
  'semantic-same': 2,
  same: 1
}

/** 条目过滤条件 */
export interface EntryFilter {
  /** 隐藏两侧一致的文件（same 与 semantic-same） */
  onlyDiff: boolean
  /** 状态精确过滤（null 为不过滤；非空时只保留集合内状态） */
  statusFilter: Set<FolderEntryStatus> | null
  /** 相对路径子串搜索（不区分大小写；空串不过滤） */
  query: string
  /** 扩展名精确过滤（null 为不过滤；非空时只保留集合内扩展名，与其他条件取交集） */
  exts?: Set<string> | null
}

/** 条目的扩展名（小写不含点；仅取文件名段，无扩展名为空串——无扩展名文件归独立类目） */
export function relExt(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot < 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 按视图条件过滤条目（文件层过滤，树构建之前执行；全部条件取交集） */
export function filterEntries(entries: FolderEntry[], f: EntryFilter): FolderEntry[] {
  const q = f.query.trim().toLowerCase()
  return entries.filter((e) => {
    if (f.onlyDiff && (e.status === 'same' || e.status === 'semantic-same')) return false
    if (f.statusFilter !== null && !f.statusFilter.has(e.status)) return false
    if (q !== '' && !e.rel.toLowerCase().includes(q)) return false
    if (f.exts != null && !f.exts.has(relExt(e.rel))) return false
    return true
  })
}

/** 递归排序子节点（名称字典序）并聚合目录状态与文件计数 */
function finalize(node: TreeNode): void {
  if (!node.isDir) return
  node.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  let agg: FolderEntryStatus = 'same'
  let rank = 0
  let count = 0
  for (const c of node.children) {
    finalize(c)
    if (c.isDir) {
      count += c.fileCount ?? 0
      const r = AGG_RANK[c.agg ?? 'same']
      if (r > rank) {
        rank = r
        agg = c.agg ?? 'same'
      }
    } else {
      count++
      const r = AGG_RANK[c.entry!.status]
      if (r > rank) {
        rank = r
        agg = c.entry!.status
      }
    }
  }
  node.agg = agg
  node.fileCount = count
}

/**
 * 把过滤后的条目聚合为树：按 rel 的 '/' 分段逐级插入，
 * 同名目录合并；目录节点聚合子树状态与文件计数。
 */
export function buildFolderTree(entries: FolderEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }
  for (const e of entries) {
    const segs = e.rel.split('/')
    let cur = root
    for (let i = 0; i < segs.length; i++) {
      const isLeaf = i === segs.length - 1
      const name = segs[i]
      const path = segs.slice(0, i + 1).join('/')
      let child = cur.children.find((c) => c.name === name && c.isDir === !isLeaf)
      if (!child) {
        child = isLeaf
          ? { name, path, isDir: false, children: [], entry: e }
          : { name, path, isDir: true, children: [] }
        cur.children.push(child)
      }
      cur = child
    }
  }
  finalize(root)
  return root
}

/**
 * 树扁平化为虚拟滚动行：展开的目录递归下钻子节点，折叠的目录仅输出自身。
 * isExpanded 接收目录 path 返回是否展开。
 */
export function flattenFolderTree(
  root: TreeNode,
  isExpanded: (dirPath: string) => boolean
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (node: TreeNode, depth: number): void => {
    for (const c of node.children) {
      rows.push({ node: c, depth })
      if (c.isDir && isExpanded(c.path)) walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/** 收集一棵（子）树内的全部文件条目（目录行双击进入等场景） */
export function collectEntries(node: TreeNode): FolderEntry[] {
  if (!node.isDir) return node.entry ? [node.entry] : []
  const out: FolderEntry[] = []
  const walk = (n: TreeNode): void => {
    for (const c of n.children) {
      if (c.isDir) walk(c)
      else if (c.entry) out.push(c.entry)
    }
  }
  walk(node)
  return out
}
