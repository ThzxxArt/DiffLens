import { join, sep } from 'path'
import { Worker } from 'worker_threads'
import fs from 'fs'
import { decodeText, type DecodeResult } from './decode'
import { isTextFileName } from '../shared/textExtensions'
import { MAX_FILE_SIZE } from '../shared/limits'

export { MAX_FILE_SIZE } from '../shared/limits'

/** 解码快路径阈值（256KB）：小缓冲同步解码（毫秒级），大缓冲派发 worker 后台解码 */
const DECODE_FAST_PATH_BYTES = 256 * 1024

/** 相对路径是否为文本文件（按最后一段文件名，语义判等文本判定共用） */
export function isTextRel(rel: string): boolean {
  return isTextFileName(rel)
}

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
export async function decodeMaybeWorker(buf: Buffer): Promise<DecodeResult> {
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
export async function readTextFile(
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
