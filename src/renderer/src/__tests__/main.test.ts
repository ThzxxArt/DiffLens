import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act } from '@testing-library/react'

// main.tsx 引入全局样式，测试中替换为空模块避免 CSS 处理
vi.mock('../styles/global.css', () => ({}))

describe('main 入口', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    vi.resetModules()
    // App 挂载期订阅扫描进度推送（onScanProgress）：入口冒烟需要可用的 api 桩
    window.api = {
      openFile: async () => null,
      decodeBuffer: async () => ({ text: '', encoding: 'UTF-8', binary: false }),
      saveReport: async () => ({ ok: false, path: null }),
      showInFolder: async () => true,
      setClipboard: async () => true,
      pickFolder: async () => null,
      scanFolder: async () => ({ entries: [], truncated: false, total: 0 }),
      onScanProgress: (): (() => void) => () => {},
      readByPath: async () => null,
      readFilesByPaths: async () => ({ files: [] }),
      readSnapshot: async () => null,
      getVersion: async () => '0.0.0-test'
    } as typeof window.api
  })

  it('挂载 DiffLens 应用（覆盖 main.tsx 入口）', async () => {
    await act(async () => {
      await import('../main')
    })
    expect(document.getElementById('root')).toBeTruthy()
    expect(await screen.findByText('DiffLens')).toBeInTheDocument()
  })
})
