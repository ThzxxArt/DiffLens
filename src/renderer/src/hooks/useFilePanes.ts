import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { CLEAR_CONFIRM_MS, MAX_FILE_SIZE } from '../app/constants'
import type { PaneState } from '../app/types'
import { countLines, HEAVY_LINES, isTextFile } from '../diff/textUtils'
import type { ShowToast } from './useToast'

/**
 * 单文件对比两侧面板：打开/拖拽/粘贴装载、交换、清空二次确认。
 * 文件读取走主进程 IPC；文件夹双击进入时复用 applyFileData。
 */
export function useFilePanes({ showToast }: { showToast: ShowToast }): {
  paneL: PaneState | null
  paneR: PaneState | null
  setPaneL: Dispatch<SetStateAction<PaneState | null>>
  setPaneR: Dispatch<SetStateAction<PaneState | null>>
  clearPanes: () => void
  openPane: (side: 'left' | 'right') => Promise<void>
  dropPane: (side: 'left' | 'right', files: File[]) => Promise<void>
  applyFileData: (
    side: 'left' | 'right',
    data: NonNullable<Awaited<ReturnType<typeof window.api.readByPath>>>
  ) => boolean
  applyManualText: (side: 'left' | 'right', text: string) => boolean
  swapPanes: () => void
  handleClear: () => void
  anyPane: boolean
} {
  const [paneL, setPaneL] = useState<PaneState | null>(null)
  const [paneR, setPaneR] = useState<PaneState | null>(null)

  // 超多行预警：行数超过阈值时提示后台计算耗时（渲染已虚拟化、计算已 worker 化，均不阻塞界面）
  const warnHeavyLines = useCallback(
    (text: string): void => {
      const lines = countLines(text)
      if (lines > HEAVY_LINES)
        showToast(`行数较多（${lines} 行），差异将在后台计算，可能需要一些时间`)
    },
    [showToast]
  )

  /** 将主进程文件读取结果应用到指定侧面板（openPane 与文件夹双击进入共用：错误提示/预警/装载） */
  const applyFileData = useCallback(
    (
      side: 'left' | 'right',
      data: NonNullable<Awaited<ReturnType<typeof window.api.readByPath>>>
    ): boolean => {
      if ('error' in data) {
        showToast(
          data.error === 'too-large'
            ? `文件超过 10MB，暂不支持对比：${data.name ?? ''}`
            : `文件读取失败：${data.name ?? ''}（可能被占用或权限不足）`
        )
        return false
      }
      if (data.binary) showToast(`疑似二进制文件，内容可能乱码：${data.name}`)
      warnHeavyLines(data.text)
      const pane: PaneState = {
        meta: { name: data.name, encoding: data.encoding },
        path: data.path,
        text: data.text
      }
      if (side === 'left') setPaneL(pane)
      else setPaneR(pane)
      return true
    },
    [showToast, warnHeavyLines]
  )

  const openPane = useCallback(
    async (side: 'left' | 'right') => {
      let data: Awaited<ReturnType<typeof window.api.openFile>>
      try {
        data = await window.api.openFile(side)
      } catch {
        showToast('文件读取失败，请重试')
        return
      }
      if (!data) return
      applyFileData(side, data)
    },
    [showToast, applyFileData]
  )

  const dropPane = useCallback(
    async (side: 'left' | 'right', files: File[]) => {
      const file = files[0]
      if (!file) return
      if (files.length > 1) showToast('一次只能导入一个文件，已取第一个')
      if (!isTextFile(file.name)) {
        showToast(`仅支持文本文件：${file.name}`)
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        showToast(`文件超过 10MB，暂不支持对比：${file.name}`)
        return
      }
      let text: string
      let encoding = 'UTF-8'
      let binary = false
      try {
        const buf = await file.arrayBuffer()
        const decoded = await window.api.decodeBuffer(buf)
        text = decoded.text
        encoding = decoded.encoding
        binary = decoded.binary
      } catch {
        // IPC 解码失败时回退浏览器原生读取；两者都失败则明确报错，不静默加载空文本
        const fallback = await file.text().catch(() => null)
        if (fallback === null) {
          showToast(`文件读取失败：${file.name}`)
          return
        }
        text = fallback
      }
      if (binary) showToast(`疑似二进制文件，内容可能乱码：${file.name}`)
      warnHeavyLines(text)
      const pane: PaneState = { meta: { name: file.name, encoding }, path: '', text }
      if (side === 'left') setPaneL(pane)
      else setPaneR(pane)
    },
    [showToast, warnHeavyLines]
  )

  /** 手动粘贴/输入文本装入指定侧：空内容与 10MB 上限拦截，成功返回 true */
  const applyManualText = useCallback(
    (side: 'left' | 'right', text: string): boolean => {
      // 空白内容拦截：进入对比只会得到空面板与"完全一致"的误导性结果
      if (text.trim() === '') {
        showToast('内容为空，请先输入或粘贴文本')
        return false
      }
      // 与文件入口的 10MB 字节上限保持对称：超限拒绝且不关闭弹窗，保留内容供编辑
      if (new TextEncoder().encode(text).length > MAX_FILE_SIZE) {
        showToast('粘贴内容超过 10MB，暂不支持对比')
        return false
      }
      warnHeavyLines(text)
      const pane: PaneState = { meta: { name: '手动文本', encoding: '文本' }, path: '', text }
      if (side === 'left') setPaneL(pane)
      else setPaneR(pane)
      return true
    },
    [showToast, warnHeavyLines]
  )

  // 交换左右两侧（React 事件回调内自动批处理，两态一同更新）
  const swapPanes = useCallback((): void => {
    setPaneL(paneR)
    setPaneR(paneL)
  }, [paneL, paneR])

  // 清空二次确认：两侧有内容时第一次点击仅提示，确认窗口内再点才真正清空
  // （文件可重新打开，粘贴输入的手动文本无法恢复，需防误触）
  const clearArmedRef = useRef(false)
  const clearTimer = useRef<number | null>(null)

  const handleClear = useCallback((): void => {
    // 空态无内容，无需确认成本
    if (paneL === null && paneR === null) return
    if (clearArmedRef.current) {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
      clearArmedRef.current = false
      clearTimer.current = null
      setPaneL(null)
      setPaneR(null)
      return
    }
    clearArmedRef.current = true
    showToast('再次点击“清空”将移除两侧内容')
    clearTimer.current = window.setTimeout(() => {
      clearArmedRef.current = false
      clearTimer.current = null
    }, CLEAR_CONFIRM_MS)
  }, [paneL, paneR, showToast])

  // 卸载时清理确认窗口定时器
  useEffect(() => {
    return () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
    }
  }, [])

  const clearPanes = useCallback((): void => {
    setPaneL(null)
    setPaneR(null)
  }, [])

  return {
    paneL,
    paneR,
    setPaneL,
    setPaneR,
    clearPanes,
    openPane,
    dropPane,
    applyFileData,
    applyManualText,
    swapPanes,
    handleClear,
    anyPane: paneL !== null || paneR !== null
  }
}
