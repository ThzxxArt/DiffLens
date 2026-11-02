import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/renderer/src/test/setup.ts'],
    include: [
      'src/renderer/src/**/*.{test,spec}.{ts,tsx}',
      // 主进程纯逻辑模块（无 electron 依赖）与两进程共享纯逻辑模块的单元测试
      'src/main/**/*.{test,spec}.{ts,tsx}',
      'src/shared/**/*.{test,spec}.{ts,tsx}'
    ],
    exclude: ['node_modules', 'dist', 'out'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/renderer/src/**/*.{ts,tsx}', 'src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        'src/renderer/src/**/*.{test,spec}.{ts,tsx}',
        'src/renderer/src/test/**',
        'src/renderer/src/env.d.ts',
        // worker 线程入口无法在 jsdom 执行，其调用的 computeDiff 已由 diffEngine 测试覆盖
        'src/renderer/src/diff/diffWorker.ts',
        // 主进程入口依赖 electron 运行时，无法在 jsdom 测试（窗口/IPC 逻辑随发布人工自测）
        'src/main/index.ts',
        // 解码 worker 线程入口（真实链路由 E2E 编码用例覆盖），其调用的
        // decodeText 已由 decode 测试覆盖
        'src/main/decodeWorker.ts'
      ],
      all: true,
      // CI 门禁：四项覆盖率不得低于 80%，否则测试失败
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
})
