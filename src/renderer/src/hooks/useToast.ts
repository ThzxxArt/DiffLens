import { useCallback, useEffect, useRef, useState } from 'react'
import { TOAST_MAX } from '../app/constants'

export interface ToastItem {
  id: number
  text: string
  action?: ToastAction
}

export interface ToastAction {
  label: string
  onClick: () => void
}

export type ShowToast = (text: string, action?: ToastAction) => void

/**
 * toast 队列：最多同时展示 3 条，各自独立计时互不清除
 * （此前单条覆盖式会互顶：二进制乱码预警被行数预警立即顶掉，用户看不到前一条）
 */
export function useToast(): {
  toasts: ToastItem[]
  showToast: ShowToast
  dismissToast: (id: number) => void
} {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const toastSeq = useRef(0)
  const toastTimers = useRef(new Map<number, number>())

  const showToast = useCallback<ShowToast>((text, action) => {
    const id = ++toastSeq.current
    setToasts((prev) => {
      const next = [...prev, { id, text, action }]
      // 超出上限时顶掉最旧的一条（其定时器到期后空过滤，无副作用）
      return next.length > TOAST_MAX ? next.slice(next.length - TOAST_MAX) : next
    })
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
      toastTimers.current.delete(id)
    }, 3600)
    toastTimers.current.set(id, timer)
  }, [])

  const dismissToast = useCallback((id: number): void => {
    const timer = toastTimers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      toastTimers.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // 卸载时清理全部定时器，避免泄漏
  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [])

  return { toasts, showToast, dismissToast }
}
