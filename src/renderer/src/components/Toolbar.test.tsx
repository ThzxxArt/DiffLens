import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import Toolbar from './Toolbar'
import { DiffSummary } from '../diff/diffEngine'

const summary: DiffSummary = {
  changedLines: 3,
  inserted: 1,
  deleted: 1,
  modified: 1,
  charsAdded: 12,
  charsDeleted: 8
}

function setup(extra?: {
  computing?: boolean
  charMode?: boolean
  charModeDowngraded?: boolean
  charModePartial?: boolean
  baseOptions?: Partial<import('../diff/diffEngine').DiffOptions>
  onOptionBlocked?: (label: string) => void
  searchQuery?: string
  searchIndex?: number
  searchCount?: number
  onSearchNav?: (dir: 1 | -1) => void
  canPatch?: boolean
}) {
  const onOptionsChange = vi.fn()
  const onNav = vi.fn()
  const onExport = vi.fn()
  const onOnlyDiffChange = vi.fn()
  const onSwap = vi.fn()
  const onSearchChange = vi.fn()
  const onSearchNav = extra?.onSearchNav ?? vi.fn()
  const searchInputRef = createRef<HTMLInputElement>()
  const utils = render(
    <Toolbar
      options={{
        trimWhitespace: false,
        ignoreCase: false,
        ignoreBlankLines: false,
        ignoreAllWhitespace: false,
        ...extra?.baseOptions,
        charMode: extra?.charMode ?? false
      }}
      onOptionsChange={onOptionsChange}
      summary={summary}
      navIndex={0}
      navCount={3}
      onNav={onNav}
      onExport={onExport}
      computing={extra?.computing ?? false}
      onlyDiff={false}
      onOnlyDiffChange={onOnlyDiffChange}
      onSwap={onSwap}
      onOptionBlocked={extra?.onOptionBlocked}
      charModeDowngraded={extra?.charModeDowngraded ?? false}
      charModePartial={extra?.charModePartial ?? false}
      searchQuery={extra?.searchQuery ?? ''}
      onSearchChange={onSearchChange}
      searchIndex={extra?.searchIndex ?? 0}
      searchCount={extra?.searchCount ?? 0}
      onSearchNav={onSearchNav}
      searchInputRef={searchInputRef}
      canPatch={extra?.canPatch}
    />
  )
  return {
    onOptionsChange,
    onNav,
    onExport,
    onOnlyDiffChange,
    onSwap,
    onSearchChange,
    onSearchNav,
    searchInputRef,
    ...utils
  }
}

