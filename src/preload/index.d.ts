import { DiffLensApi } from './index'

declare global {
  interface Window {
    api: DiffLensApi
  }
}

export {}