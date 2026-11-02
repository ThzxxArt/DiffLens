import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import iconv from 'iconv-lite'

/**
 * E2E 辅助：启动构建产物（out/）对应的真实 Electron 应用，
 * 以及文件对话框 stub 与临时 fixture 生成。
 * Electron 模式复用项目自带 Electron 二进制，无需下载 Playwright 浏览器。
 */

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
}

/**
 * 启动应用并等待首个窗口就绪。
 * fresh（默认 true）：清除上一轮测试残留的偏好持久化（localStorage 跨实例共享 userData）
 * 并重载页面，保证以默认选项启动；偏好持久化用例的验证实例显式传 false。
 */
export async function launchApp(options: { fresh?: boolean } = {}): Promise<LaunchedApp> {
  const { fresh = true } = options
  const app = await electron.launch({ args: ['.'] })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  if (fresh) {
    await window.evaluate(() => window.localStorage.clear())
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
  }
  return { app, window }
}

/**
 * 主进程 stub：showOpenDialog 按调用序返回指定路径（每次调用取该组第一个文件）。
 * 闭包计数状态保留在主进程，覆盖「打开左侧 → 打开右侧」的连续调用。
 */
export async function stubOpenDialogSeq(
  app: ElectronApplication,
  seqPaths: string[][]
): Promise<void> {
  await app.evaluate(({ dialog }, seq: string[][]) => {
    let i = 0
    dialog.showOpenDialog = async () => {
      const paths = seq[Math.min(i, seq.length - 1)] ?? []
      i++
      return { canceled: false, filePaths: paths }
    }
  }, seqPaths)
}

/** 主进程 stub：showSaveDialog 固定返回指定保存路径 */
export async function stubSaveDialog(app: ElectronApplication, savePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p: string) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, savePath)
}

/** 创建临时目录（存放测试 fixture / 导出产物） */
export async function makeTmpDir(prefix = 'difflens-e2e-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** 清理临时目录（递归、不存在时忽略） */
export async function removeTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/**
 * 写入文本 fixture：encoding 为 'utf8'（可带 bom）或 'gbk'（iconv-lite 编码）。
 * 返回文件绝对路径。
 */
export async function writeTextFixture(
  dir: string,
  name: string,
  content: string,
  encoding: 'utf8' | 'utf8-bom' | 'gbk' = 'utf8'
): Promise<string> {
  const path = join(dir, name)
  if (encoding === 'gbk') {
    await writeFile(path, iconv.encode(content, 'gbk'))
  } else if (encoding === 'utf8-bom') {
    await writeFile(path, '\ufeff' + content, 'utf8')
  } else {
    await writeFile(path, content, 'utf8')
  }
  return path
}

/** 通过「粘贴文本」入口向指定侧粘贴内容（覆盖粘贴弹窗全链路） */
export async function pasteText(window: Page, side: 'left' | 'right', text: string): Promise<void> {
  await window.getByRole('button', { name: '粘贴文本' }).click()
  await window.getByRole('button', { name: side === 'left' ? '粘贴到左侧' : '粘贴到右侧' }).click()
  await window.getByPlaceholder(/粘贴或输入/).fill(text)
  await window.getByRole('button', { name: '开始对比' }).click()
}

/**
 * 向指定选择器元素派发合成拖放（真实 Chromium 支持 DataTransfer/DragEvent 构造）。
 * 覆盖渲染进程拖拽导入全链路：dropPane 走 file.arrayBuffer → decodeBuffer IPC → 编码探测。
 * 先派发 dragover（preventDefault 激活 drop 目标）再派发 drop。
 */
export async function dropFiles(
  window: Page,
  selector: string,
  files: { name: string; content: string; type?: string }[]
): Promise<void> {
  await window.evaluate(
    ({ sel, specs }) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`dropFiles: selector not found: ${sel}`)
      const dt = new DataTransfer()
      for (const f of specs) {
        dt.items.add(new File([f.content], f.name, { type: f.type ?? 'text/plain' }))
      }
      el.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
      )
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    { sel: selector, specs: files }
  )
}
