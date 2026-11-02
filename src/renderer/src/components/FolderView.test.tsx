import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import FolderView, { FOLDER_ROW_HEIGHT } from './FolderView'
import type { FolderEntry } from '../../../preload/index'
import { diffSnapshot, type FolderSnapshot } from '../diff/snapshotDiff'
import { IGNORE_RULE_MAX_LEN } from '../../../shared/ignoreRules'

const ENTRIES: FolderEntry[] = [
  { rel: 'a.txt', status: 'same', leftSize: 5, rightSize: 5 },
  { rel: 'sem.txt', status: 'semantic-same', leftSize: 5, rightSize: 6 },
  { rel: 'b.txt', status: 'different', leftSize: 3, rightSize: 9 },
  { rel: 'only-left.txt', status: 'left-only', leftSize: 1, rightSize: null },
  { rel: 'sub/only-right.txt', status: 'right-only', leftSize: null, rightSize: 7 },
  { rel: 'sub/deep/diff.ts', status: 'different', leftSize: 2, rightSize: 4 }
]

/** 构造 FolderView 全量 props（覆盖缺省值，测试按需覆写） */
function fullProps(entries: FolderEntry[] = ENTRIES, overrides?: Record<string, unknown>) {
  return {
    leftDir: 'C:/left',
    rightDir: 'D:/right',
    entries,
    truncated: false,
    total: entries.length,
    scanning: false,
    onlyDiff: true,
    onOnlyDiffChange: vi.fn(),
    semantic: true,
    onSemanticChange: vi.fn(),
    ignoreRules: [] as string[],
    onIgnoreRulesChange: vi.fn(),
    snapshot: null as FolderSnapshot | null,
    snapshotDiff: null as ReturnType<typeof diffSnapshot> | null,
    onSaveSnapshot: vi.fn(),
    onLoadSnapshot: vi.fn(),
    onExitSnapshot: vi.fn(),
    onReopen: vi.fn(),
    onRescan: vi.fn(),
    onExit: vi.fn(),
    onExport: vi.fn(),
    onOpenEntry: vi.fn(),
    onOpenDir: vi.fn(),
    ...overrides
  }
}

function renderView(
  entries: FolderEntry[] = ENTRIES,
  onlyDiff = true,
  semantic = true
): ReturnType<typeof render> {
  return render(<FolderView {...fullProps(entries, { onlyDiff, semantic })} />)
}

describe('FolderView - 树形渲染', () => {
  it('渲染两侧目录路径与操作按钮', () => {
    renderView()
    expect(screen.getAllByText('C:/left').length).toBeGreaterThan(0)
    expect(screen.getAllByText('D:/right').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '重新选择' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回文件对比' })).toBeInTheDocument()
    // 快照归组下拉（0.10.5 布局重构）：入口常驻，菜单项打开后可见
    expect(screen.getByRole('button', { name: '快照' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    expect(screen.getByText('保存快照…')).toBeInTheDocument()
    expect(screen.getByText('加载快照…')).toBeInTheDocument()
  })

  it('目录聚合为树形：根层文件与目录混排（字典序），目录行显示聚合状态与计数', () => {
    const { container } = renderView(ENTRIES, false)
    // 根层（关闭过滤后 a.txt/sem.txt/b.txt/only-left.txt/sub 可见）
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    const dirRow = container.querySelector('.folder-row.dir')
    expect(dirRow).not.toBeNull()
    // sub 子树含 different（diff.ts）→ 聚合徽章“不同”
    expect(dirRow!.textContent).toContain('不同')
    expect(dirRow!.textContent).toContain('2 项')
  })

  it('子目录文件默认展开可见（深层文件渲染）', () => {
    renderView(ENTRIES, false)
    expect(screen.getByText('deep')).toBeInTheDocument()
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    expect(screen.getByText('only-right.txt')).toBeInTheDocument()
  })

  it('点击目录行折叠/展开子树', () => {
    renderView(ENTRIES, false)
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByText('sub'))
    // sub 折叠：其下全部子行隐藏
    expect(screen.queryByText('only-right.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('deep')).not.toBeInTheDocument()
    // 再次点击展开恢复
    fireEvent.click(screen.getByText('sub'))
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
  })

  it('双击目录行触发 onOpenDir（携带目录相对路径）', () => {
    const onOpenDir = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onlyDiff: false, onOpenDir })} />)
    fireEvent.dblClick(screen.getByText('sub'))
    expect(onOpenDir).toHaveBeenCalledWith('sub')
  })

  it('双击目录行前该目录处于折叠态：进入时自动展开（消除双击 toggle 残留）', () => {
    renderView(ENTRIES, false)
    // 先折叠 sub
    fireEvent.click(screen.getByText('sub'))
    expect(screen.queryByText('diff.ts')).not.toBeInTheDocument()
    // 双击 sub：onOpenDir 触发且目录恢复展开（返回列表后子行可见）
    fireEvent.dblClick(screen.getByText('sub'))
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
  })

  it('双击文件条目触发 onOpenEntry（携带原始条目）', () => {
    const onOpenEntry = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onOpenEntry })} />)
    fireEvent.dblClick(screen.getByText('b.txt'))
    expect(onOpenEntry).toHaveBeenCalledWith(ENTRIES[2])
  })
})

