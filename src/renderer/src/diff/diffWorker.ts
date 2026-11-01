import { computeDiff } from './diffEngine'
import type { DiffOptions, DiffResult } from './diffEngine'

/** worker 请求：jobId 用于匹配响应与丢弃过期任务（输入已变化时的旧计算结果） */
export interface DiffWorkerRequest {
  jobId: number
  leftText: string
  rightText: string
  options: DiffOptions
}

/** worker 响应：携带对应请求的 jobId */
export interface DiffWorkerResponse {
  jobId: number
  result: DiffResult
}

// worker 全局对象与页面 DOM 类型环境互斥，用结构化声明规避 lib 冲突
const ctx = self as unknown as {
  addEventListener(type: 'message', cb: (e: MessageEvent<DiffWorkerRequest>) => void): void
  postMessage(msg: DiffWorkerResponse): void
}

ctx.addEventListener('message', (e) => {
  const { jobId, leftText, rightText, options } = e.data
  ctx.postMessage({ jobId, result: computeDiff(leftText, rightText, options) })
})
