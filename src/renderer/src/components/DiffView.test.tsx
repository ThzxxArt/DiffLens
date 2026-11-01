import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DiffView, { ROW_HEIGHT, type FoldMarker, type DisplayItem } from './DiffView'
import type { DiffRow } from '../diff/diffEngine'

beforeAll(() => {
  // jsdom 未实现滚动定位，测试里打桩（虚拟化后导航定位走 scrollTo）
  Element.prototype.scrollTo = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

function renderDiff(
  items: DisplayItem[],
  activeRowId: string | null = null,
  searchQuery?: string
) {
  return render(
    <DiffView
      items={items}
      leftMeta={{ name: 'a.txt', encoding: 'UTF-8' }}
      rightMeta={{ name: 'b.txt', encoding: 'GBK' }}
      activeRowId={activeRowId}
      searchQuery={searchQuery}
      onOpen={vi.fn()}
      onRowContext={vi.fn()}
      onDropFile={vi.fn()}
    />
  )
}

const baseRows: DiffRow[] = [
  {
    id: 'r0',
    rowKind: 'unchanged',
    isChanged: false,
    left: { lineNo: 1, text: 'hello', segs: null },
    right: { lineNo: 1, text: 'hello', segs: null }
  },
  {
    id: 'r1',
    rowKind: 'added',
    isChanged: true,
    left: { lineNo: null, text: null, segs: null },
    right: { lineNo: 2, text: 'world', segs: null }
  }
]

describe('DiffView', () => {
  it('渲染左右文件名与同/新增行内容', () => {
    renderDiff(baseRows)
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    expect(screen.getAllByText('hello').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('world').length).toBeGreaterThan(0)
  })

  it('渲染行号', () => {
    renderDiff(baseRows)
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2').length).toBeGreaterThan(0)
  })

  it('设置活动行时通过受控 scrollTop 定位（scrollTo）', () => {
    renderDiff(baseRows, 'r1')
    expect(Element.prototype.scrollTo).toHaveBeenCalled()
  })

  it('词级 segs 渲染删除/新增高亮段', () => {
    const modRow: DiffRow = {
      id: 'm0',
      rowKind: 'modified',
      isChanged: true,
      left: {
        lineNo: 1,
        text: 'hello x',
        segs: [
          { text: 'hello ', kind: 'common' },
          { text: 'x', kind: 'delete' }
        ]
      },
      right: {
        lineNo: 1,
        text: 'hello y',
        segs: [
          { text: 'hello ', kind: 'common' },
          { text: 'y', kind: 'insert' }
        ]
      }
    }
    const { container } = renderDiff([modRow])
    expect(container.querySelector('.seg-delete')).toBeTruthy()
    expect(container.querySelector('.seg-insert')).toBeTruthy()
  })

  it('左侧滚动时同步右侧面板', () => {
    const { container } = renderDiff(baseRows)
    const scrollers = container.querySelectorAll('.diff-scroll')
    expect(scrollers).toHaveLength(2)
    const left = scrollers[0] as HTMLElement
    const right = scrollers[1] as HTMLElement
    left.scrollTop = 120
    fireEvent.scroll(left)
    expect(right.scrollTop).toBe(120)
  })

  it('横向滚动时同步另一侧面板', () => {
    const { container } = renderDiff(baseRows)
    const scrollers = container.querySelectorAll('.diff-scroll')
    const left = scrollers[0] as HTMLElement
    const right = scrollers[1] as HTMLElement
    left.scrollLeft = 80
    fireEvent.scroll(left)
    expect(right.scrollLeft).toBe(80)
  })

  it('右侧滚动时同步左侧面板', () => {
    const { container } = renderDiff(baseRows)
    const scrollers = container.querySelectorAll('.diff-scroll')
    const left = scrollers[0] as HTMLElement
    const right = scrollers[1] as HTMLElement
    right.scrollTop = 66
    fireEvent.scroll(right)
    expect(left.scrollTop).toBe(66)
  })

  it('右键内容行触发 onRowContext', () => {
    const onRowContext = vi.fn()
    render(
      <DiffView
        items={baseRows}
        leftMeta={{ name: 'a.txt', encoding: 'UTF-8' }}
        rightMeta={{ name: 'b.txt', encoding: 'GBK' }}
        activeRowId={null}
        onOpen={vi.fn()}
        onRowContext={onRowContext}
        onDropFile={vi.fn()}
      />
    )
    fireEvent.contextMenu(screen.getAllByText('hello')[0])
    expect(onRowContext).toHaveBeenCalled()
  })

  it('点击面板头打开按钮触发 onOpen', () => {
    const onOpen = vi.fn()
    render(
      <DiffView
        items={baseRows}
        leftMeta={{ name: 'a.txt', encoding: 'UTF-8' }}
        rightMeta={{ name: 'b.txt', encoding: 'GBK' }}
        activeRowId={null}
        onOpen={onOpen}
        onRowContext={vi.fn()}
        onDropFile={vi.fn()}
      />
    )
    fireEvent.click(screen.getAllByText('重新选择')[0])
    expect(onOpen).toHaveBeenCalledWith('left')
  })

  it('渲染行尾空白可视标注', () => {
    const row: DiffRow = {
      id: 'w0',
      rowKind: 'unchanged',
      isChanged: false,
      left: { lineNo: 1, text: 'pad  ', segs: null },
      right: { lineNo: 1, text: 'pad  ', segs: null }
    }
    const { container } = renderDiff([row])
    expect(container.querySelector('.ws')).toBeTruthy()
  })

  it('拖放文件到面板触发 onDropFile', () => {
    const onDropFile = vi.fn()
    const { container } = render(
      <DiffView
        items={baseRows}
        leftMeta={{ name: 'a.txt', encoding: 'UTF-8' }}
        rightMeta={{ name: 'b.txt', encoding: 'GBK' }}
        activeRowId={null}
        onOpen={vi.fn()}
        onRowContext={vi.fn()}
        onDropFile={onDropFile}
      />
    )
    const panes = container.querySelectorAll('.pane')
    const file = new File(['x'], 'c.txt', { type: 'text/plain' })
    fireEvent.drop(panes[0] as Element, { dataTransfer: { files: [file] } })
    expect(onDropFile).toHaveBeenCalledWith('left', [file])
  })
})

describe('DiffView - 虚拟滚动', () => {
  function makeRows(n: number): DiffRow[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `v${i}`,
      rowKind: 'unchanged' as const,
      isChanged: false,
      left: { lineNo: i + 1, text: `L${i}`, segs: null },
      right: { lineNo: i + 1, text: `R${i}`, segs: null }
    }))
  }

  it('大行数下只渲染可见窗口（DOM 行数远小于总量）', () => {
    const { container } = renderDiff(makeRows(1000))
    const rows = container.querySelectorAll('.diff-row')
    // 两栏合计不超过 (600/21 向上取整 + 2×overscan) × 2 附近的量级
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(200)
  })

  it('滚动后窗口移动到对应区段', () => {
    const { container } = renderDiff(makeRows(1000))
    const scrollers = container.querySelectorAll('.diff-scroll')
    const left = scrollers[0] as HTMLElement
    left.scrollTop = 500 * ROW_HEIGHT
    fireEvent.scroll(left)
    expect(screen.getAllByText('L500').length).toBeGreaterThan(0)
    // 远离窗口的行不再渲染
    expect(screen.queryByText('L0')).not.toBeInTheDocument()
  })

  it('滚动容器总高度按全部行数撑满', () => {
    const { container } = renderDiff(makeRows(100))
    const columns = container.querySelectorAll('.diff-columns') as NodeListOf<HTMLElement>
    expect(columns[0].style.height).toBe(`${100 * ROW_HEIGHT}px`)
  })

  it('探针测得字符宽后按最大列宽设置 minWidth', () => {
    // 探针 10 字符 mock 宽度 70px → 每字符 7px；左 50 列 / 右 60 列（均超过 colsOf 的 40 列下限）
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 70,
      height: 21,
      top: 0,
      left: 0,
      right: 70,
      bottom: 21,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect)
    const wideRow: DiffRow = {
      id: 'w1',
      rowKind: 'unchanged',
      isChanged: false,
      left: { lineNo: 1, text: 'a'.repeat(50), segs: null },
      right: { lineNo: 1, text: '中'.repeat(30), segs: null }
    }
    const { container } = renderDiff([wideRow])
    const columns = container.querySelectorAll('.diff-columns') as NodeListOf<HTMLElement>
    // 左：50 半角列 × 7 + 86 固定开销；右：30 全角 = 60 列 × 7 + 86
    expect(columns[0].style.minWidth).toBe('436px')
    expect(columns[1].style.minWidth).toBe('506px')
    rectSpy.mockRestore()
  })

  it('探针未测得宽度时不设置 minWidth（退回 CSS max-content）', () => {
    const { container } = renderDiff(baseRows)
    const columns = container.querySelectorAll('.diff-columns') as NodeListOf<HTMLElement>
    expect(columns[0].style.minWidth).toBe('')
    expect(columns[1].style.minWidth).toBe('')
  })

  it('超长行列宽封顶，minWidth 不随行长无限增长', () => {
    // 探针 mock 为 10 字符 70px → 每字符 7px；列宽封顶 5000 → 5000×7+86
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 70,
      height: 21,
      top: 0,
      left: 0,
      right: 70,
      bottom: 21,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect)
    const longRow: DiffRow = {
      id: 'long0',
      rowKind: 'unchanged',
      isChanged: false,
      left: { lineNo: 1, text: 'a'.repeat(200000), segs: null },
      right: { lineNo: 1, text: 'b', segs: null }
    }
    const { container } = renderDiff([longRow])
    const columns = container.querySelectorAll('.diff-columns') as NodeListOf<HTMLElement>
    expect(columns[0].style.minWidth).toBe('35086px')
    rectSpy.mockRestore()
  })
})

