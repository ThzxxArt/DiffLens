import { dialog, ipcMain } from 'electron'
import { getAppState, saveStateAsync } from '../appState'
import { getScanCache } from '../scanCacheStore'
import { loadScanCacheStore, persistScanCache } from '../scanCacheService'
import { resolveScanArgs } from '../scanIpc'
import { scanFolders, SEMANTIC_MAX_BYTES } from '../folderScan'
import { decodeMaybeWorker, isTextRel } from '../fileService'

export function registerFolderIpc(): void {
  /** IPC: 选择文件夹（文件夹对比入口；记忆上次目录） */
  ipcMain.handle('folder:pick', async () => {
    const state = getAppState()
    const result = await dialog.showOpenDialog({
      title: '选择要对比的文件夹',
      defaultPath: state.lastDir,
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dirPath = result.filePaths[0]
    state.lastDir = dirPath
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
}