describe('FolderView - 统计徽章与过滤', () => {
  it('渲染统计徽章（相同/语义同/不同/仅左/仅右/总数）', () => {
    renderView(ENTRIES, false)
    expect(screen.getByText('相同 1')).toBeInTheDocument()
    expect(screen.getByText('语义同 1')).toBeInTheDocument()
    expect(screen.getByText('不同 2')).toBeInTheDocument()
    expect(screen.getByText('仅左 1')).toBeInTheDocument()
    expect(screen.getByText('仅右 1')).toBeInTheDocument()
    expect(screen.getByText('共 6 项')).toBeInTheDocument()
  })

  it('语义关闭时不渲染语义同徽章', () => {
    renderView(ENTRIES, false, false)
    expect(screen.queryByText(/语义同/)).not.toBeInTheDocument()
  })

  it('仅看差异开启时隐藏 same 与 semantic-same 条目（含其目录剪枝）', () => {
    const { rerender } = renderView()
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('sem.txt')).not.toBeInTheDocument()
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    rerender(<FolderView {...fullProps(ENTRIES, { onlyDiff: false })} />)
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('sem.txt')).toBeInTheDocument()
  })

  it('点击徽章开启状态过滤：只看该状态且徽章激活', () => {
    renderView(ENTRIES, false)
    fireEvent.click(screen.getByText('不同 2'))
    // 只剩 different 条目：b.txt 与 sub/deep/diff.ts
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('only-left.txt')).not.toBeInTheDocument()
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    // 激活态样式
    expect(screen.getByText('不同 2').className).toContain('active')
    // 再次点击取消过滤
    fireEvent.click(screen.getByText('不同 2'))
    expect(screen.getByText('a.txt')).toBeInTheDocument()
  })

  it('仅看差异开启时点击徽章：自动关闭仅看差异（回调传 false）', () => {
    const onOnlyDiffChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onOnlyDiffChange })} />)
    fireEvent.click(screen.getByText('相同 1'))
    expect(onOnlyDiffChange).toHaveBeenCalledWith(false)
  })

  it('过滤后无文件的目录不渲染（剪枝）', () => {
    renderView(ENTRIES, false)
    // 只看仅右：唯一 right-only 在 sub 下 → sub 保留
    fireEvent.click(screen.getByText('仅右 1'))
    expect(screen.getByText('sub')).toBeInTheDocument()
    expect(screen.getByText('only-right.txt')).toBeInTheDocument()
    expect(screen.queryByText('deep')).not.toBeInTheDocument()
    // 只看相同：a.txt 在根层，sub 无 same 文件 → sub 剪掉
    fireEvent.click(screen.getByText('仅右 1'))
    fireEvent.click(screen.getByText('相同 1'))
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.queryByText('sub')).not.toBeInTheDocument()
  })
})