describe('DiffView - 折叠提示行', () => {
  it('渲染折叠提示与行数', () => {
    const items: DisplayItem[] = [
      { fold: true, skipped: 42 },
      {
        id: 'r9',
        rowKind: 'modified',
        isChanged: true,
        left: { lineNo: 43, text: 'a', segs: null },
        right: { lineNo: 43, text: 'b', segs: null }
      }
    ]
    const { container } = renderDiff(items)
    expect(screen.getAllByText(/已折叠 42 行相同内容/).length).toBe(2)
    expect(container.querySelectorAll('.diff-row.fold').length).toBe(2)
  })

  it('自定义文案（完全一致场景）覆盖默认提示', () => {
    const m: FoldMarker = { fold: true, skipped: 10, note: '两文件内容完全一致，已折叠全部未更改行' }
    renderDiff([m])
    expect(screen.getAllByText('两文件内容完全一致，已折叠全部未更改行').length).toBe(2)
  })
})

describe('DiffView - 搜索命中高亮', () => {
  it('纯文本行命中子串高亮（大小写不敏感，两侧各自渲染）', () => {
    const row: DiffRow = {
      id: 's0',
      rowKind: 'unchanged',
      isChanged: false,
      left: { lineNo: 1, text: 'find TARGET here', segs: null },
      right: { lineNo: 1, text: 'target elsewhere', segs: null }
    }
    const { container } = renderDiff([row], null, 'target')
    const hits = container.querySelectorAll('.search-hit')
    // 左右各一处命中（左侧 TARGET 大写命中）
    expect(hits).toHaveLength(2)
    expect(hits[0].textContent).toBe('TARGET')
    expect(hits[1].textContent).toBe('target')
  })

  it('同一行多处命中全部拆分高亮', () => {
    const row: DiffRow = {
      id: 's1',
      rowKind: 'unchanged',
      isChanged: false,
      left: { lineNo: 1, text: 'ab ab ab', segs: null },
      right: { lineNo: 1, text: 'ab ab ab', segs: null }
    }
    const { container } = renderDiff([row], null, 'ab')
    // 每侧 3 处命中
    expect(container.querySelectorAll('.search-hit')).toHaveLength(6)
  })

  it('词级 segs 行内命中同样高亮（seg 文本内拆分）', () => {
    const modRow: DiffRow = {
      id: 's2',
      rowKind: 'modified',
      isChanged: true,
      left: {
        lineNo: 1,
        text: 'keep target old',
        segs: [
          { text: 'keep ', kind: 'common' },
          { text: 'target', kind: 'delete' },
          { text: ' old', kind: 'common' }
        ]
      },
      right: {
        lineNo: 1,
        text: 'keep new old',
        segs: [
          { text: 'keep ', kind: 'common' },
          { text: 'new', kind: 'insert' },
          { text: ' old', kind: 'common' }
        ]
      }
    }
    const { container } = renderDiff([modRow], null, 'target')
    const hits = container.querySelectorAll('.search-hit')
    // 仅左侧 delete seg 内命中一处
    expect(hits).toHaveLength(1)
    expect(hits[0].textContent).toBe('target')
  })

  it('无命中不渲染高亮 span；未传 searchQuery 不高亮', () => {
    const row: DiffRow = {
      id: 's3',
      rowKind: 'unchanged',
      isChanged: false,
      left: { lineNo: 1, text: 'plain', segs: null },
      right: { lineNo: 1, text: 'plain', segs: null }
    }
    const miss = renderDiff([row], null, 'zzz')
    expect(miss.container.querySelectorAll('.search-hit')).toHaveLength(0)
    const none = renderDiff([row])
    expect(none.container.querySelectorAll('.search-hit')).toHaveLength(0)
  })
})
