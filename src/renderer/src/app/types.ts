import type { PaneMeta } from '../components/DiffView'

/** 单侧文件面板状态（文件元信息 + 原始路径 + 全文） */
export interface PaneState {
  meta: PaneMeta
  path: string
  text: string
}
