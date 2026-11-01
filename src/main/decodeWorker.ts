import { parentPort } from 'worker_threads'
import { decodeText } from './decode'

/**
 * 解码 worker 入口（worker_threads）。
 * 协议与渲染端 diffWorker 同构：请求 { jobId, buffer } → 响应 { jobId, result }。
 * 大文件解码（iconv-lite GBK 为纯 JS 实现）在此线程执行，不阻塞主进程事件循环。
 * 注意：本文件随构建单独打包并 asarUnpack（Electron 的 asar 补丁不覆盖 worker 线程），
 * iconv-lite 由构建配置打包进本文件（unpacked 路径下无法解析 asar 内 node_modules）。
 */
parentPort?.on('message', (msg: { jobId: number; buffer: Uint8Array }) => {
  parentPort?.postMessage({ jobId: msg.jobId, result: decodeText(msg.buffer) })
})
