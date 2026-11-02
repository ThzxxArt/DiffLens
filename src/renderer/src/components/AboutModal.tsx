import { useEffect, type ReactElement } from 'react'
import { ABOUT_INFO } from '../app/aboutInfo'
import LogoIcon from './LogoIcon'

interface AboutModalProps {
  /** 应用版本号（App 经 app:get-version IPC 获取；未取得时传空串显示占位） */
  version: string
  onClose: () => void
  /** 复制到剪贴板（App 实现 setClipboard + toast 反馈） */
  onCopy: (text: string, label: string) => void
}

/**
 * 「关于」弹框：应用介绍、版本、作者、邮箱、开源地址与许可证。
 * 关闭方式与粘贴弹窗同语言：Esc / 点击遮罩 / 右上角关闭按钮；
 * 邮箱与开源地址点击复制到剪贴板（复用主进程剪贴板管线，不引入外部跳转）。
 */
export default function AboutModal({ version, onClose, onCopy }: AboutModalProps): ReactElement {
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="about-modal" onMouseDown={(e) => e.stopPropagation()}>
        <button className="about-close" title="关闭" onClick={onClose}>
          ✕
        </button>
        <div className="about-logo">
          <LogoIcon size={40} />
        </div>
        <div className="about-name">{ABOUT_INFO.name}</div>
        <div className="about-version">版本 {version !== '' ? version : '—'}</div>
        <p className="about-desc">{ABOUT_INFO.description}</p>
        <div className="about-rows">
          <div className="about-row">
            <span className="about-k">作者</span>
            <button
              className="about-v"
              title="点击复制"
              onClick={() => onCopy(ABOUT_INFO.author, '作者')}
            >
              {ABOUT_INFO.author}
            </button>
          </div>
          <div className="about-row">
            <span className="about-k">邮箱</span>
            <span className="about-vs">
              {ABOUT_INFO.emails.map((m) => (
                <button
                  key={m}
                  className="about-v"
                  title="点击复制"
                  onClick={() => onCopy(m, '邮箱')}
                >
                  {m}
                </button>
              ))}
            </span>
          </div>
          <div className="about-row">
            <span className="about-k">开源地址</span>
            <button
              className="about-v"
              title="点击复制"
              onClick={() => onCopy(ABOUT_INFO.repoUrl, '开源地址')}
            >
              {ABOUT_INFO.repoUrl}
            </button>
          </div>
          <div className="about-row">
            <span className="about-k">许可证</span>
            <span className="about-v plain">{ABOUT_INFO.license}</span>
          </div>
        </div>
        <div className="about-foot">© 2026 ThzxxArt · DiffLens</div>
      </div>
    </div>
  )
}
