import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AboutModal, { ABOUT_INFO } from './AboutModal'

function setup(overrides?: { version?: string }): {
  onClose: ReturnType<typeof vi.fn>
  onCopy: ReturnType<typeof vi.fn>
} {
  const onClose = vi.fn()
  const onCopy = vi.fn()
  render(<AboutModal version={overrides?.version ?? '0.10.2'} onClose={onClose} onCopy={onCopy} />)
  return { onClose, onCopy }
}

describe('AboutModal - 渲染', () => {
  it('展示应用名、版本与全部元信息（作者/邮箱/开源地址/许可证）', () => {
    setup()
    expect(screen.getByText(ABOUT_INFO.name)).toBeInTheDocument()
    expect(screen.getByText('版本 0.10.2')).toBeInTheDocument()
    expect(screen.getByText(ABOUT_INFO.description)).toBeInTheDocument()
    expect(screen.getByText(ABOUT_INFO.author)).toBeInTheDocument()
    for (const m of ABOUT_INFO.emails) {
      expect(screen.getByText(m)).toBeInTheDocument()
    }
    expect(screen.getByText(ABOUT_INFO.repoUrl)).toBeInTheDocument()
    expect(screen.getByText(ABOUT_INFO.license)).toBeInTheDocument()
    expect(screen.getByText(/© 2026 ThzxxArt/)).toBeInTheDocument()
  })

  it('版本号未取得时显示占位（版本 —）', () => {
    setup({ version: '' })
    expect(screen.getByText('版本 —')).toBeInTheDocument()
  })
})

describe('AboutModal - 复制交互', () => {
  it('点击邮箱触发 onCopy（携带邮箱与标签）', () => {
    const { onCopy } = setup()
    fireEvent.click(screen.getByText('stinanimz@gmail.com'))
    expect(onCopy).toHaveBeenCalledWith('stinanimz@gmail.com', '邮箱')
    fireEvent.click(screen.getByText('1440196015@qq.com'))
    expect(onCopy).toHaveBeenCalledWith('1440196015@qq.com', '邮箱')
  })

  it('点击开源地址/作者触发 onCopy', () => {
    const { onCopy } = setup()
    fireEvent.click(screen.getByText(ABOUT_INFO.repoUrl))
    expect(onCopy).toHaveBeenCalledWith(ABOUT_INFO.repoUrl, '开源地址')
    fireEvent.click(screen.getByText(ABOUT_INFO.author))
    expect(onCopy).toHaveBeenCalledWith(ABOUT_INFO.author, '作者')
  })

  it('许可证为纯展示不可点击（不触发 onCopy）', () => {
    const { onCopy } = setup()
    fireEvent.click(screen.getByText(ABOUT_INFO.license))
    expect(onCopy).not.toHaveBeenCalled()
  })
})

describe('AboutModal - 关闭交互', () => {
  it('Esc 触发 onClose', () => {
    const { onClose } = setup()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击遮罩触发 onClose；点击弹框内容区不关闭', () => {
    const { onClose } = setup()
    fireEvent.mouseDown(screen.getByText(ABOUT_INFO.name))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.querySelector('.modal-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击右上角关闭按钮触发 onClose', () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: '✕' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('卸载后 Esc 监听移除（不再触发 onClose）', () => {
    const onClose = vi.fn()
    const onCopy = vi.fn()
    const { unmount } = render(<AboutModal version="0.10.2" onClose={onClose} onCopy={onCopy} />)
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
