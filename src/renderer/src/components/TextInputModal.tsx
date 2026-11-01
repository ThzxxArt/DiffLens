import { useEffect, useState, type ReactElement } from 'react'

interface TextInputModalProps {
  title: string
  onCancel: () => void
  onConfirm: (text: string) => void
}

export default function TextInputModal({
  title,
  onCancel,
  onConfirm
}: TextInputModalProps): ReactElement {
  const [text, setText] = useState('')

  // Esc 取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onCancel}
      onContextMenu={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <div className="text-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="text-modal-head">{title}</div>
        <textarea
          className="text-modal-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/Cmd + Enter 快捷提交
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onConfirm(text)
          }}
          autoFocus
          placeholder="在此粘贴或输入文本，然后点击“开始对比”…"
          spellCheck={false}
        />
        <div className="text-modal-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" onClick={() => onConfirm(text)}>
            开始对比
          </button>
        </div>
      </div>
    </div>
  )
}