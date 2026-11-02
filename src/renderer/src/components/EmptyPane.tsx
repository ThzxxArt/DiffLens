import { useState, type ReactElement } from 'react'

export default function EmptyPane({
  side,
  onOpen,
  onDrop
}: {
  side: 'left' | 'right'
  onOpen: (s: 'left' | 'right') => void
  onDrop: (s: 'left' | 'right', files: File[]) => void
}): ReactElement {
  const [drag, setDrag] = useState(false)
  return (
    <div
      className={'pane-empty' + (drag ? ' dragging' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) onDrop(side, files)
      }}
    >
      <div>
        <span className={'pane-dot ' + side} style={{ display: 'inline-block' }} />
        <h3>选择{side === 'left' ? '左侧' : '右侧'}文件</h3>
        <p>{side === 'left' ? '被对比的原始文本' : '用于对比的新文本'}</p>
        <button className="btn primary" onClick={() => onOpen(side)}>
          打开文件
        </button>
        <div className="pane-drop-hint">或直接将文件拖拽到此处</div>
      </div>
    </div>
  )
}
