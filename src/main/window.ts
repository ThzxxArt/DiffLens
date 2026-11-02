import { join } from 'path'
import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { clampBounds } from './windowState'
import { getAppState, saveStateSync } from './appState'

export function createWindow(): void {
  // 恢复上次窗口尺寸/位置：越界 bounds 钳制回当前屏幕工作区，无记录时用默认尺寸
  const wa = screen.getPrimaryDisplay().workArea
  const state = getAppState()
  const bounds = state.bounds ? clampBounds(state.bounds, wa) : null
  // 主窗口
  const mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    title: 'DiffLens',
    icon: join(__dirname, '../../resources/icon.png'),
    backgroundColor: '#0a0e17',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 关闭时记忆窗口普通状态 bounds：最大化/全屏时 getNormalBounds 仍返回普通状态的
  // 尺寸位置（本次会话调整过的窗口位置不因最大化关闭而丢失）；最小化时不记录
  mainWindow.on('close', () => {
    if (mainWindow.isMinimized()) return
    const b = mainWindow.getNormalBounds()
    state.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    saveStateSync()
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 窗口内导航白名单：仅放行回到当前应用地址（dev 首页 / 打包产物首页，等价于刷新），
  // 阻断其余一切页面内跳转（新窗口已在上方拦截，此处补齐页面内导航防线）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) e.preventDefault()
  })

  // 开发模式加载 dev server，生产加载打包后的 html
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
