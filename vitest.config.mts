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
    // CI 慢机 / 覆盖率插桩下，字符级性能回归用例可能超过默认 5s；20s 仅作为上限
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
        // 测试文件本身不计入覆盖率
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/renderer/src/test/**',
        'src/renderer/src/env.d.ts',
        // 类型-only 文件无运行时代码
        'src/renderer/src/app/types.ts',
        // worker 线程入口无法在 jsdom 执行，其调用的 computeDiff 已由 diffEngine 测试覆盖
        'src/renderer/src/diff/diffWorker.ts',
        // 主进程运行时装配：Electron app/window/IPC/fs 无法在 jsdom 执行，
        // 真实链路由 E2E 覆盖；可纯逻辑化的 fileService 仍保留在覆盖率内
        'src/main/index.ts',
        'src/main/window.ts',
        'src/main/appState.ts',
        'src/main/scanCacheService.ts',
        'src/main/ipc/**',
        // 解码 worker 线程入口（真实链路由 E2E 编码用例覆盖），其调用的
        // decodeText 已由 decode 测试覆盖
        'src/main/decodeWorker.ts'
      ],
      all: true,
      // CI 门禁：0.12.1 基线实际为 94.6/89.5/95.1/95.8，阈值上调留出合理余量
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90
      }
    }
  }
})
