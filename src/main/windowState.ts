/**
 * 应用状态持久化的纯数据模块：窗口尺寸/位置记忆 + 文件对话框上次目录记忆。
 * 不依赖 electron 与 fs（磁盘读写由主进程调用方完成），校验逻辑可被 vitest 直接测试。
 */

/** 矩形区域（窗口 bounds 与屏幕工作区共用结构，字段与 Electron Rectangle 一致） */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 持久化的应用状态 */
export interface AppState {
  /** 上次关闭时的窗口 bounds */
  bounds?: Rect
  /** 上次成功打开文件所在目录（file:open 对话框 defaultPath） */
  lastDir?: string
  /** 上次成功导出报告所在目录（file:save-report 对话框 defaultPath；与 lastDir 语义不同分开记忆） */
  lastReportDir?: string
}

/** 最小窗口尺寸（与 BrowserWindow 的 minWidth/minHeight 保持一致，改动需双向同步） */
export const MIN_WIDTH = 900
export const MIN_HEIGHT = 600

function isRect(v: unknown): v is Rect {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.x === 'number' &&
    Number.isFinite(r.x) &&
    typeof r.y === 'number' &&
    Number.isFinite(r.y) &&
    typeof r.width === 'number' &&
    Number.isFinite(r.width) &&
    typeof r.height === 'number' &&
    Number.isFinite(r.height)
  )
}

/**
 * 解析持久化文本为状态对象：JSON 非法 / 字段类型异常一律回退空状态，
 * 保证损坏数据不影响启动。
 */
export function parseState(raw: string | null | undefined): AppState {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as AppState
    const state: AppState = {}
    if (isRect(obj.bounds)) state.bounds = obj.bounds
    if (typeof obj.lastDir === 'string' && obj.lastDir !== '') state.lastDir = obj.lastDir
    if (typeof obj.lastReportDir === 'string' && obj.lastReportDir !== '') {
      state.lastReportDir = obj.lastReportDir
    }
    return state
  } catch {
    return {}
  }
}

/**
 * 把窗口 bounds 钳制到屏幕工作区：
 * - 尺寸不小于最小值、不超过工作区大小（工作区小于最小值时以最小值为准）；
 * - 位置保证窗口至少 60px 落在工作区内（分辨率/显示器变更后不出现“看不见的窗口”）；
 * - 结果取整（BrowserWindow 接受整数坐标）。
 */
export function clampBounds(b: Rect, workArea: Rect): Rect {
  const width = Math.min(Math.max(b.width, MIN_WIDTH), Math.max(workArea.width, MIN_WIDTH))
  const height = Math.min(Math.max(b.height, MIN_HEIGHT), Math.max(workArea.height, MIN_HEIGHT))
  const x = Math.min(Math.max(b.x, workArea.x - width + 60), workArea.x + workArea.width - 60)
  const y = Math.min(Math.max(b.y, workArea.y - height + 60), workArea.y + workArea.height - 60)
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}
