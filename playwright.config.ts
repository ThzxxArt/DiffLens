import { defineConfig } from '@playwright/test'

/**
 * Playwright E2E 配置：对构建产物（out/）启动真实 Electron 应用做端到端验收。
 * - Electron 模式复用项目自带 Electron，无需下载 Playwright 浏览器
 * - 不参与 vitest 单测与覆盖率统计；测试前必须先 npm run build
 */
export default defineConfig({
  testDir: 'e2e',
  // Electron 启动 + 窗口就绪整体放宽，避免慢机误报
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    trace: 'off',
    headless: false
  }
})
