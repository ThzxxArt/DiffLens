import type { ReactElement } from 'react'

/**
 * 应用 Logo（放大镜 + 差异短横线的暗色科幻风格图标）。
 * 尺寸由 size 控制（App 头部 18 / 关于弹框 40），描边随尺寸等比缩放。
 */
export default function LogoIcon({ size = 18 }: { size?: number }): ReactElement {
  const s = size / 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="6.2" stroke="#fff" strokeWidth={2.1 * Math.max(s, 0.7)} />
      <line
        x1="15.5"
        y1="15.5"
        x2="20.5"
        y2="20.5"
        stroke="#fff"
        strokeWidth={2.4 * Math.max(s, 0.7)}
        strokeLinecap="round"
      />
      <path
        d="M5 11h3.4M5 14h2"
        stroke="#030712"
        strokeWidth={1.6 * Math.max(s, 0.7)}
        strokeLinecap="round"
      />
    </svg>
  )
}
