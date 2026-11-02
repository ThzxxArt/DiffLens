import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'

describe('ContextMenu', () => {
  it('渲染菜单项并触行动作后关闭', () => {
    const action = vi.fn()
    const onClose = vi.fn()
    const items: ContextMenuItem[] = [{ label: '复制此行内容', action }]
    const { container } = render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />)
    fireEvent.click(screen.getByText('复制此行内容'))
    expect(action).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
    expect(container.firstChild).toBeTruthy()
  })

  it('禁用项不触行动作', () => {
    const action = vi.fn()
    const onClose = vi.fn()
    const items: ContextMenuItem[] = [
      { label: '在文件夹中显示', disabled: true, action },
      { label: '复制文件名', action }
    ]
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />)
    fireEvent.click(screen.getByText('在文件夹中显示'))
    expect(action).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点击遮罩层触发关闭', () => {
    const onClose = vi.fn()
    const { container } = render(<ContextMenu x={10} y={10} items={[]} onClose={onClose} />)
    const backdrop = container.querySelector('.ctx-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.mouseDown(backdrop as Element)
    expect(onClose).toHaveBeenCalled()
  })

  it('右键遮罩层触发关闭', () => {
    const onClose = vi.fn()
    const { container } = render(<ContextMenu x={10} y={10} items={[]} onClose={onClose} />)
    fireEvent.contextMenu(container.querySelector('.ctx-backdrop') as Element)
    expect(onClose).toHaveBeenCalled()
  })

  it('按 Esc 触发关闭', () => {
    const onClose = vi.fn()
    render(<ContextMenu x={10} y={10} items={[]} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('靠近右/下边缘时收回视口内', () => {
    // 模拟菜单实测尺寸 200x120
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 120,
      top: 0,
      left: 0,
      right: 200,
      bottom: 120,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect)
    render(
      <ContextMenu
        x={window.innerWidth + 500}
        y={window.innerHeight + 500}
        items={[{ label: '菜单项', action: vi.fn() }]}
        onClose={vi.fn()}
      />
    )
    const menu = document.querySelector('.ctx-menu') as HTMLElement
    expect(parseFloat(menu.style.left)).toBe(window.innerWidth - 8 - 200)
    expect(parseFloat(menu.style.top)).toBe(window.innerHeight - 8 - 120)
    rectSpy.mockRestore()
  })

  it('未溢出时保持原始坐标', () => {
    render(
      <ContextMenu x={10} y={10} items={[{ label: '菜单项', action: vi.fn() }]} onClose={vi.fn()} />
    )
    const menu = document.querySelector('.ctx-menu') as HTMLElement
    expect(menu.style.left).toBe('10px')
    expect(menu.style.top).toBe('10px')
  })

  describe('键盘导航', () => {
    const mkItems = (actions: { label: string; disabled?: boolean }[]) =>
      actions.map((a) => ({ label: a.label, disabled: a.disabled, action: vi.fn() }))

    it('ArrowDown 依次高亮（首项起步）；ArrowUp 从末项起步', () => {
      const items = mkItems([{ label: 'A' }, { label: 'B' }, { label: 'C' }])
      render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />)
      // 无高亮时按下 → 第一项
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      expect(screen.getByText('A')).toHaveClass('active')
      // 再按下 → 第二项
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      expect(screen.getByText('B')).toHaveClass('active')
      expect(screen.getByText('A')).not.toHaveClass('active')
      // 无高亮语义验证：重新渲染后按上 → 末项
      cleanup()
      render(
        <ContextMenu
          x={10}
          y={10}
          items={mkItems([{ label: 'A' }, { label: 'B' }, { label: 'C' }])}
          onClose={vi.fn()}
        />
      )
      fireEvent.keyDown(document, { key: 'ArrowUp' })
      expect(screen.getByText('C')).toHaveClass('active')
    })

    it('首尾循环导航', () => {
      const items = mkItems([{ label: 'A' }, { label: 'B' }])
      render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />)
      fireEvent.keyDown(document, { key: 'ArrowDown' }) // → A（索引 0）
      fireEvent.keyDown(document, { key: 'ArrowUp' }) // 循环回末项 B
      expect(screen.getByText('B')).toHaveClass('active')
      fireEvent.keyDown(document, { key: 'ArrowDown' }) // 循环回首项 A
      expect(screen.getByText('A')).toHaveClass('active')
    })

    it('方向键跳过禁用项', () => {
      const items = mkItems([{ label: 'A' }, { label: 'B', disabled: true }, { label: 'C' }])
      render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />)
      fireEvent.keyDown(document, { key: 'ArrowDown' }) // → A
      fireEvent.keyDown(document, { key: 'ArrowDown' }) // B 禁用 → 跳到 C
      expect(screen.getByText('C')).toHaveClass('active')
      expect(screen.getByText('B')).not.toHaveClass('active')
    })

    it('Enter 触发高亮项并关闭；无高亮时 Enter 不触发', () => {
      const action = vi.fn()
      const onClose = vi.fn()
      // 被测 spy 挂在第二项：两次 ArrowDown 高亮到该项后 Enter 触发
      const items: ContextMenuItem[] = [
        { label: 'A', action: vi.fn() },
        { label: 'B', action }
      ]
      render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />)
      // 无高亮：Enter 无操作
      fireEvent.keyDown(document, { key: 'Enter' })
      expect(action).not.toHaveBeenCalled()
      // 高亮第二项后 Enter 触发
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      fireEvent.keyDown(document, { key: 'Enter' })
      expect(action).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('鼠标悬停同步高亮', () => {
      const items = mkItems([{ label: 'A' }, { label: 'B' }])
      render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />)
      fireEvent.mouseEnter(screen.getByText('B'))
      expect(screen.getByText('B')).toHaveClass('active')
    })

    it('全部禁用时方向键不高亮任何项（不崩溃）', () => {
      const items = mkItems([
        { label: 'A', disabled: true },
        { label: 'B', disabled: true }
      ])
      render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />)
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      fireEvent.keyDown(document, { key: 'ArrowUp' })
      expect(screen.getByText('A')).not.toHaveClass('active')
      expect(screen.getByText('B')).not.toHaveClass('active')
    })
  })
})
