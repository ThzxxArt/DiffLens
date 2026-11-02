import { join, dirname, sep } from 'path'
import {
  app,
  shell,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  clipboard,
  nativeTheme,
  screen
} from 'electron'
import { Worker } from 'worker_threads'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import fs from 'fs'
import { parseState, clampBounds, type AppState } from './windowState'
import { decodeText, type DecodeResult } from './decode'
import {
  scanFolders,
  SEMANTIC_MAX_BYTES,
  SCAN_CONCURRENCY,
  type ScanCacheEntry
} from './folderScan'
import { resolveScanArgs } from './scanIpc'
import {
  parseScanCacheStore,
  putScanCache,
  getScanCache,
  emptyScanCacheStore,
  type ScanCacheStoreData
} from './scanCacheStore'
import { TEXT_EXTENSIONS } from '../shared/textExtensions'

/**
 * 相对路径是否为文本文件（按扩展名，语义判等文本判定共用）：
 * 扩展名清单来自 src/shared/textExtensions（与渲染端拖拽入口共用同一源文件）；
 * 无扩展名的文件按文本放行（与渲染端 isTextFile 口径一致）。
 */
function isTextRel(rel: string): boolean {
  const dot = rel.lastIndexOf('.')
  if (dot < 0) return true
  return TEXT_EXTENSIONS.includes(rel.slice(dot + 1).toLowerCase())
}

/** 应用状态持久化文件（窗口 bounds + 上次文件目录），位于 userData 目录 */
const stateFile = (): string => join(app.getPath('userData'), 'window-state.json')

/** 文件夹扫描增量缓存的跨会话持久化文件，位于 userData 目录 */
const scanCacheFile = (): string => join(app.getPath('userData'), 'scan-cache.json')

/** 读取持久化扫描缓存存储：文件不存在/损坏回退空存储，不影响扫描。
 *  异步读盘（渲染端未携带内存缓存时在 folder:scan handler 内惰性触发）——
 *  缓存文件可达 MB 级（LRU 8 对 × 万级条目），同步读会阻塞主进程事件循环 */
async function loadScanCacheStore(): Promise<ScanCacheStoreData> {
  try {
    return parseScanCacheStore(await fs.promises.readFile(scanCacheFile(), 'utf-8'))
  } catch {
    return emptyScanCacheStore()
  }
}

/**
 * 落盘扫描缓存（读-改-写，异步 fire-and-forget）：
 * 失败静默（目录只读/磁盘满等，跨会话增量记忆失效不影响本次结果）。
 * 写操作经内存 promise 链串行执行（每次追加到链尾）：两次扫描近乎同时
 * 完成时各自的读-改-写按序落盘，避免后写整体覆盖先写丢失 LRU 目录对。
 */
let scanCacheWrites: Promise<void> = Promise.resolve()

function persistScanCache(leftDir: string, rightDir: string, cache: ScanCacheEntry[]): void {
  scanCacheWrites = scanCacheWrites.then(() => writeScanCache(leftDir, rightDir, cache))
}

async function writeScanCache(
  leftDir: string,
  rightDir: string,
  cache: ScanCacheEntry[]
): Promise<void> {
  try {
    const next = putScanCache(await loadScanCacheStore(), leftDir, rightDir, cache, Date.now())
    await fs.promises.writeFile(scanCacheFile(), JSON.stringify(next), 'utf-8')
  } catch {
    // 忽略写入失败
  }
}

/** 当前生效的应用状态（启动时从磁盘读取，运行中增量更新） */
let appState: AppState = {}

