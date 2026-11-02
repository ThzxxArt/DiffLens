import { contextBridge, ipcRenderer } from 'electron'

/** 打开文件成功返回的数据结构 */
export interface FileData {
  path: string
  name: string
  text: string
  encoding: string
  /** 疑似二进制内容（解码启发式判定），渲染端据此提示乱码风险 */
  binary: boolean
}

/** 打开文件失败的返回结构 */
export interface FileOpenError {
  error: 'too-large' | 'read-failed'
  /** 文件名（用于提示） */
  name?: string
  /** too-large 时的文件字节数 */
  size?: number
}

/** 打开文件结果：成功数据 / 失败原因 / 用户取消（null） */
export type FileOpenResult = FileData | FileOpenError | null

/** 文件夹对比条目状态（与主进程 folderScan 对齐；semantic-same = 字节不同但剔除空白后内容一致；unreadable = 读取失败被锁/权限） */
export type FolderEntryStatus =
  'same' | 'semantic-same' | 'different' | 'left-only' | 'right-only' | 'unreadable'

/** 文件夹对比单个条目 */
export interface FolderEntry {
  rel: string
  status: FolderEntryStatus
  leftSize: number | null
  rightSize: number | null
  approximate?: boolean
}

/** 文件夹扫描结果 */
export interface FolderScanResult {
  entries: FolderEntry[]
  truncated: boolean
  total: number
  /** 增量重扫缓存（与主进程 folderScan 的 ScanCacheEntry 对齐；截断时为空数组）。
   *  下次扫描同目录时携带可零 IO 沿用指纹一致的判定 */
  cache?: FolderScanCacheEntry[]
}

/** 单侧文件指纹（size + mtimeMs），增量重扫的变更判定依据 */
export interface FolderFileFingerprint {
  size: number
  mtime: number
}

/** 增量重扫缓存条目（与主进程 folderScan 对齐；unreadable 不进缓存） */
export interface FolderScanCacheEntry {
  rel: string
  leftFp: FolderFileFingerprint | null
  rightFp: FolderFileFingerprint | null
  status: 'same' | 'semantic-same' | 'different' | 'left-only' | 'right-only'
  approximate?: boolean
  /** 上次是否参与过语义判等及其结果（null = 未参与）；语义开关翻转时非 null 可零 IO 组合 */
  semSame: boolean | null
}

/** 文件夹扫描失败（目录不存在/不可读） */
export interface FolderScanError {
  error: 'scan-failed'
}

/** 扫描进度事件负载（folder:scan-progress 推送；scanId 与渲染端扫描会话序号对应） */
export interface FolderScanProgress {
  scanId: number
  done: number
  total: number
}

/** 批量读取结果：全部路径的读取结果（按入参顺序；单文件失败为错误对象，不整体失败） */
export interface ReadBatchResult {
  files: FileOpenResult[]
}

/** 主进程暴露给渲染进程的安全 API */
const api = {
  openFile: (side?: 'left' | 'right'): Promise<FileOpenResult> =>
    ipcRenderer.invoke('file:open', side ?? null),
  decodeBuffer: (
    buffer: ArrayBuffer
  ): Promise<{ text: string; encoding: string; binary: boolean }> =>
    ipcRenderer.invoke('file:decode-buffer', buffer),
  saveReport: (
    content: string,
    defaultName: string
  ): Promise<{ ok: boolean; path: string | null }> =>
    ipcRenderer.invoke('file:save-report', content, defaultName),
  showInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('file:show-in-folder', filePath),
  setClipboard: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('folder:pick'),
  scanFolder: (
    leftDir: string,
    rightDir: string,
    semantic: boolean,
    previous?: FolderScanCacheEntry[] | null,
    /** 忽略规则（gitignore 简化子集含高级 glob；命中的目录整树剪枝、文件跳过） */
    ignoreRules?: string[] | null,
    /** 扫描会话序号（渲染端 scanSeq；进度事件携带回传，渲染端只显示最新会话的进度） */
    scanId?: number
  ): Promise<FolderScanResult | FolderScanError> =>
    ipcRenderer.invoke(
      'folder:scan',
      leftDir,
      rightDir,
      semantic,
      previous ?? null,
      ignoreRules ?? null,
      scanId ?? -1
    ),
  /**
   * 订阅扫描进度推送（首个 push 型 IPC）：返回取消订阅函数。
   * 事件负载带 scanId，渲染端按当前会话序号过滤，旧扫描迟到的进度被丢弃。
   */
  onScanProgress: (cb: (data: FolderScanProgress) => void): (() => void) => {
    const listener = (_e: unknown, data: FolderScanProgress): void => cb(data)
    ipcRenderer.on('folder:scan-progress', listener)
    return (): void => {
      ipcRenderer.removeListener('folder:scan-progress', listener)
    }
  },
  readByPath: (filePath: string): Promise<FileOpenResult> =>
    ipcRenderer.invoke('file:read-by-path', filePath),
  /** 批量读取文本文件（快照保存收集差异条目内容用；单文件失败为错误对象不整体失败） */
  readFilesByPaths: (paths: string[]): Promise<ReadBatchResult | { error: 'invalid' }> =>
    ipcRenderer.invoke('folder:read-batch', paths),
  /**
   * 选择并读取快照文件（专用通道）：读取上限 128MB（通用文件 10MB 上限会拦截
   * 自家保存的大快照），UTF-8 直读不做编码探测，不写 lastDir 记忆。
   * 返回结构与 openFile 一致（成功数据 / 失败原因 / 用户取消 null）。
   */
  readSnapshot: (): Promise<FileOpenResult> => ipcRenderer.invoke('snapshot:read'),
  /** 应用版本号（主进程 app.getVersion()，package.json 的 version 为唯一来源） */
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version')
}

export type DiffLensApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // 非隔离环境下透传到 window
  ;(window as unknown as { api: DiffLensApi }).api = api
}
