import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDiff } from './useDiff'
import {
  computeDiff,
  CHAR_HEAVY_INPUT_CHARS,
  type DiffResult,
  type DiffOptions
} from '../diff/diffEngine'
import type { DiffWorkerFactory } from '../diff/createDiffWorker'

/** 模拟 Worker：记录派发请求，可手动回传结果或触发崩溃；terminated 后丢弃回传（对齐真实 worker 终止后不再触发事件） */
class FakeWorker {
  onmessage: ((e: { data: { jobId: number; result: DiffResult } }) => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  posted: { jobId: number }[] = []
  postMessage(data: { jobId: number }): void {
    this.posted.push(data)
  }
  terminate(): void {
    this.terminated = true
  }
  respond(jobId: number, result: DiffResult): void {
    if (this.terminated) return
    this.onmessage?.({ data: { jobId, result } })
  }
  /** 模拟运行中崩溃：触发 onerror（终止后不再触发，对齐真实 worker） */
  fail(): void {
    if (this.terminated) return
    this.onerror?.()
  }
}

/** 每次调用产出新 FakeWorker 的工厂，并记录全部实例 */
function makeFactory(): DiffWorkerFactory & { workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const f = (() => {
    const w = new FakeWorker()
    workers.push(w)
    return w as unknown as Worker
  }) as DiffWorkerFactory & { workers: FakeWorker[] }
  f.workers = workers
  return f
}

function heavyText(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `L${i}`).join('\n')
}

// 注意：renderHook 回调内联对象（如 {}）会在每次渲染生成新引用并触发 effect 双跑，
// 测试中必须将 left/right/options 提升为稳定引用（生产中 options 为 state，天然稳定）
const NO_OPTIONS: DiffOptions = {}
const CHAR_ON: DiffOptions = { charMode: true }
const CHAR_OFF: DiffOptions = { charMode: false }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDiff - 快路径', () => {
  it('小输入同步计算，不创建 worker', () => {
    const factory = vi.fn(makeFactory())
    const { result } = renderHook(() => useDiff('a\nb', 'a\nc', NO_OPTIONS, factory))
    expect(result.current.diff).not.toBeNull()
    expect(result.current.diff!.summary.changedLines).toBe(1)
    expect(result.current.computing).toBe(false)
    expect(factory).not.toHaveBeenCalled()
  })

  it('结果与直接调用 computeDiff 一致', () => {
    const { result } = renderHook(() => useDiff('x', 'y', { ignoreCase: true }))
    expect(result.current.diff).toEqual(computeDiff('x', 'y', { ignoreCase: true }))
  })
})

