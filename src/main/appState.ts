import { app } from 'electron'
import fs from 'fs'
import { join } from 'path'
import { parseState, type AppState } from './windowState'

/** 应用状态持久化文件（窗口 bounds + 上次文件目录），位于 userData 目录 */
const stateFile = (): string => join(app.getPath('userData'), 'window-state.json')

let appState: AppState = {}

export function getAppState(): AppState {
  return appState
}

export function setAppState(next: AppState): void {
  appState = next
}

/** 读取持久化状态：文件不存在/损坏一律回退空状态，不影响启动 */
export function loadState(): AppState {
  try {
    return parseState(fs.readFileSync(stateFile(), 'utf-8'))
  } catch {
    return {}
  }
}

/** 序列化当前应用状态（同步/异步写盘共用） */
function serializeState(): string {
  return JSON.stringify(appState)
}

/** 写回持久化状态（close 事件专用：同步写保证 app 退出前落盘完成） */
export function saveStateSync(): void {
  try {
    fs.writeFileSync(stateFile(), serializeState(), 'utf-8')
  } catch {
    // 忽略写入失败
  }
}

/** 写回持久化状态（IPC handler 内专用：异步写盘不阻塞事件循环，失败静默忽略——
 *  目录只读/磁盘满等偏好记忆失效但不影响本次会话；appState 内存态始终最新） */
export function saveStateAsync(): void {
  try {
    void fs.promises.writeFile(stateFile(), serializeState(), 'utf-8').catch(() => {})
  } catch {
    // 序列化失败等：忽略
  }
}
