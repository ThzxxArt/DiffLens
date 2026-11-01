import { useEffect, useMemo, useRef, useState } from 'react'
import {
  computeDiff,
  CHAR_HEAVY_INPUT_CHARS,
  type DiffOptions,
  type DiffResult
} from '../diff/diffEngine'
import { createDiffWorker, type DiffWorkerFactory } from '../diff/createDiffWorker'
import type { DiffWorkerResponse } from '../diff/diffWorker'
import { countLines } from '../diff/textUtils'

/** 快路径行数上限：两侧总行数不超过该值时在渲染线程同步计算（毫秒级，避免选项开关切换时闪烁加载态） */
const FAST_PATH_MAX_LINES = 2000
/** 重输入去抖：合并连续的选项/内容变更，超时后才派发 worker 计算（去抖期内取消 = 零浪费计算） */
const DEBOUNCE_MS = 200

export interface DiffState {
  /** 差异结果；重输入计算期间为 null（配 computing 展示加载态） */
  diff: DiffResult | null
  /** 是否正在后台计算（仅重路径会出现 true） */
  computing: boolean
}

/**
 * worker 化的 diff 计算 hook。
 * 小输入同步快路径（行为与 worker 化之前完全一致）；
 * 大输入去抖到期后才创建 worker 并派发后台计算（去抖期内取消的任务零创建开销），
 * 输入变化时终止旧 worker 重建（JS worker 无法中断计算，销毁重建即取消），
 * 响应按 jobId 匹配丢弃过期任务；worker 不可用的环境回退主线程同步计算。
 * workerFactory 仅测试注入用，生产调用保持缺省；注入时需保证引用稳定。
 */
export function useDiff(
  left: string,
  right: string,
  options: DiffOptions,
  workerFactory?: DiffWorkerFactory
): DiffState {
  const heavy = useMemo(
    () =>
      countLines(left) + countLines(right) > FAST_PATH_MAX_LINES ||
      // 字符级对比的耗时由字符量×编辑距离决定：少行大字符量输入（压缩 JSON / base64 单行）
      // 行数维度防不住，需按字符量兜底走 worker 后台计算
      (options.charMode === true && left.length + right.length > CHAR_HEAVY_INPUT_CHARS),
    [left, right, options]
  )
  const factory = workerFactory ?? createDiffWorker

  // 最近一次计算成功的结果与其输入文本：重路径计算期间用它撑住虚拟滚动容器高度
  // （快路径结果与 worker 结果都写入；文本一致时作为重路径的兜底展示）
  const lastResultRef = useRef<{ left: string; right: string; result: DiffResult } | null>(null)

  // 快路径：同步计算，渲染当帧即得结果（并记录到 lastResultRef）
  const fastDiff = useMemo(() => {
    if (!heavy) {
      const r = computeDiff(left, right, options)
      lastResultRef.current = { left, right, result: r }
      return r
    }
    return null
  }, [left, right, options, heavy])

  const [asyncDiff, setAsyncDiff] = useState<DiffResult | null>(null)
  const [computing, setComputing] = useState(false)
  const jobIdRef = useRef(0)
  // 上一次重路径派发时的输入文本：区分「文本变化」与「仅选项变化」（见 effect 内说明）
  const lastInputsRef = useRef<{ left: string; right: string } | null>(null)

  useEffect(() => {
    if (!heavy) return
    // 重路径计算期间保留旧结果撑住虚拟滚动容器高度：items 清空会使容器高度塌陷为 0，
    // 浏览器把 scrollTop 钳制归 0（计算完成后也不恢复）——切换选项/开启字符级触发重算时
    // 视图回弹到顶部（0.6.2 及之前版本的实际缺陷，用户实测“开字符级后向下滚动回弹”）。
    // 旧结果来源：worker 完成的 asyncDiff 与快路径结果（首算时 asyncDiff 尚为 null）。
    // 文本变化（打开新文件/交换左右）不兜底：避免展示与新面板不对应的过期差异，
    // 此时滚动位置随内容重建归位属预期行为。
    const textChanged =
      lastInputsRef.current !== null &&
      (lastInputsRef.current.left !== left || lastInputsRef.current.right !== right)
    if (textChanged) setAsyncDiff(null)
    lastInputsRef.current = { left, right }
    setComputing(true)
    // effect 世代标志：cleanup 后置位，迟到回调（含去抖期内输入已变、jobId 尚未推进的窗口）一律丢弃
    let cancelled = false
    let w: Worker | null = null
    // worker 延迟到去抖到期才创建：内联 worker 实例化含 base64 解码与脚本编译，
    // 去抖期内输入再变时旧任务未创建即取消，零创建与计算开销
    const timer = window.setTimeout(() => {
      w = factory()
      if (!w) {
        // 无 Worker 支持（jsdom/老环境）：主线程同步回退
        setAsyncDiff(computeDiff(left, right, options))
        setComputing(false)
        return
      }
      const jobId = ++jobIdRef.current
      w.onmessage = (e: MessageEvent<DiffWorkerResponse>): void => {
        // 丢弃过期任务：输入已变化时旧计算结果不再生效
        if (e.data.jobId !== jobId || cancelled) return
        lastResultRef.current = { left, right, result: e.data.result }
        setAsyncDiff(e.data.result)
        setComputing(false)
      }
      // worker 运行中崩溃（未捕获异常/极端输入）：终止实例后回退主线程同步计算，
      // 避免 computing 永久卡死；迟到错误（effect 已取消或 jobId 已推进）只终止不回填
      w.onerror = (): void => {
        w?.terminate()
        if (cancelled || jobIdRef.current !== jobId) return
        setAsyncDiff(computeDiff(left, right, options))
        setComputing(false)
      }
      w.postMessage({ jobId, leftText: left, rightText: right, options })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      w?.terminate()
    }
  }, [left, right, options, heavy, factory])

  // 重路径输出：优先 worker 结果；计算中且文本未变时用最近一次结果兜底（撑住容器高度，
  // 防 scrollTop 塌陷回弹；文本已变化时不兜底，避免过期差异误导）
  if (heavy) {
    if (asyncDiff !== null) return { diff: asyncDiff, computing }
    const last = lastResultRef.current
    const fallback =
      last !== null && last.left === left && last.right === right ? last.result : null
    return { diff: fallback, computing }
  }
  return { diff: fastDiff, computing: false }
}
