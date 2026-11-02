import { registerAppIpc } from './appIpc'
import { registerFileIpc } from './fileIpc'
import { registerFolderIpc } from './folderIpc'

/** 注册全部 IPC handler（在 app ready 后、创建窗口前调用） */
export function registerIpcHandlers(): void {
  registerAppIpc()
  registerFileIpc()
  registerFolderIpc()
}
