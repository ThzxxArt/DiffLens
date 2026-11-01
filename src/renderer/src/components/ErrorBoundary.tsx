import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 顶层渲染错误兜底：任何子组件渲染期抛错时显示错误面板与一键重载，
 * 替代整窗白屏死机（用户至少能自助恢复）。
 * 捕获范围：渲染与生命周期阶段的错误（React ErrorBoundary 的固有边界）；
 * 事件回调内的异常不经过此边界，由各回调自身的 try/catch 防御。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('渲染错误（ErrorBoundary 捕获）：', error)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="error-boundary">
          <h2>界面渲染出现异常</h2>
          <p className="error-message">{this.state.error.message || String(this.state.error)}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            重新加载应用
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
