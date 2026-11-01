import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// 每个用例结束自动卸载组件，避免多次 render 叠加污染 DOM
afterEach(() => {
  cleanup()
})