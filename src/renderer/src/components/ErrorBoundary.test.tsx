import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

// React 抛渲染错误时向 console.error 输出组件栈噪音，测试中静音
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/** 渲染期必抛错的子组件 */
function Boom(): never {
  throw new Error('boom in render')
}

describe('ErrorBoundary', () => {
  it('子组件渲染抛错时显示错误面板与重载按钮（不白屏）', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('界面渲染出现异常')).toBeInTheDocument()
    expect(screen.getByText('boom in render')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载应用' })).toBeInTheDocument()
  })

  it('子组件正常渲染时原样透传（零侵入）', () => {
    render(
      <ErrorBoundary>
        <div>ok-content</div>
      </ErrorBoundary>
    )
    expect(screen.getByText('ok-content')).toBeInTheDocument()
    expect(screen.queryByText('界面渲染出现异常')).not.toBeInTheDocument()
  })
})