describe('FolderView - 搜索', () => {
  it('输入关键字过滤文件并强制展开命中路径', () => {
    renderView(ENTRIES, false)
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: 'diff.ts' } })
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    expect(screen.getByText('deep')).toBeInTheDocument()
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
  })

  it('搜索不区分大小写且匹配目录名中段', () => {
    renderView(ENTRIES, false)
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: 'DEEP' } })
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
  })

  it('折叠目录后搜索仍展开命中路径，清空搜索恢复折叠', () => {
    renderView(ENTRIES, false)
    fireEvent.click(screen.getByText('sub'))
    expect(screen.queryByText('diff.ts')).not.toBeInTheDocument()
    // 搜索强制展开
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: 'diff' } })
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    // 清空搜索恢复折叠
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: '' } })
    expect(screen.queryByText('diff.ts')).not.toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
  })

  it('无命中给出提示', () => {
    renderView(ENTRIES, false)
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: 'zzz' } })
    expect(screen.getByText('没有匹配“zzz”的文件')).toBeInTheDocument()
  })

  it('Esc 清空搜索关键字并失焦（与单文件搜索框行为一致，0.10.5）', () => {
    renderView(ENTRIES, false)
    const input = screen.getByPlaceholderText(/搜索文件名…/)
    fireEvent.change(input, { target: { value: 'diff' } })
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(document.activeElement).not.toBe(input)
  })

  it('有内容时显示清空按钮，点击清空并保持焦点（0.10.5）', () => {
    renderView(ENTRIES, false)
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: 'diff' } })
    expect(screen.getByTitle('清空搜索（Esc）')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('清空搜索（Esc）'))
    const input = screen.getByPlaceholderText(/搜索文件名…/) as HTMLInputElement
    expect(input).toHaveValue('')
    expect(screen.getByText('a.txt')).toBeInTheDocument()
  })

  it('searchInputRef 转发到搜索框（Ctrl+F 聚焦用，0.10.5）', () => {
    const ref = createRef<HTMLInputElement>()
    render(<FolderView {...fullProps(ENTRIES, { searchInputRef: ref })} />)
    expect(ref.current).toBe(screen.getByPlaceholderText(/搜索文件名…/))
  })

  it('目录对变化重置搜索词/状态过滤/扩展名过滤/折叠集合；同目录重扫保留（0.10.5）', () => {
    // 建立残留状态：搜索词 + 折叠 sub + 状态过滤
    const { rerender } = renderView(ENTRIES, false)
    fireEvent.click(screen.getByText('sub'))
    expect(screen.queryByText('diff.ts')).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: 'diff' } })
    // 搜索强制展开命中路径：diff.ts 可见
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    // 同目录重扫（leftDir/rightDir 不变，entries 变化）：状态保留（diff.ts 仍受搜索过滤）
    rerender(<FolderView {...fullProps([...ENTRIES], { onlyDiff: false })} />)
    expect(screen.getByText('diff.ts')).toBeInTheDocument()
    // 重新选择新目录对：搜索/折叠全部重置（无搜索过滤、目录默认展开）
    rerender(
      <FolderView
        {...fullProps(ENTRIES, {
          onlyDiff: false,
          leftDir: 'C:/new-left',
          rightDir: 'D:/new-right'
        })}
      />
    )
    const input = screen.getByPlaceholderText(/搜索文件名…/) as HTMLInputElement
    expect(input).toHaveValue('')
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('only-right.txt')).toBeInTheDocument()
  })
})

describe('FolderView - 扩展名过滤', () => {
  const EXT_ENTRIES: FolderEntry[] = [
    { rel: 'a.txt', status: 'same', leftSize: 1, rightSize: 1 },
    { rel: 'b.txt', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'c.md', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'noext', status: 'left-only', leftSize: 1, rightSize: null }
  ]

  it('下拉展示全量条目的扩展名分布与计数（字典序，无扩展名单列）', () => {
    render(<FolderView {...fullProps(EXT_ENTRIES, { onlyDiff: false })} />)
    fireEvent.click(screen.getByRole('button', { name: /扩展名/ }))
    // 字典序：（无扩展名）/ .md / .txt，各带计数
    expect(screen.getByText('（无扩展名）')).toBeInTheDocument()
    const md = screen.getByText('.md')
    expect(md.textContent).toContain('1')
    const txt = screen.getByText('.txt')
    expect(txt.textContent).toContain('2')
  })

  it('点选扩展名过滤条目：交集过滤生效，计数切换为 N / 总数', () => {
    render(<FolderView {...fullProps(EXT_ENTRIES, { onlyDiff: false })} />)
    expect(screen.getByText('共 4 项')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /扩展名/ }))
    fireEvent.click(screen.getByText('.txt'))
    // 只剩 txt 条目（a.txt 同状态被关掉 onlyDiff 后可见）
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    expect(screen.queryByText('c.md')).not.toBeInTheDocument()
    expect(screen.queryByText('noext')).not.toBeInTheDocument()
    expect(screen.getByText('共 2 / 4 项')).toBeInTheDocument()
    // 入口按钮显示已选数量
    expect(screen.getByRole('button', { name: /扩展名 · 1/ })).toBeInTheDocument()
  })

  it('多选扩展名取并集，再次点击取消，清除按钮复位', () => {
    render(<FolderView {...fullProps(EXT_ENTRIES, { onlyDiff: false })} />)
    fireEvent.click(screen.getByRole('button', { name: /扩展名/ }))
    fireEvent.click(screen.getByText('.txt'))
    fireEvent.click(screen.getByText('.md'))
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    expect(screen.getByText('c.md')).toBeInTheDocument()
    expect(screen.queryByText('noext')).not.toBeInTheDocument()
    expect(screen.getByText('共 3 / 4 项')).toBeInTheDocument()
    // 取消 .txt
    fireEvent.click(screen.getByText('.txt'))
    expect(screen.queryByText('b.txt')).not.toBeInTheDocument()
    expect(screen.getByText('c.md')).toBeInTheDocument()
    // 清除按钮整体复位
    fireEvent.click(screen.getByText('清除扩展名过滤'))
    expect(screen.getByText('共 4 项')).toBeInTheDocument()
    expect(screen.getByText('noext')).toBeInTheDocument()
  })

  it('与状态过滤交集：双激活时无结果的空态提示', () => {
    render(<FolderView {...fullProps(EXT_ENTRIES, { onlyDiff: false })} />)
    // 状态过滤：只看相同（仅 a.txt）
    fireEvent.click(screen.getByText('相同 1'))
    // 扩展名过滤：.md（与 a.txt 无交集）
    fireEvent.click(screen.getByRole('button', { name: /扩展名/ }))
    fireEvent.click(screen.getByText('.md'))
    expect(screen.getByText('当前过滤条件下没有文件')).toBeInTheDocument()
  })

  it('点击外部区域关闭扩展名下拉（过滤状态保留）', () => {
    render(<FolderView {...fullProps(EXT_ENTRIES, { onlyDiff: false })} />)
    fireEvent.click(screen.getByRole('button', { name: /扩展名/ }))
    fireEvent.click(screen.getByText('.txt'))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('.md')).not.toBeInTheDocument()
    // 过滤仍在生效
    expect(screen.queryByText('c.md')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /扩展名 · 1/ })).toBeInTheDocument()
  })
})

