import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDiffWorker } from './createDiffWorker'

describe('createDiffWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('环境不支持 Worker 时返回 null（jsdom 回退路径）', () => {
    expect(typeof Worker).toBe('undefined')
    expect(createDiffWorker()).toBeNull()
  })

  it('环境支持时返回 worker 实例', () => {
    const created: unknown[] = []
    class FakeWorker {
      constructor() {
        created.push(this)
      }
    }
    vi.stubGlobal('Worker', FakeWorker)
    // jsdom 无 URL.createObjectURL，直接定义补桩（spyOn 要求属性已存在）
    Object.defineProperty(URL, 'createObjectURL', {
      value: (): string => 'blob:fake-worker',
      configurable: true,
      writable: true
    })
    try {
      const w = createDiffWorker()
      expect(w).not.toBeNull()
      expect(created).toHaveLength(1)
    } finally {
      delete (URL as { createObjectURL?: unknown }).createObjectURL
    }
  })
})
