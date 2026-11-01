import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TextInputModal from './TextInputModal'

describe('TextInputModal', () => {
  it('输入文本并确认提交', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<TextInputModal title="粘贴左侧文本" onCancel={onCancel} onConfirm={onConfirm} />)
    const ta = screen.getByPlaceholderText(/粘贴或输入/)
    fireEvent.change(ta, { target: { value: 'hello\nworld' } })
    fireEvent.click(screen.getByText('开始对比'))
    expect(onConfirm).toHaveBeenCalledWith('hello\nworld')
  })

  it('点击取消触发 onCancel', () => {
    const onCancel = vi.fn()
    render(
      <TextInputModal title="粘贴左侧文本" onCancel={onCancel} onConfirm={vi.fn()} />
    )
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('按 Esc 触发 onCancel', () => {
    const onCancel = vi.fn()
    render(
      <TextInputModal title="粘贴左侧文本" onCancel={onCancel} onConfirm={vi.fn()} />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('Ctrl+Enter 快捷提交', () => {
    const onConfirm = vi.fn()
    render(
      <TextInputModal title="粘贴左侧文本" onCancel={vi.fn()} onConfirm={onConfirm} />
    )
    const ta = screen.getByPlaceholderText(/粘贴或输入/)
    fireEvent.change(ta, { target: { value: 'a\nb' } })
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true })
    expect(onConfirm).toHaveBeenCalledWith('a\nb')
  })
})