describe('FolderView - 忽略规则', () => {
  it('已有规则时入口按钮标注数量并高亮', () => {
    render(<FolderView {...fullProps(ENTRIES, { ignoreRules: ['node_modules/', '*.log'] })} />)
    expect(screen.getByRole('button', { name: '忽略规则 · 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '忽略规则 · 2' }).className).toContain('filtered')
  })

  it('下拉打开时以当前规则初始化草稿，逐行解析后应用并关闭', () => {
    const onIgnoreRulesChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { ignoreRules: ['dist/'], onIgnoreRulesChange })} />)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则 · 1' }))
    const ta = screen.getByPlaceholderText(/每行一条/) as HTMLTextAreaElement
    expect(ta.value).toBe('dist/')
    fireEvent.change(ta, { target: { value: 'node_modules/\n\n  *.log  \ntemp' } })
    fireEvent.click(screen.getByText('应用并重扫'))
    // 空行与空白被清理
    expect(onIgnoreRulesChange).toHaveBeenCalledWith(['node_modules/', '*.log', 'temp'])
    expect(screen.queryByText('应用并重扫')).not.toBeInTheDocument()
  })

  it('清空规则回调空数组并关闭', () => {
    const onIgnoreRulesChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { ignoreRules: ['dist/'], onIgnoreRulesChange })} />)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则 · 1' }))
    fireEvent.click(screen.getByText('清空规则'))
    expect(onIgnoreRulesChange).toHaveBeenCalledWith([])
    expect(screen.queryByText('清空规则')).not.toBeInTheDocument()
  })

  it('点击外部区域关闭忽略规则下拉（不触发回调）', () => {
    const onIgnoreRulesChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onIgnoreRulesChange })} />)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则' }))
    expect(screen.getByText('应用并重扫')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('应用并重扫')).not.toBeInTheDocument()
    expect(onIgnoreRulesChange).not.toHaveBeenCalled()
  })

  it('超长规则被过滤，不连累同批合法规则下发（0.12.1）', () => {
    const onIgnoreRulesChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onIgnoreRulesChange })} />)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则' }))
    const long = 'x'.repeat(IGNORE_RULE_MAX_LEN + 1)
    fireEvent.change(screen.getByPlaceholderText(/每行一条/), {
      target: { value: `node_modules/\n${long}\n*.log` }
    })
    // 草稿里仍实时提示超长规则无效
    expect(screen.getByText(/将被忽略的无效规则/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('应用并重扫'))
    expect(onIgnoreRulesChange).toHaveBeenCalledWith(['node_modules/', '*.log'])
  })

  it('规则条数超上限截断至 50 条', () => {
    const onIgnoreRulesChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onIgnoreRulesChange })} />)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则' }))
    const many = Array.from({ length: 60 }, (_, i) => `d${i}/`).join('\n')
    fireEvent.change(screen.getByPlaceholderText(/每行一条/), { target: { value: many } })
    fireEvent.click(screen.getByText('应用并重扫'))
    expect(onIgnoreRulesChange).toHaveBeenCalledWith(Array.from({ length: 50 }, (_, i) => `d${i}/`))
  })

  it('无效规则实时提示（不再静默丢弃），修正/清空后提示消失', () => {
    render(<FolderView {...fullProps(ENTRIES, { onIgnoreRulesChange: vi.fn() })} />)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则' }))
    const ta = screen.getByPlaceholderText(/每行一条/)
    // 输入合法与非法混合规则
    fireEvent.change(ta, { target: { value: 'node_modules/\na**b\n!' } })
    expect(screen.getByText(/将被忽略的无效规则：a\*\*b、!/)).toBeInTheDocument()
    // 修正非法规则后提示消失
    fireEvent.change(ta, { target: { value: 'node_modules/\nbuild/**/cache' } })
    expect(screen.queryByText(/将被忽略/)).not.toBeInTheDocument()
    // 清空草稿同样消失
    fireEvent.change(ta, { target: { value: '' } })
    expect(screen.queryByText(/将被忽略/)).not.toBeInTheDocument()
  })
})