describe('Toolbar', () => {
  it('渲染差异统计徽章', () => {
    setup()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    expect(screen.getByText('~1')).toBeInTheDocument()
  })

  it('字符级开启时追加字符粒度增删徽章（0.10.5）', () => {
    setup({ charMode: true })
    expect(screen.getByText('+12 字')).toBeInTheDocument()
    expect(screen.getByText('−8 字')).toBeInTheDocument()
  })

  it('字符级关闭时不渲染字符粒度徽章', () => {
    setup()
    expect(screen.queryByText('+12 字')).not.toBeInTheDocument()
    expect(screen.queryByText('−8 字')).not.toBeInTheDocument()
  })

  it('切换忽略大小写触发 onOptionsChange', () => {
    const { onOptionsChange } = setup()
    fireEvent.click(screen.getByLabelText('忽略大小写'))
    expect(onOptionsChange).toHaveBeenCalledWith({ trimWhitespace: false, ignoreCase: true, ignoreBlankLines: false, ignoreAllWhitespace: false, charMode: false })
  })

  it('切换忽略行首尾空白触发 onOptionsChange', () => {
    const { onOptionsChange } = setup()
    fireEvent.click(screen.getByLabelText('忽略行首尾空白'))
    expect(onOptionsChange).toHaveBeenCalledWith({ trimWhitespace: true, ignoreCase: false, ignoreBlankLines: false, ignoreAllWhitespace: false, charMode: false })
  })

  it('切换忽略空行触发 onOptionsChange', () => {
    const { onOptionsChange } = setup()
    fireEvent.click(screen.getByLabelText('忽略空行'))
    expect(onOptionsChange).toHaveBeenCalledWith({ trimWhitespace: false, ignoreCase: false, ignoreBlankLines: true, ignoreAllWhitespace: false, charMode: false })
  })

  it('切换忽略所有空白触发 onOptionsChange', () => {
    const { onOptionsChange } = setup()
    fireEvent.click(screen.getByLabelText('忽略所有空白'))
    expect(onOptionsChange).toHaveBeenCalledWith({ trimWhitespace: false, ignoreCase: false, ignoreBlankLines: false, ignoreAllWhitespace: true, charMode: false })
  })

  it('切换字符级对比触发 onOptionsChange', () => {
    const { onOptionsChange } = setup()
    fireEvent.click(screen.getByLabelText('字符级对比'))
    expect(onOptionsChange).toHaveBeenCalledWith({ trimWhitespace: false, ignoreCase: false, ignoreBlankLines: false, ignoreAllWhitespace: false, charMode: true })
  })

  // 字符级开启时空白选项 label 带有“已包含”徽标，getByLabelText 需正则前缀匹配
  it('字符级对比开启时三个空白选项被禁用（语义已被包含）', () => {
    setup({ charMode: true })
    expect(screen.getByLabelText(/^忽略行首尾空白/)).toBeDisabled()
    expect(screen.getByLabelText(/^忽略空行/)).toBeDisabled()
    expect(screen.getByLabelText(/^忽略所有空白/)).toBeDisabled()
  })

  it('字符级对比开启时空白选项灰显勾选（语义已生效）并渲染“已包含”徽标', () => {
    const { container } = setup({ charMode: true })
    // 灰显勾选：checked 仅为视觉呈现，表达语义已随字符级生效
    expect(screen.getByLabelText(/^忽略行首尾空白/)).toBeChecked()
    expect(screen.getByLabelText(/^忽略空行/)).toBeChecked()
    expect(screen.getByLabelText(/^忽略所有空白/)).toBeChecked()
    // 徽标常显（无需悬停 title）
    expect(screen.getAllByText('已包含')).toHaveLength(3)
    expect(container.querySelectorAll('.switch.disabled')).toHaveLength(3)
  })

  it('字符级对比关闭时空白选项恢复用户原状态且不渲染徽标', () => {
    const { container } = setup({ baseOptions: { ignoreBlankLines: true } })
    // 用户原状态：仅忽略空行勾选
    expect(screen.getByLabelText('忽略行首尾空白')).not.toBeChecked()
    expect(screen.getByLabelText('忽略空行')).toBeChecked()
    expect(screen.getByLabelText('忽略所有空白')).not.toBeChecked()
    expect(screen.queryByText('已包含')).not.toBeInTheDocument()
    expect(container.querySelector('.switch.disabled')).toBeNull()
  })

  it('点击被包含的空白选项触发 onOptionBlocked 且不改写选项状态', () => {
    const onOptionBlocked = vi.fn()
    const { onOptionsChange } = setup({ charMode: true, onOptionBlocked })
    // 点击 label 本身（贴近真实用户点文字的行为；onClick preventDefault 阻止激活转发的干扰）
    const label = screen.getByLabelText(/^忽略所有空白/).closest('label') as HTMLElement
    fireEvent.click(label)
    expect(onOptionBlocked).toHaveBeenCalledWith('忽略所有空白')
    expect(onOptionsChange).not.toHaveBeenCalled()
  })

  it('字符级对比关闭时点击空白选项不触发 onOptionBlocked', () => {
    const onOptionBlocked = vi.fn()
    setup({ onOptionBlocked })
    fireEvent.click(screen.getByLabelText('忽略所有空白'))
    expect(onOptionBlocked).not.toHaveBeenCalled()
  })

  it('字符级因内容超限降级时开关旁显示“已降级”标记', () => {
    setup({ charMode: true, charModeDowngraded: true })
    expect(screen.getByText('已降级')).toBeInTheDocument()
  })

  it('字符级部分降级时显示“部分降级”标记（不出现整体降级标记）', () => {
    setup({ charMode: true, charModePartial: true })
    expect(screen.getByText('部分降级')).toBeInTheDocument()
    expect(screen.queryByText('已降级')).not.toBeInTheDocument()
  })

  it('整体降级优先呈现：同时标记时只显示“已降级”', () => {
    setup({ charMode: true, charModePartial: true, charModeDowngraded: true })
    expect(screen.getByText('已降级')).toBeInTheDocument()
    expect(screen.queryByText('部分降级')).not.toBeInTheDocument()
  })

  it('字符级关闭或未降级时不显示“部分降级”标记', () => {
    setup({ charMode: true })
    expect(screen.queryByText('部分降级')).not.toBeInTheDocument()
    setup({ charModePartial: true })
    expect(screen.queryByText('部分降级')).not.toBeInTheDocument()
  })

  it('未降级或字符级关闭时不显示“已降级”标记', () => {
    setup({ charMode: true })
    expect(screen.queryByText('已降级')).not.toBeInTheDocument()
    setup({ charModeDowngraded: true })
    expect(screen.queryByText('已降级')).not.toBeInTheDocument()
  })

  it('字符级对比开启时忽略大小写仍可用', () => {
    setup({ charMode: true })
    expect(screen.getByLabelText('忽略大小写')).toBeEnabled()
    expect(screen.getByLabelText('字符级对比')).toBeEnabled()
  })

  it('字符级对比关闭时空白选项恢复可用', () => {
    setup()
    expect(screen.getByLabelText('忽略行首尾空白')).toBeEnabled()
    expect(screen.getByLabelText('忽略空行')).toBeEnabled()
    expect(screen.getByLabelText('忽略所有空白')).toBeEnabled()
  })

  it('切换仅看差异触发 onOnlyDiffChange(true)', () => {
    const { onOnlyDiffChange } = setup()
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(onOnlyDiffChange).toHaveBeenCalledWith(true)
  })

  it('点击交换左右触发 onSwap', () => {
    const { onSwap } = setup()
    fireEvent.click(screen.getByText('⇄ 交换左右'))
    expect(onSwap).toHaveBeenCalledTimes(1)
  })

  it('点击下一处差异调用 onNav(1)', () => {
    const { onNav } = setup()
    fireEvent.click(screen.getByTitle(/下一处差异/))
    expect(onNav).toHaveBeenCalledWith(1)
  })

  it('点击上一处差异调用 onNav(-1)', () => {
    const { onNav } = setup()
    fireEvent.click(screen.getByTitle(/上一处差异/))
    expect(onNav).toHaveBeenCalledWith(-1)
  })

  it('导出菜单选择 HTML 触发 onExport("html")', () => {
    const { onExport } = setup()
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('HTML 报告'))
    expect(onExport).toHaveBeenCalledWith('html')
  })

  it('导出菜单含 Patch 项：可导出时点击触发 onExport("patch")（0.11.0）', () => {
    const { onExport } = setup({ canPatch: true })
    fireEvent.click(screen.getByText('导出报告'))
    const item = screen.getByText('Patch 标准差异')
    expect(item).not.toBeDisabled()
    fireEvent.click(item)
    expect(onExport).toHaveBeenCalledWith('patch')
  })

  it('canPatch 为 false 时 Patch 项禁用且点击不触发导出（判等污染提示，0.11.0）', () => {
    const { onExport } = setup({ canPatch: false })
    fireEvent.click(screen.getByText('导出报告'))
    const item = screen.getByText('Patch 标准差异')
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute(
      'title',
      expect.stringContaining('Patch 无法表达')
    )
    fireEvent.click(item)
    expect(onExport).not.toHaveBeenCalled()
  })

  it('未传 canPatch 时 Patch 项默认可用（缺省 true）', () => {
    setup()
    fireEvent.click(screen.getByText('导出报告'))
    expect(screen.getByText('Patch 标准差异')).not.toBeDisabled()
  })

  it('导出菜单向上弹出（工具栏贴窗口底部，防止溢出底边）', () => {
    const { container } = setup()
    fireEvent.click(screen.getByText('导出报告'))
    expect(container.querySelector('.export-menu.up')).not.toBeNull()
  })

  it('点击外部区域关闭导出菜单', () => {
    setup()
    fireEvent.click(screen.getByText('导出报告'))
    expect(screen.getByText('HTML 报告')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('HTML 报告')).not.toBeInTheDocument()
  })

  it('按 Esc 关闭导出菜单', () => {
    setup()
    fireEvent.click(screen.getByText('导出报告'))
    expect(screen.getByText('HTML 报告')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('HTML 报告')).not.toBeInTheDocument()
  })

  it('后台计算中禁用导出按钮', () => {
    setup({ computing: true })
    expect(screen.getByText('导出报告')).toBeDisabled()
  })
})

