import { app, clipboard, ipcMain } from 'electron'

export function registerAppIpc(): void {
  /** IPC: 应用版本号（package.json 的 version 为唯一来源，dev 与打包行为一致） */
  ipcMain.handle('app:get-version', () => app.getVersion())

  /** IPC: 复制文本到剪贴板 */
  ipcMain.handle('clipboard:write', (_event, text: string) => {
    clipboard.writeText(text)
    return true
  })
}