describe('useDiff - 字符级大字符量重路径', () => {
  it('少行大字符量输入（charMode 开启）进入重路径后台计算', () => {
    const factory = makeFactory()
    // 2 行 × 约 3 万字符 ≈ 6 万字符：行数远低于快路径阈值，但字符量超过 CHAR_HEAVY_INPUT_CHARS（5000）
    const big = 'a'.repeat(30000) + '\n' + 'b'.repeat(30000)
    const { result } = renderHook(() => useDiff(big, big, CHAR_ON, factory))
    expect(result.current.computing).toBe(true)
    expect(result.current.diff).toBeNull()
    // 去抖期内尚未创建 worker
    expect(factory.workers).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(factory.workers).toHaveLength(1)
    const w = factory.workers[0]
    const res = computeDiff(big, big, CHAR_ON)
    act(() => {
      w.respond(w.posted[0].jobId, res)
    })
    expect(result.current.diff).toEqual(res)
    expect(result.current.computing).toBe(false)
  })

  it('charMode 开启但字符量未超阈值仍走快路径', () => {
    const factory = vi.fn(makeFactory())
    const { result } = renderHook(() => useDiff('ab\ncd', 'ab\ncd', CHAR_ON, factory))
    expect(result.current.computing).toBe(false)
    expect(result.current.diff).not.toBeNull()
    expect(result.current.diff!.summary.changedLines).toBe(0)
    expect(factory).not.toHaveBeenCalled()
  })

  it('charMode 关闭时大字符量输入不触发重路径（行数维度判定不变）', () => {
    const factory = vi.fn(makeFactory())
    const big = 'a'.repeat(60000)
    const { result } = renderHook(() => useDiff(big, big, CHAR_OFF, factory))
    expect(result.current.computing).toBe(false)
    expect(result.current.diff).not.toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it('恰好阈值不触发重路径，超过阈值触发', () => {
    const factory = makeFactory()
    // 两侧各 CHAR_HEAVY_INPUT_CHARS / 2 = 恰好 5000：不触发
    const at = 'a'.repeat(CHAR_HEAVY_INPUT_CHARS / 2)
    const hook1 = renderHook(() => useDiff(at, at, CHAR_ON, factory))
    expect(hook1.result.current.computing).toBe(false)
    // 一侧超出 1 字符（5001 + 5000）：触发
    const over = 'a'.repeat(CHAR_HEAVY_INPUT_CHARS / 2 + 1)
    const hook2 = renderHook(() => useDiff(over, at, CHAR_ON, factory))
    expect(hook2.result.current.computing).toBe(true)
  })

  it('快路径后开启字符级进入重路径：首算期间用快路径结果兜底（容器高度不塌陷）', () => {
    const factory = makeFactory()
    // 先以快路径（charMode 关）完成一次计算：结果被记录
    const left = 'x'.repeat(4000) + '\nmore'
    const right = 'x'.repeat(4000) + '\ntext'
    const hook = renderHook(
      ({ options }: { options: DiffOptions }) => useDiff(left, right, options, factory),
      { initialProps: { options: { charMode: false } } }
    )
    expect(hook.result.current.computing).toBe(false)
    const fast = hook.result.current.diff
    expect(fast).not.toBeNull()
    // 开字符级（字符量 > 5000 触发重路径）：首算期间 asyncDiff 为 null，
    // 但文本未变 → 快路径结果兜底展示（滚动容器高度稳定，不回弹到顶）
    hook.rerender({ options: { charMode: true } })
    expect(hook.result.current.computing).toBe(true)
    expect(hook.result.current.diff).toEqual(fast)
    // worker 完成后替换为字符级结果
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w = factory.workers[0]
    const res = computeDiff(left, right, { charMode: true })
    act(() => {
      w.respond(w.posted[0].jobId, res)
    })
    expect(hook.result.current.diff).toEqual(res)
    expect(hook.result.current.computing).toBe(false)
  })
})

describe('useDiff - worker 后台计算', () => {
  it('重输入先进入 computing，去抖到期才创建 worker 并派发，回传后更新', () => {
    const factory = makeFactory()
    const left = heavyText(1100)
    const right = heavyText(1100)
    const { result } = renderHook(() => useDiff(left, right, NO_OPTIONS, factory))
    expect(result.current.computing).toBe(true)
    expect(result.current.diff).toBeNull()
    // 去抖期内尚未创建 worker（零创建开销）
    expect(factory.workers).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w = factory.workers[0]
    expect(w.posted).toHaveLength(1)
    const jobId = w.posted[0].jobId
    // 错误 jobId 的响应被丢弃
    act(() => {
      w.respond(999, computeDiff('a', 'a', {}))
    })
    expect(result.current.diff).toBeNull()
    const res = computeDiff('p', 'q', {})
    act(() => {
      w.respond(jobId, res)
    })
    expect(result.current.diff).toEqual(res)
    expect(result.current.computing).toBe(false)
  })

  it('输入变化后旧 worker 被终止且迟到响应被丢弃', () => {
    const factory = makeFactory()
    const left = heavyText(1100)
    const right = heavyText(1100)
    const hook = renderHook(
      ({ options }: { options: DiffOptions }) => useDiff(left, right, options, factory),
      { initialProps: { options: { ignoreCase: false } } }
    )
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w1 = factory.workers[0]
    const jobId1 = w1.posted[0].jobId
    // 变更选项 → 新任务
    hook.rerender({ options: { ignoreCase: true } })
    expect(w1.terminated).toBe(true)
    expect(hook.result.current.computing).toBe(true)
    expect(hook.result.current.diff).toBeNull()
    // 旧 worker 的迟到响应被丢弃
    act(() => {
      w1.respond(jobId1, computeDiff('a', 'a', {}))
    })
    expect(hook.result.current.diff).toBeNull()
    // 新 worker 的结果生效（新任务同样在去抖到期才创建 worker）
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w2 = factory.workers[1]
    const jobId2 = w2.posted[0].jobId
    expect(jobId2).toBeGreaterThan(jobId1)
    const res2 = computeDiff('m', 'n', {})
    act(() => {
      w2.respond(jobId2, res2)
    })
    expect(hook.result.current.diff).toEqual(res2)
    expect(hook.result.current.computing).toBe(false)
  })

  it('去抖期内输入变更：旧任务未创建即取消（零创建与计算开销）', () => {
    const factory = makeFactory()
    const hook = renderHook((p: string) => useDiff(p, '', NO_OPTIONS, factory), {
      initialProps: heavyText(2100)
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    hook.rerender(heavyText(2300))
    // 去抖期内取消：worker 从未被创建
    expect(factory.workers).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(factory.workers).toHaveLength(1)
    expect(factory.workers[0].posted).toHaveLength(1)
  })

  it('worker 不可用时去抖到期回退主线程同步计算', () => {
    const left = heavyText(2100)
    // 工厂必须稳定引用：内联箭头函数每次渲染变引用会引发 effect 无限重跑
    const nullFactory: DiffWorkerFactory = () => null
    const { result } = renderHook(() => useDiff(left, 'x', NO_OPTIONS, nullFactory))
    // 去抖期内同样处于 computing（无 Worker 回退不豁免去抖）
    expect(result.current.computing).toBe(true)
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(result.current.diff).toEqual(computeDiff(left, 'x', {}))
    expect(result.current.computing).toBe(false)
  })

  it('去抖期内卸载：worker 从未创建且不再派发', () => {
    const factory = makeFactory()
    const left = heavyText(2100)
    const hook = renderHook(() => useDiff(left, '', NO_OPTIONS, factory))
    hook.unmount()
    expect(factory.workers).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(factory.workers).toHaveLength(0)
  })

  it('去抖到期派发后卸载：worker 被终止', () => {
    const factory = makeFactory()
    const left = heavyText(2100)
    const hook = renderHook(() => useDiff(left, '', NO_OPTIONS, factory))
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w = factory.workers[0]
    expect(w.posted).toHaveLength(1)
    hook.unmount()
    expect(w.terminated).toBe(true)
  })

  it('worker 运行中崩溃：终止实例并回退主线程同步计算', () => {
    const factory = makeFactory()
    const left = heavyText(2100)
    const { result } = renderHook(() => useDiff(left, 'x', NO_OPTIONS, factory))
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w = factory.workers[0]
    expect(result.current.computing).toBe(true)
    act(() => {
      w.fail()
    })
    expect(w.terminated).toBe(true)
    expect(result.current.diff).toEqual(computeDiff(left, 'x', {}))
    expect(result.current.computing).toBe(false)
  })

  it('迟到错误（输入已变化）只终止不回填，新任务结果正常生效', async () => {
    const factory = makeFactory()
    const hook = renderHook((p: string) => useDiff(p, 'x', NO_OPTIONS, factory), {
      initialProps: heavyText(2100)
    })
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w1 = factory.workers[0]
    hook.rerender(heavyText(2300))
    // 模拟 terminate 前已排入事件队列的迟到 error（绕过 terminated 守卫直接触发）
    act(() => {
      w1.onerror?.()
    })
    // 过期错误不回填：仍处于 computing 且无结果
    expect(hook.result.current.diff).toBeNull()
    expect(hook.result.current.computing).toBe(true)
    // 新任务正常完成
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w2 = factory.workers[1]
    const res = computeDiff('m', 'n', {})
    act(() => {
      w2.respond(w2.posted[0].jobId, res)
    })
    expect(hook.result.current.diff).toEqual(res)
    expect(hook.result.current.computing).toBe(false)
  })

  it('仅选项变化时保留旧结果撑住容器高度（防滚动塌陷回弹），新结果到达后替换', () => {
    const factory = makeFactory()
    const left = heavyText(2100)
    const right = heavyText(2100)
    const hook = renderHook(
      ({ options }: { options: DiffOptions }) => useDiff(left, right, options, factory),
      { initialProps: { options: { ignoreCase: false } } }
    )
    // 首次计算完成（首算无旧结果，computing 期间 diff 为 null）
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w1 = factory.workers[0]
    const res1 = computeDiff('a', 'b', {})
    act(() => {
      w1.respond(w1.posted[0].jobId, res1)
    })
    expect(hook.result.current.diff).toEqual(res1)
    expect(hook.result.current.computing).toBe(false)
    // 仅切换选项（文本不变）：旧结果保留（虚拟滚动容器高度不塌陷）+ computing 开始
    hook.rerender({ options: { ignoreCase: true } })
    expect(hook.result.current.computing).toBe(true)
    expect(hook.result.current.diff).toEqual(res1)
    // 新结果到达后替换
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w2 = factory.workers[1]
    const res2 = computeDiff('p', 'q', { ignoreCase: true })
    act(() => {
      w2.respond(w2.posted[0].jobId, res2)
    })
    expect(hook.result.current.diff).toEqual(res2)
    expect(hook.result.current.computing).toBe(false)
  })

  it('文本变化时清空旧结果（防止展示与新面板不对应的过期差异）', () => {
    const factory = makeFactory()
    const hook = renderHook(
      (p: string) => useDiff(p, 'x', NO_OPTIONS, factory),
      { initialProps: heavyText(2100) }
    )
    act(() => {
      vi.advanceTimersByTime(250)
    })
    const w1 = factory.workers[0]
    const res1 = computeDiff('a', 'b', {})
    act(() => {
      w1.respond(w1.posted[0].jobId, res1)
    })
    expect(hook.result.current.diff).toEqual(res1)
    // 文本变化：旧结果立即清空
    hook.rerender(heavyText(2300))
    expect(hook.result.current.diff).toBeNull()
    expect(hook.result.current.computing).toBe(true)
  })
})