describe('Toolbar - 视图内搜索框', () => {
  it('未搜索时不显示命中计数', () => {
    setup()
    expect(screen.getByPlaceholderText('搜索内容… (Ctrl+F)')).toHaveValue('')
    expect(screen.getByPlaceholderText('搜索内容… (Ctrl+F)')).toBeVisible()
    // 搜索计数为空串（差异导航计数与此无关，限定 .search-count 断言）
    expect(document.querySelector('.search-count')?.textContent).toBe('')
  })

  it('搜索中显示当前序号与命中总数', () => {
    setup({ searchQuery: 'alpha', searchIndex: 1, searchCount: 5 })
    expect(screen.getByText('2 / 5')).toBeInTheDocument()
  })

  it('无命中显示 0 / N', () => {
    setup({ searchQuery: 'zzz', searchCount: 0 })
    expect(screen.getByText('0 / 0')).toBeInTheDocument()
  })

  it('输入触发 onSearchChange', () => {
    const { onSearchChange } = setup()
    fireEvent.change(screen.getByPlaceholderText('搜索内容… (Ctrl+F)'), {
      target: { value: 'target' }
    })
    expect(onSearchChange).toHaveBeenCalledWith('target')
  })

  it('Enter 触发 onSearchNav(1)，Shift+Enter 触发 onSearchNav(-1)', () => {
    const { onSearchNav } = setup({ searchQuery: 'a', searchCount: 2 })
    const input = screen.getByPlaceholderText('搜索内容… (Ctrl+F)')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSearchNav).toHaveBeenCalledWith(1)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSearchNav).toHaveBeenCalledWith(-1)
  })

  it('Esc 清空关键字并失焦', () => {
    const { onSearchChange } = setup({ searchQuery: 'stale' })
    const input = screen.getByPlaceholderText('搜索内容… (Ctrl+F)')
    input.focus()
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onSearchChange).toHaveBeenCalledWith('')
    expect(document.activeElement).not.toBe(input)
  })

  it('有内容时显示清空按钮，点击清空并保持焦点（0.10.5）', () => {
    const { onSearchChange } = setup({ searchQuery: 'find' })
    expect(screen.getByTitle('清空搜索（Esc）')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('清空搜索（Esc）'))
    expect(onSearchChange).toHaveBeenCalledWith('')
  })

  it('未搜索时不渲染清空按钮', () => {
    setup({ searchQuery: '' })
    expect(screen.queryByTitle('清空搜索（Esc）')).not.toBeInTheDocument()
  })

  it('searchInputRef 转发到输入框（Ctrl+F 聚焦用）', () => {
    const { searchInputRef } = setup()
    expect(searchInputRef.current).toBe(screen.getByPlaceholderText('搜索内容… (Ctrl+F)'))
  })
})