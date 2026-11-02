import type { DiffRow } from '../diff/diffEngine'

export interface PaneMeta {
  name: string
  encoding: string
}

/** 虚拟行高（px）。与 global.css 的 --line-height: 21px 保持一致，改动需双向同步 */
export const ROW_HEIGHT = 21

/** “仅看差异”视图中的折叠提示行（占用一个虚拟行位，高度与其他行一致） */
export interface FoldMarker {
  fold: true
  /** 被折叠的未更改行数 */
  skipped: number
  /** 自定义提示文案（如“完全一致”场景） */
  note?: string
}

export type DisplayItem = DiffRow | FoldMarker

export const isFold = (item: DisplayItem): item is FoldMarker => 'fold' in item
