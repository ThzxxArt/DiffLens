import { app, BrowserWindow, Menu, nativeTheme } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { loadState, setAppState } from './appState'
import { registerIpcHandlers } from './ipc'
import { createWindow } from './window'

/**
 * 单实例锁：窗口状态、偏好、扫描缓存与快照保存都依赖同一 userData，
 * 多实例并发会互相覆盖。第二个实例只负责唤起并聚焦已有窗口。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.thzxxart.difflens')

    // 强制暗色系统主题：Windows 标题栏/滚动条等系统控件跟随应用暗色科幻风格
    nativeTheme.themeSource = 'dark'

    // 读取持久化应用状态（窗口 bounds + 上次文件目录；损坏数据回退空状态）
    setAppState(loadState())

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // 隐藏窗口自带的应用菜单栏（功能入口由界面按钮提供）
    Menu.setApplicationMenu(null)
    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
