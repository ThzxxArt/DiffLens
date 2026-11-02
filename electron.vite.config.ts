import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // iconv-lite 打包进产物：解码 worker 随 asarUnpack 加载，unpacked 路径下无法
    // 解析 asar 内的 node_modules（Electron 的 asar 补丁不覆盖 worker 线程）
    plugins: [externalizeDepsPlugin({ exclude: ['iconv-lite'] })],
    build: {
      sourcemap: false,
      minify: true,
      rollupOptions: {
        // 双入口：主进程 + 解码 worker（worker_threads 无法加载 asar 内脚本，需单独产物）
        input: {
          index: resolve('src/main/index.ts'),
          decodeWorker: resolve('src/main/decodeWorker.ts')
        },
        output: {
          entryFileNames: '[name].js',
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      minify: true
    }
  },
  renderer: {
    build: {
      minify: true
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