/** 读取持久化状态：文件不存在/损坏一律回退空状态，不影响启动 */
function loadState(): AppState {
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
function saveStateSync(): void {
  try {
    fs.writeFileSync(stateFile(), serializeState(), 'utf-8')
  } catch {
    // 忽略写入失败
  }
}

/** 写回持久化状态（IPC handler 内专用：异步写盘不阻塞事件循环，失败静默忽略——
 *  目录只读/磁盘满等偏好记忆失效但不影响本次会话；appState 内存态始终最新） */
function saveStateAsync(): void {
  try {
    void fs.promises.writeFile(stateFile(), serializeState(), 'utf-8').catch(() => {})
  } catch {
    // 序列化失败等：忽略
  }
}

function createWindow(): void {
  // 恢复上次窗口尺寸/位置：越界 bounds 钳制回当前屏幕工作区，无记录时用默认尺寸
  const wa = screen.getPrimaryDisplay().workArea
  const bounds = appState.bounds ? clampBounds(appState.bounds, wa) : null
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
    appState.bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
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

/** 单侧文件大小上限（10MB）：超限直接拦截，避免超大文件卡死界面 */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 解码快路径阈值（256KB）：小缓冲同步解码（毫秒级），大缓冲派发 worker 后台解码 */
const DECODE_FAST_PATH_BYTES = 256 * 1024

/**
 * 解码 worker（worker_threads）单例管理。
 * 大文件解码（GBK 纯 JS 解码可达数百毫秒）移入后台线程，避免阻塞主进程事件循环；
 * 崩溃时拒绝在途任务并销毁实例（下次请求重建），调用方回退主进程同步解码。
 */
let decodeWorker: Worker | null = null
let decodeJobSeq = 0
const pendingDecode = new Map<
  number,
  { resolve: (r: DecodeResult) => void; reject: (e: Error) => void }
>()

/** 解码 worker 脚本路径：打包后位于 asar.unpacked（Electron 的 asar 补丁不覆盖 worker 线程） */
function decodeWorkerPath(): string {
  const p = join(__dirname, 'decodeWorker.js')
  return p.includes(`app.asar${sep}`) ? p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`) : p
}

function getDecodeWorker(): Worker {
  if (decodeWorker) return decodeWorker
  const w = new Worker(decodeWorkerPath())
  w.on('message', (msg: { jobId: number; result: DecodeResult }) => {
    pendingDecode.get(msg.jobId)?.resolve(msg.result)
    pendingDecode.delete(msg.jobId)
  })
  w.on('error', (err: Error) => {
    for (const { reject } of pendingDecode.values()) reject(err)
    pendingDecode.clear()
    const dead = decodeWorker
    decodeWorker = null
    dead?.terminate().catch(() => {})
  })
  // 意外退出兜底：拒绝全部在途任务（error 分支已处理时此处为 no-op），下次请求重建
  w.on('exit', () => {
    for (const { reject } of pendingDecode.values()) reject(new Error('decode worker exited'))
    pendingDecode.clear()
    if (decodeWorker === w) decodeWorker = null
  })
  decodeWorker = w
  return w
}

/** 大缓冲派发 worker 解码；worker 创建/运行失败时回退主进程同步解码（行为不降级） */
async function decodeMaybeWorker(buf: Buffer): Promise<DecodeResult> {
  if (buf.length < DECODE_FAST_PATH_BYTES) return decodeText(buf)
  const jobId = ++decodeJobSeq
  return new Promise<DecodeResult>((resolve, reject) => {
    let w: Worker
    try {
      w = getDecodeWorker()
    } catch (e) {
      reject(e instanceof Error ? e : new Error('decode worker unavailable'))
      return
    }
    pendingDecode.set(jobId, { resolve, reject })
    w.postMessage({ jobId, buffer: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) })
  }).catch(() => decodeText(buf))
}

/** 按路径读取并解码文本文件（file:open 与 file:read-by-path 共用；10MB 上限） */
async function readTextFile(
  filePath: string
): Promise<
  | { path: string; name: string; text: string; encoding: string; binary: boolean }
  | { error: 'too-large' | 'read-failed'; name: string; size?: number }
> {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  let buf: Buffer
  try {
    const st = await fs.promises.stat(filePath)
    if (st.size > MAX_FILE_SIZE) {
      return { error: 'too-large', name, size: st.size }
    }
    buf = await fs.promises.readFile(filePath)
  } catch {
    return { error: 'read-failed', name }
  }
  const { text, encoding, binary } = await decodeMaybeWorker(buf)
  return { path: filePath, name, text, encoding, binary }
}

/** IPC: 打开文件对话框并读取内容 */
ipcMain.handle('file:open', async (_event, side: 'left' | 'right' | null) => {
  const result = await dialog.showOpenDialog({
    title: `选择${side === 'left' ? '左侧' : side === 'right' ? '右侧' : ''}文本文件`,
    // 记忆上次成功打开文件所在目录；无记录时传 undefined 走系统默认（最近使用位置）
    defaultPath: appState.lastDir,
    properties: ['openFile'],
    filters: [
      { name: '文本文件', extensions: TEXT_EXTENSIONS },
      // 兜底入口：允许打开任意扩展名文件
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  // 记录所在目录供下次对话框起始定位（与窗口 bounds 同存一个状态文件）
  appState.lastDir = dirname(filePath)
  saveStateAsync()
  return readTextFile(filePath)
})

/** IPC: 解码拖拽传入的原始字节（复用编码探测逻辑，大缓冲走 worker） */
ipcMain.handle('file:decode-buffer', async (_event, buffer: ArrayBuffer) => {
  return decodeMaybeWorker(Buffer.from(buffer))
})

/** IPC: 保存差异报告（系统保存对话框 + 写入内容）。
 *  对话框起始目录记忆上次成功导出位置（频繁导出无需每次重新导航；
 *  与 file:open 的 lastDir 语义不同，独立字段分开记忆） */
ipcMain.handle('file:save-report', async (_event, content: string, defaultName: string) => {
  const ext = defaultName.split('.').pop() ?? 'txt'
  const result = await dialog.showSaveDialog({
    title: '保存差异报告',
    defaultPath: join(appState.lastReportDir ?? app.getPath('documents'), defaultName),
    filters: [
      { name: '差异报告', extensions: [ext] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return { ok: false, path: null }
  // 异步写盘，避免大报告（MB 级 HTML）同步写入时阻塞主进程事件循环
  await fs.promises.writeFile(result.filePath, content, 'utf-8')
  appState.lastReportDir = dirname(result.filePath)
  saveStateAsync()
  return { ok: true, path: result.filePath }
})

/** IPC: 打开系统文件管理器定位文件 */
ipcMain.handle('file:show-in-folder', (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
  return true
})

/** IPC: 复制文本到剪贴板 */
ipcMain.handle('clipboard:write', (_event, text: string) => {
  clipboard.writeText(text)
  return true
})

/** IPC: 选择文件夹（文件夹对比入口；记忆上次目录） */
ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择要对比的文件夹',
    defaultPath: appState.lastDir,
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const dirPath = result.filePaths[0]
  appState.lastDir = dirPath
  saveStateAsync()
  return dirPath
})

/**
 * IPC: 扫描对比两个文件夹（递归对齐 + 字节级判定 + 可选语义判等 + 忽略规则 + 增量缓存跨会话持久化；异步 fs 与解码 worker 不阻塞主进程）。
 * scanId（渲染端扫描会话序号）原样携带在进度事件中：渲染端只显示最新会话的进度，
 * 旧扫描迟到的进度事件天然被丢弃（与渲染端结果竞态守卫同一套序号，不引入新竞态面）。
 */
ipcMain.handle(
  'folder:scan',
  async (
    event,
    leftDir: string,
    rightDir: string,
    semantic: boolean,
    previous?: unknown,
    ignoreRules?: unknown,
    scanId?: unknown
  ) => {
    try {
      // 入参防御性校验与增量缓存源选择（内存缓存优先，未携带/非法回退 userData 落盘缓存，惰性异步读盘）
      const args = await resolveScanArgs(previous, ignoreRules, async () =>
        getScanCache(await loadScanCacheStore(), leftDir, rightDir)
      )
      const id = typeof scanId === 'number' && Number.isFinite(scanId) ? scanId : -1
      // 比对进度推送（首个 push 型 IPC）：窗口销毁后 send 抛错，进度丢失无影响
      const onProgress = (done: number, total: number): void => {
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('folder:scan-progress', { scanId: id, done, total })
          }
        } catch {
          // 窗口已销毁等：忽略
        }
      }
      const result = await scanFolders(leftDir, rightDir, {
        ...args,
        onProgress,
        ...(semantic
          ? {
              // 语义判等解码复用解码 worker（大缓冲后台解码，与文件打开共用同一管线）
              semantic: {
                maxBytes: SEMANTIC_MAX_BYTES,
                isTextFile: isTextRel,
                decode: async (buf) => (await decodeMaybeWorker(buf)).text
              }
            }
          : {})
      })
      // 扫描成功且未截断：缓存异步落盘（LRU，失败静默；下次启动同目录对可增量重扫）
      if (!result.truncated) persistScanCache(leftDir, rightDir, result.cache)
      return result
    } catch {
      // 目录不存在/不可读等：转为错误标记，渲染端提示
      return { error: 'scan-failed' as const }
    }
  }
)

/** IPC: 按绝对路径读取文本文件（文件夹对比双击进入单文件对比；与 file:open 同一读取管线） */
ipcMain.handle('file:read-by-path', async (_event, filePath: string) => {
  return readTextFile(filePath)
})

/**
 * 快照文件的读取上限（128MB）：保存侧内容总量上限 32M 字符（中文 JSON 化后可达 ~96MB），
 * 走通用读取管线的 10MB 上限会拦截自家保存的大快照（保存成功却无法加载的自相矛盾），
 * 故快照加载走本专用通道；上限仍防御异常超大文件拖垮渲染进程。
 */
const SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024

/**
 * IPC: 选择并读取快照文件（专用通道，与 file:open 分离）。
 * - 读取上限 128MB（快照为应用自有 JSON，可大于通用文件的 10MB）；
 * - 快照始终以 UTF-8 写盘，直接按 UTF-8 解码，无需编码探测；
 * - 不写 lastDir（快照目录与常用文件目录语义不同，避免污染文件对话框记忆）。
 */
ipcMain.handle('snapshot:read', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择快照文件',
    properties: ['openFile'],
    filters: [
      { name: '快照文件', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  let buf: Buffer
  try {
    const st = await fs.promises.stat(filePath)
    if (st.size > SNAPSHOT_MAX_BYTES) {
      return { error: 'too-large' as const, name, size: st.size }
    }
    buf = await fs.promises.readFile(filePath)
  } catch {
    return { error: 'read-failed' as const, name }
  }
  return { path: filePath, name, text: buf.toString('utf-8'), encoding: 'UTF-8', binary: false }
})

/** IPC: 应用版本号（package.json 的 version 为唯一来源，dev 与打包行为一致） */
ipcMain.handle('app:get-version', () => app.getVersion())

/** 批量读取的路径数上限（渲染端快照保存按差异条目收集，超出说明异常输入，整体拒绝） */
const READ_BATCH_MAX_PATHS = 256

/**
 * IPC: 批量读取多个文本文件（快照保存收集差异条目内容用）。
 * 与单文件读取同一管线（10MB 上限/编码探测/解码 worker），受控并发分批；
 * 单文件失败该条目返回错误对象不整体失败（与 folderScan 的单点降级哲学一致），
 * 渲染端把失败条目按"该侧无内容"处理。
 */
ipcMain.handle('folder:read-batch', async (_event, paths: unknown) => {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > READ_BATCH_MAX_PATHS ||
    !paths.every((p) => typeof p === 'string' && p.length > 0)
  ) {
    return { error: 'invalid' as const }
  }
  const results = new Array<Awaited<ReturnType<typeof readTextFile>>>(paths.length)
  for (let i = 0; i < paths.length; i += SCAN_CONCURRENCY) {
    const batch = paths.slice(i, i + SCAN_CONCURRENCY)
    await Promise.all(
      batch.map(async (p, k) => {
        results[i + k] = await readTextFile(p)
      })
    )
  }
  return { files: results }
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.thzxxart.difflens')

  // 强制暗色系统主题：Windows 标题栏/滚动条等系统控件跟随应用暗色科幻风格
  nativeTheme.themeSource = 'dark'

  // 读取持久化应用状态（窗口 bounds + 上次文件目录；损坏数据回退空状态）
  appState = loadState()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 隐藏窗口自带的应用菜单栏（功能入口由界面按钮提供）
  Menu.setApplicationMenu(null)
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
