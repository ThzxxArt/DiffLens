import { app, dialog, ipcMain, shell } from 'electron'
import fs from 'fs'
import { dirname, join } from 'path'
import { getAppState, saveStateAsync } from '../appState'
import { decodeMaybeWorker, readTextFile, SNAPSHOT_MAX_BYTES } from '../fileService'
import { SCAN_CONCURRENCY } from '../folderScan'
import { TEXT_EXTENSIONS } from '../../shared/textExtensions'

/** 批量读取的路径数上限（渲染端快照保存按差异条目收集，超出说明异常输入，整体拒绝） */
const READ_BATCH_MAX_PATHS = 256

export function registerFileIpc(): void {
  /** IPC: 打开文件对话框并读取内容 */
  ipcMain.handle('file:open', async (_event, side: 'left' | 'right' | null) => {
    const state = getAppState()
    const result = await dialog.showOpenDialog({
      title: `选择${side === 'left' ? '左侧' : side === 'right' ? '右侧' : ''}文本文件`,
      // 记忆上次成功打开文件所在目录；无记录时传 undefined 走系统默认（最近使用位置）
      defaultPath: state.lastDir,
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
    state.lastDir = dirname(filePath)
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
    const state = getAppState()
    const ext = defaultName.split('.').pop() ?? 'txt'
    const result = await dialog.showSaveDialog({
      title: '保存差异报告',
      defaultPath: join(state.lastReportDir ?? app.getPath('documents'), defaultName),
      filters: [
        { name: '差异报告', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return { ok: false, path: null }
    // 异步写盘，避免大报告（MB 级 HTML）同步写入时阻塞主进程事件循环
    await fs.promises.writeFile(result.filePath, content, 'utf-8')
    state.lastReportDir = dirname(result.filePath)
    saveStateAsync()
    return { ok: true, path: result.filePath }
  })

  /** IPC: 打开系统文件管理器定位文件 */
  ipcMain.handle('file:show-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
    return true
  })

  /** IPC: 按绝对路径读取文本文件（文件夹对比双击进入单文件对比；与 file:open 同一读取管线） */
  ipcMain.handle('file:read-by-path', async (_event, filePath: string) => {
    return readTextFile(filePath)
  })

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
}