describe('FolderView - 快照对照模式', () => {
  /** 快照基线：a.txt different、b.txt same、gone.txt different（当前已移除） */
  const SNAP_ENTRIES: FolderEntry[] = [
    { rel: 'a.txt', status: 'different', leftSize: 1, rightSize: 2 },
    { rel: 'b.txt', status: 'same', leftSize: 1, rightSize: 1 },
    { rel: 'gone.txt', status: 'different', leftSize: 1, rightSize: 2 }
  ]
  const CUR_ENTRIES: FolderEntry[] = [
    { rel: 'a.txt', status: 'same', leftSize: 2, rightSize: 2 },
    { rel: 'b.txt', status: 'same', leftSize: 1, rightSize: 1 },
    { rel: 'new.txt', status: 'right-only', leftSize: null, rightSize: 3 }
  ]
  const snap: FolderSnapshot = {
    version: 1,
    leftDir: 'C:/left',
    rightDir: 'D:/right',
    semantic: true,
    truncated: false,
    total: 3,
    entries: SNAP_ENTRIES,
    savedAt: 1700000000000
  }
  const snapDiff = diffSnapshot(SNAP_ENTRIES, CUR_ENTRIES)
  // 变迁：a.txt fixed、gone.txt gone、new.txt new、b.txt stable

  it('对照模式渲染变迁统计徽章与基线信息，替换常规统计行', () => {
    render(<FolderView {...fullProps(CUR_ENTRIES, { snapshot: snap, snapshotDiff: snapDiff })} />)
    expect(screen.getByText('已修复 1')).toBeInTheDocument()
    expect(screen.getByText('新文件 1')).toBeInTheDocument()
    expect(screen.getByText('已移除 1')).toBeInTheDocument()
    expect(screen.getByText(/保持一致 1/)).toBeInTheDocument()
    expect(screen.getByText(/基线 /)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出对照' })).toBeInTheDocument()
    // 常规统计行被替换
    expect(screen.queryByText(/相同 \d/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('仅看差异')).not.toBeInTheDocument()
  })

  it('对照条目平铺全路径渲染，行尾带变迁徽章；零计数变迁不占位', () => {
    render(<FolderView {...fullProps(CUR_ENTRIES, { snapshot: snap, snapshotDiff: snapDiff })} />)
    // 全路径显示（非树形文件名）
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('new.txt')).toBeInTheDocument()
    // 已移除条目仍可见（当前不存在，回退快照数据）并带徽章
    expect(screen.getByText('gone.txt')).toBeInTheDocument()
    expect(screen.getByText('已移除')).toBeInTheDocument()
    expect(screen.getByText('已修复')).toBeInTheDocument()
    // 零计数变迁不渲染
    expect(screen.queryByText(/新增差异 \d/)).not.toBeInTheDocument()
    expect(screen.queryByText(/仍有差异 \d/)).not.toBeInTheDocument()
  })

  it('点击变迁徽章过滤该类条目，再点取消', () => {
    render(<FolderView {...fullProps(CUR_ENTRIES, { snapshot: snap, snapshotDiff: snapDiff })} />)
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByText('已修复 1'))
    // 只剩 fixed 类（a.txt）
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.queryByText('new.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('gone.txt')).not.toBeInTheDocument()
    // 再次点击取消过滤
    fireEvent.click(screen.getByText('已修复 1'))
    expect(screen.getByText('new.txt')).toBeInTheDocument()
  })

  it('双击当前存在的对照条目触发 onOpenEntry；已移除条目双击无效', () => {
    const onOpenEntry = vi.fn()
    render(
      <FolderView
        {...fullProps(CUR_ENTRIES, { snapshot: snap, snapshotDiff: snapDiff, onOpenEntry })}
      />
    )
    fireEvent.dblClick(screen.getByText('a.txt'))
    expect(onOpenEntry).toHaveBeenCalledWith(CUR_ENTRIES[0])
    fireEvent.dblClick(screen.getByText('gone.txt'))
    expect(onOpenEntry).toHaveBeenCalledTimes(1)
  })

  it('退出对照恢复常规视图', () => {
    const onExitSnapshot = vi.fn()
    const { rerender } = render(
      <FolderView
        {...fullProps(CUR_ENTRIES, { snapshot: snap, snapshotDiff: snapDiff, onExitSnapshot })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '退出对照' }))
    expect(onExitSnapshot).toHaveBeenCalledTimes(1)
    // App 清空状态后传 null：恢复常规统计行
    rerender(<FolderView {...fullProps(CUR_ENTRIES, { snapshot: null, snapshotDiff: null })} />)
    expect(screen.getByText('相同 2')).toBeInTheDocument()
    expect(screen.queryByText(/已修复 \d/)).not.toBeInTheDocument()
  })

  it('重扫刷新后过滤的变迁类型计数归零：过滤自动复位显示全部（0.9.3）', () => {
    const { rerender } = render(
      <FolderView {...fullProps(CUR_ENTRIES, { snapshot: snap, snapshotDiff: snapDiff })} />
    )
    // 过滤“已修复”：只剩 a.txt
    fireEvent.click(screen.getByText('已修复 1'))
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.queryByText('new.txt')).not.toBeInTheDocument()
    // 重扫后的新对照：基线全部无差异 → fixed 归零（new / gone 仍在）
    const noFixedBase: FolderEntry[] = [
      { rel: 'a.txt', status: 'same', leftSize: 2, rightSize: 2 },
      { rel: 'b.txt', status: 'same', leftSize: 1, rightSize: 1 }
    ]
    const refreshed = diffSnapshot(noFixedBase, CUR_ENTRIES)
    rerender(
      <FolderView {...fullProps(CUR_ENTRIES, { snapshot: snap, snapshotDiff: refreshed })} />
    )
    // 残留的 fixed 过滤已自动复位：非 stable 条目重新可见
    //（new.txt 回归；a/b 此刻为 stable 被默认隐藏属正常行为）
    expect(screen.getByText('new.txt')).toBeInTheDocument()
  })

  it('对照条目全一致时空态提示', () => {
    // 双侧均无差异（same）→ 全部 stable → 默认隐藏 → 空态提示
    const allSame: FolderEntry[] = [
      { rel: 'a.txt', status: 'same', leftSize: 1, rightSize: 1 },
      { rel: 'b.txt', status: 'same', leftSize: 1, rightSize: 1 }
    ]
    const stableDiff = diffSnapshot(allSame, allSame)
    render(<FolderView {...fullProps(allSame, { snapshot: snap, snapshotDiff: stableDiff })} />)
    expect(screen.getByText('与快照基线完全一致，没有任何变迁')).toBeInTheDocument()
  })

  it('对照条目含基线内容时 title 提示内容对照（v2 快照）', () => {
    // v2 快照带 contents：a.txt 有基线内容 → title 提示；new.txt 无内容 → 不提示
    const snapV2: FolderSnapshot = {
      ...snap,
      version: 2,
      contents: { 'a.txt': { left: 'baseline', right: null } }
    }
    render(<FolderView {...fullProps(CUR_ENTRIES, { snapshot: snapV2, snapshotDiff: snapDiff })} />)
    const rowWith = screen.getByText('a.txt').closest('.folder-row') as HTMLElement
    expect(rowWith.title).toContain('双击查看快照基线内容对照')
    const rowWithout = screen.getByText('new.txt').closest('.folder-row') as HTMLElement
    expect(rowWithout.title).not.toContain('双击查看快照基线内容对照')
  })
})

