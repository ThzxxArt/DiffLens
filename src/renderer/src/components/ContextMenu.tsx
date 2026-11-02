import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'

export interface ContextMenuItem {
  label: string
  disabled?: boolean
  action: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  // 键盘导航高亮项（-1 = 无高亮；disabled 项不可选中）
  const [active, setActive] = useState(-1)

  // Esc 关闭菜单；↑/↓ 在可选项间移动高亮（首尾循环、跳过禁用项）；Enter 触发高亮项
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        setActive((prev) => {
          if (items.length === 0) return prev
          // 无高亮时按方向从首项/末项出发；有高亮从当前项出发循环找下一个可选项
          const start = prev < 0 ? (dir === 1 ? -1 : items.length) : prev
          let n = start
          for (let i = 0; i < items.length; i++) {
            n = (n + dir + items.length) % items.length
            if (!items[n].disabled) return n
          }
          return prev // 全部禁用：保持不动
        })
        return
      }
      if (e.key === 'Enter') {
        const it = active >= 0 ? items[active] : undefined
        if (it && !it.disabled) {
          it.action()
          onClose()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [items, active, onClose])

  // 渲染后实测菜单尺寸，溢出视口时收回边界内（右/下各留 8px 边距）
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 8
    let left = x
    let top = y
    if (left + width > vw - margin) left = Math.max(margin, vw - margin - width)
    if (top + height > vh - margin) top = Math.max(margin, vh - margin - height)
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [x, y, items])

  return (
    <div
      className="ctx-backdrop"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={menuRef}
        className="ctx-menu"
        style={{ left: pos.left, top: pos.top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
          <button
            key={i}
            className={
              'ctx-item' + (active === i ? ' active' : '') + (it.disabled ? ' disabled' : '')
            }
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              if (!it.disabled) {
                it.action()
                onClose()
              }
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  )
}
