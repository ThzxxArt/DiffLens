import DiffWorker from './diffWorker?worker&inline'

export type DiffWorkerFactory = () => Worker | null

/**
 * 创建 diff 计算 worker。
 * 采用 Vite 内联打包（base64 blob），兼容生产环境 file:// 加载（index.html 的 CSP 已放行 worker-src blob:）。
 * 环境不支持 Worker（如 jsdom 测试环境）或实例化失败时返回 null，由调用方回退主线程同步计算。
 */
export const createDiffWorker: DiffWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null
  try {
    return new DiffWorker()
  } catch {
    return null
  }
}