describe('FolderView - 其他', () => {
  it('切换语义判等开关触发 onSemanticChange', () => {
    const onSemanticChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onSemanticChange })} />)
    fireEvent.click(screen.getByLabelText('语义判等'))
    expect(onSemanticChange).toHaveBeenCalledWith(false)
  })

  it('点击重新扫描触发 onRescan；扫描中禁用', () => {
    const onRescan = vi.fn()
    const { rerender } = render(<FolderView {...fullProps(ENTRIES, { onRescan })} />)
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(onRescan).toHaveBeenCalledTimes(1)
    rerender(<FolderView {...fullProps(ENTRIES, { scanning: true, onRescan })} />)
    expect(screen.getByRole('button', { name: '重新扫描' })).toBeDisabled()
    // 快照下拉入口扫描中禁用（入口即拦截，菜单不再打开）
    expect(screen.getByRole('button', { name: '快照' })).toBeDisabled()
  })

  it('扫描中重新选择保持可用（发起新会话并作废在途扫描，0.9.3 固化）', () => {
    const onReopen = vi.fn()
    const { rerender } = render(<FolderView {...fullProps(ENTRIES, { onReopen })} />)
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(onReopen).toHaveBeenCalledTimes(1)
    // 扫描中仍可点击（竞态守卫丢弃迟到结果；大目录扫描慢时允许放弃改选）
    rerender(<FolderView {...fullProps(ENTRIES, { scanning: true, onReopen })} />)
    expect(screen.getByRole('button', { name: '重新选择' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(onReopen).toHaveBeenCalledTimes(2)
  })

  it('快照下拉菜单项触发保存/加载回调并关闭菜单（0.10.5 归组下拉）', () => {
    const onSaveSnapshot = vi.fn()
    const onLoadSnapshot = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onSaveSnapshot, onLoadSnapshot })} />)
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('保存快照…'))
    expect(onSaveSnapshot).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('保存快照…')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(onLoadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('点击外部区域关闭快照下拉（不触发回调）', () => {
    const onSaveSnapshot = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onSaveSnapshot })} />)
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    expect(screen.getByText('保存快照…')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('保存快照…')).not.toBeInTheDocument()
    expect(onSaveSnapshot).not.toHaveBeenCalled()
  })

  it('快照保存中禁用快照入口与菜单项，其余操作不受影响（0.10.2 按钮级防抖的归组形态）', () => {
    const onSaveSnapshot = vi.fn()
    const onLoadSnapshot = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { saving: true, onSaveSnapshot, onLoadSnapshot })} />)
    // 入口禁用（点击不打开下拉）
    expect(screen.getByRole('button', { name: '快照' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    expect(screen.queryByText('保存快照…')).not.toBeInTheDocument()
    // 保存中仅是快照链路防抖：重新扫描/重新选择/导出/返回不受影响
    expect(screen.getByRole('button', { name: '重新扫描' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重新选择' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '导出报告' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '返回文件对比' })).toBeEnabled()
  })

  it('导出报告菜单选择格式触发 onExport 并关闭菜单', () => {
    const onExport = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { onExport })} />)
    fireEvent.click(screen.getByRole('button', { name: '导出报告' }))
    fireEvent.click(screen.getByText('HTML 报告'))
    expect(onExport).toHaveBeenCalledWith('html')
    expect(screen.queryByText('HTML 报告')).not.toBeInTheDocument()
  })

  it('扫描中禁用导出按钮', () => {
    render(<FolderView {...fullProps(ENTRIES, { scanning: true })} />)
    expect(screen.getByRole('button', { name: '导出报告' })).toBeDisabled()
  })

  it('扫描中禁用语义判等开关（触发重扫的入口防抖）', () => {
    const onSemanticChange = vi.fn()
    const { rerender } = render(
      <FolderView {...fullProps(ENTRIES, { scanning: true, onSemanticChange })} />
    )
    const sw = screen.getByLabelText('语义判等') as HTMLInputElement
    // 浏览器保证 disabled 表单控件不响应点击（jsdom 会派发事件与浏览器不一致，
    // 断言以 disabled 属性为准——与 0.5.4 被包含选项的同款处理）
    expect(sw).toBeDisabled()
    // 开关容器呈禁用视觉态（与被包含选项同款样式）
    expect(sw.closest('label')).toHaveClass('disabled')
    // 非扫描态对照：开关可用且触发回调（防抖仅在扫描中生效）
    rerender(<FolderView {...fullProps(ENTRIES, { scanning: false, onSemanticChange })} />)
    expect(screen.getByLabelText('语义判等')).not.toBeDisabled()
    fireEvent.click(screen.getByLabelText('语义判等'))
    expect(onSemanticChange).toHaveBeenCalledWith(false)
  })

  it('扫描进度显示在遮罩（progress props），无进度时仅基础文案', () => {
    const { rerender } = render(
      <FolderView {...fullProps(ENTRIES, { scanning: true, progress: { done: 3, total: 9 } })} />
    )
    expect(screen.getByText(/正在扫描文件夹… 已比对 3 \/ 9/)).toBeInTheDocument()
    // 进度清空（比对完成或尚未开始）：回到基础文案
    rerender(<FolderView {...fullProps(ENTRIES, { scanning: true, progress: null })} />)
    expect(screen.getByText('正在扫描文件夹…')).toBeInTheDocument()
    expect(screen.queryByText(/已比对/)).not.toBeInTheDocument()
  })

  it('扫描中禁用忽略规则入口（应用规则会触发重扫）', () => {
    const onIgnoreRulesChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { scanning: true, onIgnoreRulesChange })} />)
    const btn = screen.getByRole('button', { name: /忽略规则/ })
    expect(btn).toBeDisabled()
    // 禁用按钮点击不打开规则下拉、不触发回调
    fireEvent.click(btn)
    expect(screen.queryByText('应用并重扫')).not.toBeInTheDocument()
    expect(onIgnoreRulesChange).not.toHaveBeenCalled()
  })

  it('扫描中仅看差异开关与搜索仍可用（纯视图过滤不触发重扫）', () => {
    const onOnlyDiffChange = vi.fn()
    render(<FolderView {...fullProps(ENTRIES, { scanning: true, onOnlyDiffChange })} />)
    expect(screen.getByLabelText('仅看差异')).not.toBeDisabled()
    const search = screen.getByPlaceholderText(/搜索文件名…/)
    expect(search).not.toBeDisabled()
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(onOnlyDiffChange).toHaveBeenCalledTimes(1)
  })

  it('点击外部区域关闭导出菜单', () => {
    render(<FolderView {...fullProps(ENTRIES)} />)
    fireEvent.click(screen.getByRole('button', { name: '导出报告' }))
    expect(screen.getByText('纯文本')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('纯文本')).not.toBeInTheDocument()
  })

  it('文件大小格式化（B/KB 与缺失占位）', () => {
    renderView(
      [...ENTRIES, { rel: 'big.bin', status: 'same', leftSize: 2048, rightSize: 2048 }],
      false
    )
    expect(screen.getAllByText('2.0 KB').length).toBe(2)
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('近似判定条目渲染 ≈ 标注', () => {
    renderView(
      [{ rel: 'huge.bin', status: 'same', leftSize: 1, rightSize: 1, approximate: true }],
      false
    )
    expect(screen.getByText('≈')).toBeInTheDocument()
  })

  it('截断时展示文件过多提示', () => {
    render(<FolderView {...fullProps(ENTRIES.slice(0, 2), { truncated: true, total: 9999 })} />)
    expect(screen.getByText(/文件过多/)).toBeInTheDocument()
  })

  it('全部一致且开启仅看差异时给出空态提示', () => {
    renderView([{ rel: 'x.txt', status: 'same', leftSize: 1, rightSize: 1 }])
    expect(screen.getByText('没有差异文件（两侧内容全部一致）')).toBeInTheDocument()
  })

  it('空文件夹给出空态提示', () => {
    renderView([])
    expect(screen.getByText('两个文件夹内都没有文件')).toBeInTheDocument()
  })

  it('虚拟滚动：大列表仅渲染可见窗口且总高度撑满（树形扁平化行数）', () => {
    // 500 个子目录（各含 1 文件）+ 500 个根层文件 = 展开后 500 目录行 + 1000 文件行 = 1500 行
    const many: FolderEntry[] = Array.from({ length: 500 }, (_, i) => ({
      rel: `d${i}/f${i}.txt`,
      status: 'different' as const,
      leftSize: i,
      rightSize: i + 1
    }))
    for (let i = 0; i < 500; i++) {
      many.push({ rel: `r${i}.txt`, status: 'same' as const, leftSize: 1, rightSize: 1 })
    }
    const { container } = renderView(many, false)
    const rows = container.querySelectorAll('.folder-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(100)
    const sizer = container.querySelector('.folder-scroll > div') as HTMLElement
    expect(sizer.style.height).toBe(`${1500 * FOLDER_ROW_HEIGHT}px`)
  })

  it('窗口尺寸变化后按新视口高度补齐渲染窗口（resize 重算）', () => {
    // 200 个根层文件（无目录，扁平行）；jsdom 无布局走 600px 兜底视口
    const many: FolderEntry[] = Array.from({ length: 200 }, (_, i) => ({
      rel: `f${i}.txt`,
      status: 'different' as const,
      leftSize: 1,
      rightSize: 2
    }))
    const { container } = renderView(many, false)
    const scroll = container.querySelector('.folder-scroll') as HTMLElement
    expect(scroll).not.toBeNull()
    const count = (): number => container.querySelectorAll('.folder-row').length
    const before = count()
    expect(before).toBeGreaterThan(0)
    // stub clientHeight 模拟窗口拉高（600 → 1400）：resize 后渲染窗口必须扩大
    Object.defineProperty(scroll, 'clientHeight', { get: () => 1400, configurable: true })
    fireEvent(window, new Event('resize'))
    expect(count()).toBeGreaterThan(before + 20)
  })
})
