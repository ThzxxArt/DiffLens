import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import App from '../App'
import { parseSnapshot, type SnapshotContents } from '../diff/snapshotDiff'

// 快照内容总量上限压低至 100 字符：专测"超限整体降级为纯状态快照"路径（vi.mock 工厂在文件级生效，
// 其余快照用例的批量读 mock 均返回空 → 不产生 contents，不受该常量影响；真实常量由 snapshotDiff 测试覆盖）
vi.mock('../diff/snapshotDiff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../diff/snapshotDiff')>()
  return { ...actual, SNAPSHOT_CONTENTS_MAX_CHARS: 100 }
})

let clipboardSpy: ReturnType<typeof vi.fn>

function mockApi(overrides?: Partial<typeof window.api>): typeof window.api {
  // 剪贴板统一走主进程 IPC，spy 挂在 setClipboard 上
  clipboardSpy = vi.fn(async () => true)
  const base = {
    openFile: async () => ({
      path: '/tmp/a.txt',
      name: 'a.txt',
      text: 'line1\nline2',
      encoding: 'UTF-8',
      binary: false
    }),
    decodeBuffer: async () => ({ text: 'line1\nline2', encoding: 'UTF-8', binary: false }),
    saveReport: async () => ({ ok: false, path: null }),
    showInFolder: async () => true,
    setClipboard: clipboardSpy,
    pickFolder: async () => null,
    scanFolder: async () => ({ entries: [], truncated: false, total: 0 }),
    // 扫描进度订阅：no-op 订阅（进度事件链路由专项用例经捕获回调触发）
    onScanProgress: (): (() => void) => () => {},
    readByPath: async () => null,
    // 批量读取默认空结果（快照保存的 contents 数据流由专项用例覆写）
    readFilesByPaths: async () => ({ files: [] }),
    // 快照加载专用通道：默认用户取消（null）；快照内容由各用例覆写
    readSnapshot: async () => null,
    // 应用版本号（关于弹框展示；测试固定值避免与真实版本耦合）
    getVersion: async () => '9.9.9-test'
  }
  return { ...base, ...overrides } as typeof window.api
}

beforeEach(() => {
  vi.restoreAllMocks()
  window.api = mockApi()
  // 清除偏好持久化（比较选项 + 视图开关），避免用例间互相污染初始状态
  window.localStorage.clear()
  // jsdom 未实现滚动定位，导航定位（虚拟化受控 scrollTop）需要打桩
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('App - 初始空态', () => {
  it('渲染应用名称 DiffLens', () => {
    render(<App />)
    expect(screen.getByText('DiffLens')).toBeInTheDocument()
  })

  it('展示左右两个空态文件面板', () => {
    render(<App />)
    expect(screen.getByText(/选择左侧文件/)).toBeInTheDocument()
    expect(screen.getByText(/选择右侧文件/)).toBeInTheDocument()
  })

  it('未加载文件时不显示导出入口', () => {
    render(<App />)
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })
})

describe('App - 加载文件后的非空态', () => {
  it('打开文件后渲染对比视图与导出入口，并显示文件内容', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))

    expect(await screen.findByText('导出报告')).toBeInTheDocument()
    // 被对比的内容渲染（此处与空文件对比，内容出现在面板中）
    expect((await screen.findAllByText(/line1/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('a.txt').length).toBeGreaterThan(0)
  })

  it('右侧打开文件后可导出报告', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开右侧'))
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
  })
})

describe('App - 导出报告交互', () => {
  it('导出 HTML 成功后弹保存提示，可一键打开文件夹', async () => {
    const showInFolder = vi.fn(async () => true)
    window.api = mockApi({
      saveReport: async () => ({ ok: true, path: 'C:/docs/DiffLens-report.html' }),
      showInFolder
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('HTML 报告'))
    expect(await screen.findByText(/报告已保存/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('打开文件夹'))
    expect(showInFolder).toHaveBeenCalledWith('C:/docs/DiffLens-report.html')
  })
})

describe('App - 行右键菜单', () => {
  it('右键内容行弹出菜单（覆盖 onRowContext）', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    // 空 vs 有内容 → 内容在左侧为删除行，contextMenu 触发左侧菜单
    const line = (await screen.findAllByText(/line1/))[0]
    fireEvent.contextMenu(line)
    expect(await screen.findByText('复制左侧此行内容')).toBeInTheDocument()
  })
})

describe('App - 拖拽导入', () => {
  it('拖放文件到左侧面板加载（覆盖 dropPane）', async () => {
    render(<App />)
    const file = new File(['drop1\ndrop2'], 'c.txt', { type: 'text/plain' })
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    expect(pane).not.toBeNull()
    fireEvent.drop(pane, { dataTransfer: { files: [file] } })
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
    expect(screen.getAllByText('c.txt').length).toBeGreaterThan(0)
  })

  it('拖拽悬停/离开切换高亮样式', () => {
    render(<App />)
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.dragOver(pane)
    expect(pane.className).toContain('dragging')
    fireEvent.dragLeave(pane)
    expect(pane.className).not.toContain('dragging')
  })

  it('解码失败时回退 file.text（覆盖 dropPane catch 分支）', async () => {
    window.api = mockApi({
      decodeBuffer: async () => {
        throw new Error('boom')
      }
    })
    render(<App />)
    const file = new File(['fallback1'], 'd.txt', { type: 'text/plain' })
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, { dataTransfer: { files: [file] } })
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
  })
})

describe('App - 差异导航与清空', () => {
  it('点击下一处差异触发定位（覆盖 go）', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle(/下一处差异/))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
  })

  it('点击清空恢复空态（二次确认后执行）', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('清空'))
    expect(await screen.findByText(/再次点击/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('清空'))
    expect(await screen.findByText(/选择左侧文件/)).toBeInTheDocument()
  })
})

describe('App - 清空二次确认', () => {
  it('有内容时第一次点击仅提示，不清空', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('清空'))
    expect(await screen.findByText(/再次点击“清空”将移除两侧内容/)).toBeInTheDocument()
    // 未清空：对比视图仍在
    expect(screen.getByText('导出报告')).toBeInTheDocument()
  })

  it('确认窗口超时后自动复位（再点一次仍先提示）', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByText('打开左侧'))
    })
    expect(screen.getByText('导出报告')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByText('清空'))
    })
    expect(screen.getAllByText(/再次点击/).length).toBeGreaterThan(0)
    // 超过确认窗口 + toast 自身寿命：复位且提示消失
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByText(/再次点击/)).not.toBeInTheDocument()
    // 复位后再点击仍是“先提示”而非直接清空
    await act(async () => {
      fireEvent.click(screen.getByText('清空'))
    })
    expect(screen.getAllByText(/再次点击/).length).toBeGreaterThan(0)
    expect(screen.getByText('导出报告')).toBeInTheDocument()
  })

  it('空态时点击清空不弹确认（无内容无确认成本）', () => {
    render(<App />)
    fireEvent.click(screen.getByText('清空'))
    expect(screen.queryByText(/再次点击/)).not.toBeInTheDocument()
    expect(screen.getByText(/选择左侧文件/)).toBeInTheDocument()
  })
})

describe('App - 空态打开按钮', () => {
  it('点击空面板的打开文件按钮加载左侧文件', async () => {
    render(<App />)
    fireEvent.click(screen.getAllByText('打开文件')[0])
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
  })
})

describe('App - 右键菜单操作', () => {
  it('执行复制本行内容并关闭菜单', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.contextMenu((await screen.findAllByText(/line1/))[0])
    fireEvent.click(await screen.findByText('复制左侧此行内容'))
    expect(clipboardSpy).toHaveBeenCalled()
    expect(screen.queryByText('复制左侧此行内容')).not.toBeInTheDocument()
  })

  it('执行复制文件名（走主进程剪贴板 IPC）', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.contextMenu((await screen.findAllByText(/line1/))[0])
    fireEvent.click(await screen.findByText('复制文件名'))
    expect(clipboardSpy).toHaveBeenCalledWith('a.txt')
  })

  it('执行在文件夹中显示（覆盖 showInFolder）', async () => {
    const showInFolder = vi.fn(async () => true)
    window.api = mockApi({ showInFolder })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.contextMenu((await screen.findAllByText(/line1/))[0])
    fireEvent.click(await screen.findByText('在文件夹中显示'))
    expect(showInFolder).toHaveBeenCalledWith('/tmp/a.txt')
  })
})

describe('App - 右侧面板交互', () => {
  it('点击右侧打开文件按钮加载', async () => {
    render(<App />)
    fireEvent.click(screen.getAllByText('打开文件')[1])
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
  })

  it('右侧拖拽悬停/离开高亮切换', () => {
    render(<App />)
    const pane = screen.getByText(/选择右侧文件/).closest('.pane-empty') as Element
    fireEvent.dragOver(pane)
    expect(pane.className).toContain('dragging')
    fireEvent.dragLeave(pane)
    expect(pane.className).not.toContain('dragging')
  })

  it('右侧拖放加载（覆盖右侧 onDrop 与 dropPane 右分支）', async () => {
    render(<App />)
    const file = new File(['r1\nr2'], 'e.txt', { type: 'text/plain' })
    const pane = screen.getByText(/选择右侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, { dataTransfer: { files: [file] } })
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
  })

  it('拖放非文本文件被拒绝并提示', async () => {
    render(<App />)
    const file = new File(['fake'], 'img.png', { type: 'image/png' })
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, { dataTransfer: { files: [file] } })
    expect(await screen.findByText(/仅支持文本文件/)).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })
})

describe('App - 提示与容错', () => {
  it('连续提示时后一条不被前一条定时器清除', () => {
    vi.useFakeTimers()
    render(<App />)
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(['x'], 'a.png', { type: 'image/png' })] }
    })
    expect(screen.getByText(/仅支持文本文件：a.png/)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(['x'], 'b.png', { type: 'image/png' })] }
    })
    expect(screen.getByText(/仅支持文本文件：b.png/)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    // 旧实现中第一个 3600ms 定时器会把第二条提示提前清掉
    expect(screen.getByText(/仅支持文本文件：b.png/)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByText(/仅支持文本文件：b.png/)).not.toBeInTheDocument()
  })

  it('两条提示同时可见（队列化不互顶），各自独立消失', () => {
    vi.useFakeTimers()
    render(<App />)
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(['x'], 'a.png', { type: 'image/png' })] }
    })
    fireEvent.drop(pane, {
      dataTransfer: { files: [new File(['x'], 'b.png', { type: 'image/png' })] }
    })
    // 两条都在队列中同时展示
    expect(screen.getByText(/仅支持文本文件：a.png/)).toBeInTheDocument()
    expect(screen.getByText(/仅支持文本文件：b.png/)).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3700)
    })
    expect(screen.queryByText(/仅支持文本文件：a.png/)).not.toBeInTheDocument()
    expect(screen.queryByText(/仅支持文本文件：b.png/)).not.toBeInTheDocument()
  })

  it('二进制乱码预警与行数预警同时可见（原单条覆盖式会互顶）', async () => {
    window.api = mockApi({
      openFile: async () => ({
        path: '/tmp/bin.log',
        name: 'bin.log',
        text: Array.from({ length: 50001 }, () => 'x').join('\n'),
        encoding: 'GBK',
        binary: true
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText(/疑似二进制文件/)).toBeInTheDocument()
    expect(screen.getByText(/行数较多/)).toBeInTheDocument()
  })

  it('提示超过 3 条时最旧的一条被顶掉', () => {
    vi.useFakeTimers()
    render(<App />)
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    const names = ['a.png', 'b.png', 'c.png', 'd.png']
    for (const n of names) {
      fireEvent.drop(pane, {
        dataTransfer: { files: [new File(['x'], n, { type: 'image/png' })] }
      })
    }
    expect(screen.queryByText(/仅支持文本文件：a.png/)).not.toBeInTheDocument()
    expect(screen.getByText(/仅支持文本文件：b.png/)).toBeInTheDocument()
    expect(screen.getByText(/仅支持文本文件：c.png/)).toBeInTheDocument()
    expect(screen.getByText(/仅支持文本文件：d.png/)).toBeInTheDocument()
  })

  it('点击 toast 动作按钮后该条立即消失', async () => {
    const showInFolder = vi.fn(async () => true)
    window.api = mockApi({
      saveReport: async () => ({ ok: true, path: 'C:/docs/DiffLens-report.html' }),
      showInFolder
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('HTML 报告'))
    expect(await screen.findByText(/报告已保存/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('打开文件夹'))
    expect(showInFolder).toHaveBeenCalled()
    expect(screen.queryByText(/报告已保存/)).not.toBeInTheDocument()
  })

  it('文件超过 10MB 时被拦截并保持空态', async () => {
    window.api = mockApi({
      openFile: async () => ({ error: 'too-large', name: 'big.log', size: 11 * 1024 * 1024 })
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText(/文件超过 10MB/)).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })

  it('读取失败时提示且保持空态', async () => {
    window.api = mockApi({ openFile: async () => ({ error: 'read-failed', name: 'x.txt' }) })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText(/文件读取失败/)).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })

  it('IPC 异常时兜底提示', async () => {
    window.api = mockApi({
      openFile: async () => {
        throw new Error('ipc boom')
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText(/文件读取失败，请重试/)).toBeInTheDocument()
  })

  it('拖放超过 10MB 的文件被拦截', async () => {
    render(<App />)
    const file = new File(['x'], 'big.log', { type: 'text/plain' })
    Object.defineProperty(file, 'size', { value: 12 * 1024 * 1024 })
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, { dataTransfer: { files: [file] } })
    expect(await screen.findByText(/文件超过 10MB/)).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })

  it('打开疑似二进制文件时加载并给出乱码预警', async () => {
    window.api = mockApi({
      openFile: async () => ({
        path: '/tmp/d',
        name: 'data',
        text: 'zz',
        encoding: 'GBK',
        binary: true
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText(/疑似二进制文件/)).toBeInTheDocument()
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
  })

  it('拖放疑似二进制文件时给出乱码预警', async () => {
    window.api = mockApi({
      decodeBuffer: async () => ({ text: 'zz', encoding: 'GBK', binary: true })
    })
    render(<App />)
    const file = new File(['zz'], 'noext', { type: '' })
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, { dataTransfer: { files: [file] } })
    expect(await screen.findByText(/疑似二进制文件/)).toBeInTheDocument()
  })

  it('拖放文件解码与兜底读取均失败时提示且保持空态', async () => {
    window.api = mockApi({
      decodeBuffer: async () => {
        throw new Error('boom')
      }
    })
    vi.spyOn(File.prototype, 'text').mockRejectedValue(new Error('io'))
    render(<App />)
    const file = new File(['x'], 'bad.txt', { type: 'text/plain' })
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, { dataTransfer: { files: [file] } })
    expect(await screen.findByText(/文件读取失败：bad\.txt/)).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })

  it('多文件拖拽时提示已取第一个并加载首个文件', async () => {
    render(<App />)
    const first = new File(['a'], 'first.txt', { type: 'text/plain' })
    const second = new File(['b'], 'second.txt', { type: 'text/plain' })
    const pane = screen.getByText(/选择左侧文件/).closest('.pane-empty') as Element
    fireEvent.drop(pane, { dataTransfer: { files: [first, second] } })
    expect(await screen.findByText(/一次只能导入一个文件/)).toBeInTheDocument()
    expect(screen.getAllByText('first.txt').length).toBeGreaterThan(0)
  })

  it('导出时 IPC 异常给出失败提示', async () => {
    window.api = mockApi({
      saveReport: async () => {
        throw new Error('boom')
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('HTML 报告'))
    expect(await screen.findByText(/导出失败/)).toBeInTheDocument()
  })
})

describe('App - 大输入与 worker 回退', () => {
  it('超过快路径阈值的文件在无 Worker 环境去抖到期后回退同步计算', async () => {
    const big = Array.from({ length: 2100 }, (_, i) => `row${i}`).join('\n')
    window.api = mockApi({
      openFile: async () => ({
        path: '/tmp/big.txt',
        name: 'big.txt',
        text: big,
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
    // jsdom 无 Worker：去抖到期后同步回退完成计算，行渲染且计算中遮罩消失
    expect(await screen.findByText(/row0/)).toBeInTheDocument()
    expect(screen.queryByText('正在计算差异…')).not.toBeInTheDocument()
  })
})

describe('App - 粘贴下拉交互', () => {
  it('按 Esc 关闭粘贴下拉', () => {
    render(<App />)
    fireEvent.click(screen.getByText('粘贴文本'))
    expect(screen.getByText('粘贴到左侧')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('粘贴到左侧')).not.toBeInTheDocument()
  })

  it('点击外部区域关闭粘贴下拉', () => {
    render(<App />)
    fireEvent.click(screen.getByText('粘贴文本'))
    expect(screen.getByText('粘贴到左侧')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('粘贴到左侧')).not.toBeInTheDocument()
  })
})

describe('App - 手动粘贴文本', () => {
  it('粘贴文本到左侧并开始对比', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('粘贴文本'))
    fireEvent.click(screen.getByText('粘贴到左侧'))
    const ta = screen.getByPlaceholderText(/粘贴或输入/)
    fireEvent.change(ta, { target: { value: 'alpha\nbeta' } })
    fireEvent.click(screen.getByText('开始对比'))
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
    expect(screen.getAllByText('手动文本').length).toBeGreaterThan(0)
  })

  it('粘贴到右侧入口可用', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('粘贴文本'))
    fireEvent.click(screen.getByText('粘贴到右侧'))
    expect(screen.getByText('粘贴右侧文本')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/粘贴或输入/), {
      target: { value: 'x' }
    })
    fireEvent.click(screen.getByText('开始对比'))
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
  })

  it('粘贴内容超过 10MB 被拒绝且弹窗保持打开', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('粘贴文本'))
    fireEvent.click(screen.getByText('粘贴到左侧'))
    fireEvent.change(screen.getByPlaceholderText(/粘贴或输入/), {
      target: { value: 'x'.repeat(10 * 1024 * 1024 + 1) }
    })
    fireEvent.click(screen.getByText('开始对比'))
    expect(await screen.findByText(/粘贴内容超过 10MB/)).toBeInTheDocument()
    // 弹窗保持打开，未进入对比视图
    expect(screen.getByText('开始对比')).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })

  it('粘贴空白内容被拒绝且弹窗保持打开', () => {
    render(<App />)
    fireEvent.click(screen.getByText('粘贴文本'))
    fireEvent.click(screen.getByText('粘贴到左侧'))
    fireEvent.change(screen.getByPlaceholderText(/粘贴或输入/), {
      target: { value: '  \n  ' }
    })
    fireEvent.click(screen.getByText('开始对比'))
    expect(screen.getByText(/内容为空/)).toBeInTheDocument()
    expect(screen.getByText('开始对比')).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
  })
})

describe('App - 仅看差异视图', () => {
  async function loadBothSides() {
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/a.txt',
              name: 'a.txt',
              text: 'same\ndiff-left\nsame2',
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/b.txt',
              name: 'b.txt',
              text: 'same\ndiff-right\nsame2',
              encoding: 'UTF-8',
              binary: false
            }
    })
    const utils = render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.txt')
    return utils
  }

  it('开启后未更改行被折叠并出现折叠提示', async () => {
    const { container } = await loadBothSides()
    // 默认视图能看到未更改行
    expect(screen.getAllByText('same').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByLabelText('仅看差异'))
    // 未更改行被折叠
    expect(screen.queryAllByText('same')).toHaveLength(0)
    expect(screen.queryAllByText('same2')).toHaveLength(0)
    // 差异行仍在（修改行左右两栏各一条）；same 与 same2 是两个独立折叠段，左右两栏共 4 条提示
    expect(container.querySelectorAll('.diff-row.modified').length).toBe(2)
    expect(screen.getAllByText(/已折叠 1 行相同内容/).length).toBe(4)
  })

  it('关闭开关后恢复全量视图', async () => {
    await loadBothSides()
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(screen.queryAllByText('same')).toHaveLength(0)
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(screen.getAllByText('same').length).toBeGreaterThan(0)
  })
})

describe('App - 忽略所有空白', () => {
  it('开启后仅行内空白不同的两侧文本判为完全一致', async () => {
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/a.js',
              name: 'a.js',
              text: 'const  x  =  1;\nif (x) {\n  doSomething( x )\n}',
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/b.js',
              name: 'b.js',
              text: 'const x = 1;\nif(x){\n\tdoSomething(x)\n}',
              encoding: 'UTF-8',
              binary: false
            }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.js')
    // 默认严格对比：报差异
    expect(screen.getByText('有差异')).toBeInTheDocument()
    // 开启忽略所有空白后：判为完全一致
    fireEvent.click(screen.getByLabelText('忽略所有空白'))
    expect(await screen.findByText('两文件内容完全一致')).toBeInTheDocument()
  })

  it('导出报告携带比较选项说明', async () => {
    let saved = ''
    window.api = mockApi({
      openFile: async () => ({
        path: '/tmp/a.txt',
        name: 'a.txt',
        text: 'line1\nline2',
        encoding: 'UTF-8',
        binary: false
      }),
      saveReport: async (content: string) => {
        saved = content
        return { ok: true, path: 'C:/docs/r.txt' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('纯文本'))
    await screen.findByText(/报告已保存/)
    expect(saved).toContain('比较选项：无（严格逐字符对比）')
  })
})

describe('App - F7 / Shift+F7 差异导航快捷键', () => {
  it('F7 跳到下一处差异，Shift+F7 回到上一处', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('1 / 2')
    fireEvent.keyDown(window, { key: 'F7' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'F7', shiftKey: true })
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('粘贴弹窗打开时 F7 不触发导航', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('1 / 2')
    fireEvent.click(screen.getByText('粘贴文本'))
    fireEvent.click(screen.getByText('粘贴到左侧'))
    expect(screen.getByText('开始对比')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'F7' })
    // 导航未被触发，计数保持 1 / 2
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('右键菜单打开时 F7 不触发导航', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('1 / 2')
    fireEvent.contextMenu((await screen.findAllByText(/line1/))[0])
    expect(await screen.findByText('复制左侧此行内容')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'F7' })
    // 导航未被触发，计数保持 1 / 2
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })
})

describe('App - 字符级对比', () => {
  it('开启后跨行重组判为完全一致（行级对比的边界在此补全）', async () => {
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? { path: '/tmp/a.txt', name: 'a.txt', text: 'ab cd', encoding: 'UTF-8', binary: false }
          : { path: '/tmp/b.txt', name: 'b.txt', text: 'ab\ncd', encoding: 'UTF-8', binary: false }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.txt')
    // 默认行级对比：换行结构差异报“有差异”
    expect(screen.getByText('有差异')).toBeInTheDocument()
    // 开启字符级对比后：判为完全一致
    fireEvent.click(screen.getByLabelText('字符级对比'))
    expect(await screen.findByText('两文件内容完全一致')).toBeInTheDocument()
  })

  it('开启时三个空白选项被禁用', async () => {
    window.api = mockApi()
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    expect(screen.getByLabelText('忽略行首尾空白')).toBeEnabled()
    fireEvent.click(screen.getByLabelText('字符级对比'))
    expect(screen.getByLabelText(/^忽略行首尾空白/)).toBeDisabled()
    expect(screen.getByLabelText(/^忽略空行/)).toBeDisabled()
    expect(screen.getByLabelText(/^忽略所有空白/)).toBeDisabled()
    expect(screen.getByLabelText('忽略大小写')).toBeEnabled()
  })

  // 字符级开启时空白选项 label 带“已包含”徽标，getByLabelText 需正则前缀匹配
  it('先勾选空白选项再开启字符级：灰显勾选+已包含徽标，关闭后恢复原状态', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    // 用户先勾选“忽略所有空白”与“忽略空行”
    fireEvent.click(screen.getByLabelText('忽略所有空白'))
    fireEvent.click(screen.getByLabelText('忽略空行'))
    expect(screen.getByLabelText('忽略所有空白')).toBeChecked()
    // 开启字符级：三个空白选项全部灰显勾选（语义已包含）并带徽标
    fireEvent.click(screen.getByLabelText('字符级对比'))
    expect(screen.getByLabelText(/^忽略行首尾空白/)).toBeChecked()
    expect(screen.getByLabelText(/^忽略空行/)).toBeChecked()
    expect(screen.getByLabelText(/^忽略所有空白/)).toBeChecked()
    expect(screen.getAllByText('已包含')).toHaveLength(3)
    // 关闭字符级：回到用户自己的勾选状态（忽略所有空白与忽略空行仍勾选，行首尾空白未勾选）
    fireEvent.click(screen.getByLabelText('字符级对比'))
    expect(screen.getByLabelText('忽略行首尾空白')).not.toBeChecked()
    expect(screen.getByLabelText('忽略空行')).toBeChecked()
    expect(screen.getByLabelText('忽略所有空白')).toBeChecked()
    expect(screen.queryByText('已包含')).not.toBeInTheDocument()
  })

  it('点击被字符级包含的空白选项弹出解释提示', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByLabelText('字符级对比'))
    fireEvent.click(screen.getByLabelText(/^忽略所有空白/))
    expect(await screen.findByText(/「忽略所有空白」已包含在字符级对比中/)).toBeInTheDocument()
  })

  it('差异过大时自动降级行级并给出提示', async () => {
    // 单行全差异构造：变更组流 = 25001 + 25001 > 5 万上限；
    // 总行数 1 未超过快路径阈值，同步计算即时降级
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/big.txt',
              name: 'big.txt',
              text: 'a'.repeat(25001),
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/big2.txt',
              name: 'big2.txt',
              text: 'b'.repeat(25001),
              encoding: 'UTF-8',
              binary: false
            }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('big2.txt')
    fireEvent.click(screen.getByLabelText('字符级对比'))
    expect(await screen.findByText(/已自动降级为行级对比/)).toBeInTheDocument()
    // 降级状态在工具栏可见：字符级开关旁出现“已降级”标记
    expect(await screen.findByText('已降级')).toBeInTheDocument()
  })

  it('混合场景部分降级：小差异组字符级 + 超限组行级，标记与提示可见', async () => {
    // mid 锚行分隔两组：cat↔cap 字符级；单行全差异超 5 万 → 行级（部分降级）
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/p1.txt',
              name: 'p1.txt',
              text: `head\ncat\nmid\n${'a'.repeat(25001)}`,
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/p2.txt',
              name: 'p2.txt',
              text: `head\ncap\nmid\n${'b'.repeat(25001)}`,
              encoding: 'UTF-8',
              binary: false
            }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('p2.txt')
    fireEvent.click(screen.getByLabelText('字符级对比'))
    // 无整体降级；出现部分降级标记与提示
    await screen.findByText('有差异')
    expect(screen.queryByText(/已自动降级为行级对比/)).not.toBeInTheDocument()
    expect(screen.queryByText('已降级')).not.toBeInTheDocument()
    expect(await screen.findByText('部分降级')).toBeInTheDocument()
    expect(await screen.findByText(/部分差异块过大已按行级对比/)).toBeInTheDocument()
  })

  it('部分降级时导出报告携带部分降级说明', async () => {
    let saved = ''
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/p1.txt',
              name: 'p1.txt',
              text: `head\ncat\nmid\n${'a'.repeat(25001)}`,
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/p2.txt',
              name: 'p2.txt',
              text: `head\ncap\nmid\n${'b'.repeat(25001)}`,
              encoding: 'UTF-8',
              binary: false
            },
      saveReport: async (content: string) => {
        saved = content
        return { ok: true, path: 'C:/docs/r.txt' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('p2.txt')
    fireEvent.click(screen.getByLabelText('字符级对比'))
    await screen.findByText('部分降级')
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('纯文本'))
    await screen.findByText(/报告已保存/)
    expect(saved).toContain(
      '比较选项：字符级对比（忽略全部空白与换行；部分差异过大的块按行级对比）'
    )
  })

  it('大文件仅局部差异：字符级分块完成，不降级且精确定位差异', async () => {
    // 2000 行 × 50 字符 ≈ 10 万归一化字符（远超单组 5 万上限），仅一行不同：
    // 行锚定后唯一变更组只有该行，字符级正常完成（旧实现必降级）
    const base = Array.from({ length: 2000 }, (_, i) => `line-${i}-${'x'.repeat(40)}`)
    const modified = [...base]
    modified[1000] = `line-1000-${'y'.repeat(40)}`
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/a.txt',
              name: 'a.txt',
              text: base.join('\n'),
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/b.txt',
              name: 'b.txt',
              text: modified.join('\n'),
              encoding: 'UTF-8',
              binary: false
            }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.txt')
    fireEvent.click(screen.getByLabelText('字符级对比'))
    // 无降级提示与标记（等去抖到期、后台回退同步计算完成）
    await screen.findByText('有差异')
    expect(screen.queryByText(/已自动降级/)).not.toBeInTheDocument()
    expect(screen.queryByText('已降级')).not.toBeInTheDocument()
    // 差异统计精确：一处修改
    expect(screen.getByText('~1')).toBeInTheDocument()
  })

  it('导出报告携带字符级对比说明', async () => {
    let saved = ''
    window.api = mockApi({
      openFile: async () => ({
        path: '/tmp/a.txt',
        name: 'a.txt',
        text: 'line1\nline2',
        encoding: 'UTF-8',
        binary: false
      }),
      saveReport: async (content: string) => {
        saved = content
        return { ok: true, path: 'C:/docs/r.txt' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByLabelText('字符级对比'))
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('纯文本'))
    await screen.findByText(/报告已保存/)
    expect(saved).toContain(
      '比较选项：字符级对比（忽略全部空白与换行，大内容自动分块计算，预算随规模自适应）'
    )
  })

  it('降级后导出报告按实际生效的行级语义描述选项', async () => {
    let saved = ''
    // 单行全差异（变更组流超 5 万上限）：字符级降级为行级语义
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/big.txt',
              name: 'big.txt',
              text: 'a'.repeat(25001),
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/b.txt',
              name: 'b.txt',
              text: 'b'.repeat(25001),
              encoding: 'UTF-8',
              binary: false
            },
      saveReport: async (content: string) => {
        saved = content
        return { ok: true, path: 'C:/docs/r.txt' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.txt')
    fireEvent.click(screen.getByLabelText('字符级对比'))
    await screen.findByText(/已自动降级为行级对比/)
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('纯文本'))
    await screen.findByText(/报告已保存/)
    expect(saved).toContain('比较选项：忽略所有空白、忽略空行')
  })
})

describe('App - 单文件视图搜索', () => {
  /** 两侧同文本：find 命中第 2、5 行；alpha 命中第 1、3 行 */
  const SEARCH_TEXT = 'alpha\nfind here\nalpha\ngamma\nfind there\ndelta'

  async function loadSearchFixture() {
    window.api = mockApi({
      openFile: async () => ({
        path: '/tmp/a.txt',
        name: 'a.txt',
        text: SEARCH_TEXT,
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('两文件内容完全一致')
  }

  const searchInput = (): HTMLElement => screen.getByPlaceholderText('搜索内容… (Ctrl+F)')

  it('输入关键字：命中计数显示且第一个命中行定位高亮', async () => {
    await loadSearchFixture()
    fireEvent.change(searchInput(), { target: { value: 'find' } })
    expect(await screen.findByText('1 / 2')).toBeInTheDocument()
    // 第一命中行 active（左右两栏各一行）：左侧行号为 2
    const actives = document.querySelectorAll('.diff-row.active')
    expect(actives.length).toBe(2)
    expect(actives[0].querySelector('.ln')?.textContent).toBe('2')
  })

  it('Enter 推进到下一命中（行号定位随动），Shift+Enter 回退', async () => {
    await loadSearchFixture()
    fireEvent.change(searchInput(), { target: { value: 'find' } })
    await screen.findByText('1 / 2')
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    expect(await screen.findByText('2 / 2')).toBeInTheDocument()
    expect(document.querySelector('.diff-row.active .ln')?.textContent).toBe('5')
    fireEvent.keyDown(searchInput(), { key: 'Enter', shiftKey: true })
    expect(await screen.findByText('1 / 2')).toBeInTheDocument()
    expect(document.querySelector('.diff-row.active .ln')?.textContent).toBe('2')
  })

  it('最后一个命中再 Enter 循环回第一个', async () => {
    await loadSearchFixture()
    fireEvent.change(searchInput(), { target: { value: 'find' } })
    await screen.findByText('1 / 2')
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    await screen.findByText('2 / 2')
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    expect(await screen.findByText('1 / 2')).toBeInTheDocument()
  })

  it('大小写不敏感匹配', async () => {
    await loadSearchFixture()
    fireEvent.change(searchInput(), { target: { value: 'ALPHA' } })
    expect(await screen.findByText('1 / 2')).toBeInTheDocument()
  })

  it('无命中显示 0 / 0，Enter 不崩溃不推进', async () => {
    await loadSearchFixture()
    fireEvent.change(searchInput(), { target: { value: 'zzz' } })
    // 两侧完全一致时差异导航计数同为 0 / 0，用 selector 限定搜索计数
    expect(await screen.findByText('0 / 0', { selector: '.search-count' })).toBeInTheDocument()
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    expect(screen.getByText('0 / 0', { selector: '.search-count' })).toBeInTheDocument()
  })

  it('Esc 清空关键字并复位计数', async () => {
    await loadSearchFixture()
    fireEvent.change(searchInput(), { target: { value: 'find' } })
    await screen.findByText('1 / 2')
    fireEvent.keyDown(searchInput(), { key: 'Escape' })
    expect(searchInput()).toHaveValue('')
    expect(screen.queryByText('1 / 2')).not.toBeInTheDocument()
  })

  it('Ctrl+F 聚焦搜索框', async () => {
    await loadSearchFixture()
    expect(document.activeElement).not.toBe(searchInput())
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(searchInput())
  })

  it('命中行被“仅看差异”折叠：计数仍统计全部行，跳转提示且不推进', async () => {
    await loadSearchFixture()
    // 两侧完全一致：开启仅看差异后全部行折叠
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(screen.getAllByText(/已折叠/).length).toBeGreaterThan(0)
    fireEvent.change(searchInput(), { target: { value: 'find' } })
    // 折叠行仍计入计数（搜索与视图过滤独立）
    expect(await screen.findByText('1 / 2')).toBeInTheDocument()
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    expect(await screen.findByText(/折叠段内/)).toBeInTheDocument()
    // 计数不推进
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('切选项重算后命中计数与 active 高亮行保持一致（0.10.4 修复）', async () => {
    await loadSearchFixture()
    fireEvent.change(searchInput(), { target: { value: 'find' } })
    await screen.findByText('1 / 2')
    // 推进到第 2 个命中（行 5）
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    await screen.findByText('2 / 2')
    expect(document.querySelector('.diff-row.active .ln')?.textContent).toBe('5')
    // 切比较选项触发 diff 重算：rows 重建（行 id 全部重新编号），命中集随之重建。
    // 缺陷版本 active 高亮丢失（旧 id 不再存在）而计数仍显示 2 / 2——两者脱节
    fireEvent.click(screen.getByLabelText('忽略大小写'))
    expect(await screen.findByText('两文件内容完全一致')).toBeInTheDocument()
    // 计数与高亮行一致：仍为第 2 个命中（行 5）
    expect(screen.getByText('2 / 2', { selector: '.search-count' })).toBeInTheDocument()
    expect(document.querySelector('.diff-row.active .ln')?.textContent).toBe('5')
  })

  it('打开新文件使命中归零：计数 0 / 0 且 active 高亮清空（回归锚）', async () => {
    // 命中归零分支的重定位语义：activeRowId 置 null（与缺陷修复前的清空行为一致）
    let openCall = 0
    window.api = mockApi({
      openFile: async () => {
        openCall++
        return openCall === 1
          ? {
              path: '/tmp/a.txt',
              name: 'a.txt',
              text: 'find here',
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/a2.txt',
              name: 'a2.txt',
              text: 'plain stuff',
              encoding: 'UTF-8',
              binary: false
            }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findByText('有差异')
    // 左侧 'find here' 命中一处（与差异导航计数区分，selector 限定搜索计数）
    fireEvent.change(searchInput(), { target: { value: 'find' } })
    expect(await screen.findByText('1 / 1', { selector: '.search-count' })).toBeInTheDocument()
    expect(document.querySelectorAll('.diff-row.active').length).toBeGreaterThan(0)
    // 重新选择左侧（新内容不含关键字）：diff 重算后命中归零，高亮随之清空
    fireEvent.click(screen.getAllByText('重新选择')[0])
    await waitFor(() => {
      expect(screen.getByText('0 / 0', { selector: '.search-count' })).toBeInTheDocument()
      expect(document.querySelectorAll('.diff-row.active')).toHaveLength(0)
    })
  })
})

describe('App - 大文件 worker 结果到达后的搜索定位（0.12.1）', () => {
  it('计算期间输入搜索：结果到达后计数与 active 高亮同步指向首个命中', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) =>
      i === 1 ? 'target line here' : `line-${i}-content`
    )
    const text = lines.join('\n')
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? { path: '/tmp/big-l.txt', name: 'big-l.txt', text, encoding: 'UTF-8', binary: false }
          : { path: '/tmp/big-r.txt', name: 'big-r.txt', text, encoding: 'UTF-8', binary: false }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('big-r.txt')
    // 重输入进入 worker 重路径（jsdom 无 Worker，去抖后回退同步计算）
    const input = screen.getByPlaceholderText('搜索内容… (Ctrl+F)')
    fireEvent.change(input, { target: { value: 'target' } })
    // 结果到达后：命中计数与 active 行必须同时存在（缺陷版本只有计数没有高亮）
    expect(await screen.findByText('1 / 1', { selector: '.search-count' })).toBeInTheDocument()
    await waitFor(() => {
      expect(document.querySelectorAll('.diff-row.active').length).toBeGreaterThan(0)
    })
    expect(document.querySelector('.diff-row.active .ln')?.textContent).toBe('2')
  })
})

describe('App - 状态栏行数', () => {
  // 文件名在 <b> 子元素内，getByText 只拼直接文本子节点无法跨元素匹配，
  // 用 container 取 .status-item 的完整 textContent 断言（含换行空白，正则放宽）
  it('加载文件后状态栏显示对应行数（切分规则与引擎一致）', async () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    const items = () =>
      Array.from(container.querySelectorAll('.status-item'), (e) => e.textContent ?? '')
    // mockApi 默认返回 'line1\nline2' = 2 行；右侧未加载无行数
    expect(items()[0]).toMatch(/左：\s*a\.txt\s*·\s*2 行/)
    expect(items()[1]).toMatch(/右：\s*—$/)
  })

  it('两侧均加载时各自显示行数', async () => {
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? { path: '/tmp/a.txt', name: 'a.txt', text: 'a\nb\nc', encoding: 'UTF-8', binary: false }
          : { path: '/tmp/b.txt', name: 'b.txt', text: 'x\ny', encoding: 'UTF-8', binary: false }
    })
    const { container } = render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.txt')
    const items = () =>
      Array.from(container.querySelectorAll('.status-item'), (e) => e.textContent ?? '')
    expect(items()[0]).toMatch(/左：\s*a\.txt\s*·\s*3 行/)
    expect(items()[1]).toMatch(/右：\s*b\.txt\s*·\s*2 行/)
  })

  it('清空后行数展示随空态消失', async () => {
    const { container } = render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    const items = () =>
      Array.from(container.querySelectorAll('.status-item'), (e) => e.textContent ?? '')
    expect(items()[0]).toMatch(/左：\s*a\.txt\s*·\s*2 行/)
    fireEvent.click(screen.getByText('清空'))
    await screen.findByText(/再次点击/)
    fireEvent.click(screen.getByText('清空'))
    await screen.findByText(/选择左侧文件/)
    expect(items()[0]).not.toMatch(/·\s*2 行/)
  })
})

describe('App - 交换左右侧', () => {
  it('交换后左右面板文件互换', async () => {
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? { path: '/tmp/a.txt', name: 'a.txt', text: 'aaa', encoding: 'UTF-8', binary: false }
          : { path: '/tmp/b.txt', name: 'b.txt', text: 'bbb', encoding: 'UTF-8', binary: false }
    })
    const { container } = render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.txt')
    const files = () =>
      Array.from(container.querySelectorAll('.pane-file')).map((e) => e.textContent)
    expect(files()).toEqual(['a.txt', 'b.txt'])
    fireEvent.click(screen.getByText('⇄ 交换左右'))
    expect(files()).toEqual(['b.txt', 'a.txt'])
  })
})

describe('App - 偏好持久化（比较选项 + 仅看差异）', () => {
  const KEY = 'difflens.prefs.v1'

  it('启动时恢复上次保存的比较选项与仅看差异开关', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        options: {
          trimWhitespace: false,
          ignoreCase: false,
          ignoreBlankLines: false,
          ignoreAllWhitespace: true,
          charMode: false
        },
        onlyDiff: true
      })
    )
    window.api = mockApi({
      openFile: async (side) =>
        side === 'left'
          ? {
              path: '/tmp/a.txt',
              name: 'a.txt',
              text: 'same\ndiffL',
              encoding: 'UTF-8',
              binary: false
            }
          : {
              path: '/tmp/b.txt',
              name: 'b.txt',
              text: 'same\ndiffR',
              encoding: 'UTF-8',
              binary: false
            }
    })
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    await screen.findAllByText('b.txt')
    // 比较选项恢复：忽略所有空白已勾选
    expect(screen.getByLabelText('忽略所有空白')).toBeChecked()
    // 仅看差异恢复：未更改行被折叠（same 不再展示）
    expect(screen.queryAllByText('same')).toHaveLength(0)
    // 关闭开关后恢复全量视图
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(screen.getAllByText('same').length).toBeGreaterThan(0)
  })

  it('损坏的持久化数据回退默认选项且不崩溃', async () => {
    window.localStorage.setItem(KEY, '{broken json!!')
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
    expect(screen.getByLabelText('忽略所有空白')).not.toBeChecked()
    expect(screen.getByLabelText('字符级对比')).not.toBeChecked()
    expect(screen.getByLabelText('仅看差异')).not.toBeChecked()
  })

  it('非布尔字段被防御性忽略（回退关闭）', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ options: { ignoreCase: 'yes', charMode: 1 }, onlyDiff: 'true' })
    )
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    expect(await screen.findByText('导出报告')).toBeInTheDocument()
    expect(screen.getByLabelText('忽略大小写')).not.toBeChecked()
    expect(screen.getByLabelText('字符级对比')).not.toBeChecked()
    expect(screen.getByLabelText('仅看差异')).not.toBeChecked()
  })

  it('切换选项后写回持久化存储', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByLabelText('忽略大小写'))
    const saved1 = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    expect(saved1.options.ignoreCase).toBe(true)
    fireEvent.click(screen.getByLabelText('仅看差异'))
    const saved2 = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    expect(saved2.onlyDiff).toBe(true)
  })
})

describe('App - 文件夹对比', () => {
  const folderEntries = [
    { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
    { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 4 },
    { rel: 'c.txt', status: 'left-only' as const, leftSize: 2, rightSize: null }
  ]

  /** 进入文件夹对比模式的公共流程：依次选择左右目录并返回固定扫描结果 */
  async function enterFolderMode() {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: folderEntries, truncated: false, total: 3 })
    })
    const utils = render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('C:/left-dir')
    return utils
  }

  it('依次选择两侧文件夹后进入文件夹模式：路径卡片、统计与状态栏', async () => {
    await enterFolderMode()
    expect(screen.getAllByText('D:/right-dir').length).toBeGreaterThan(0)
    expect(screen.getByText('相同 1')).toBeInTheDocument()
    expect(screen.getByText('不同 1')).toBeInTheDocument()
    expect(screen.getByText('仅左 1')).toBeInTheDocument()
    // 默认仅看差异：same 条目被过滤
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    // 状态栏切换为文件夹模式
    expect(screen.getByText('文件夹对比 · 双击条目进入单文件对比')).toBeInTheDocument()
  })

  it('第一次选择取消不进入文件夹模式', async () => {
    window.api = mockApi({ pickFolder: async () => null })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    expect(await screen.findByText(/选择左侧文件/)).toBeInTheDocument()
    expect(screen.queryByText('返回文件对比')).not.toBeInTheDocument()
  })

  it('第二次选择取消不进入文件夹模式', async () => {
    const dirs = ['C:/left-dir', null]
    let call = 0
    window.api = mockApi({ pickFolder: async () => dirs[call++] })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    expect(await screen.findByText(/选择左侧文件/)).toBeInTheDocument()
  })

  it('扫描失败给出提示且不进入文件夹模式', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ error: 'scan-failed' as const })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    expect(await screen.findByText(/文件夹扫描失败，请检查目录/)).toBeInTheDocument()
    expect(screen.queryByText('返回文件对比')).not.toBeInTheDocument()
  })

  it('双击差异条目加载两侧文件进入单文件对比，可返回文件夹', async () => {
    window.api = mockApi({
      pickFolder: async () => null,
      scanFolder: async () => ({ entries: folderEntries, truncated: false, total: 3 }),
      readByPath: async (p: string) => {
        if (p === 'C:/left-dir/b.txt') {
          return { path: p, name: 'b.txt', text: 'same\naaa', encoding: 'UTF-8', binary: false }
        }
        if (p === 'D:/right-dir/b.txt') {
          return { path: p, name: 'b.txt', text: 'same\nbbb', encoding: 'UTF-8', binary: false }
        }
        return null
      }
    })
    // 先进入文件夹模式（手动设置流程），再双击
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api.pickFolder = async () => dirs[call++] ?? null
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.dblClick(screen.getByText('b.txt'))
    // 进入单文件对比视图：两侧内容渲染 + 差异统计（aaa/bbb 整词替换，词级高亮不拆分）
    expect(await screen.findByText('aaa')).toBeInTheDocument()
    expect(screen.getByText('bbb')).toBeInTheDocument()
    expect(screen.getByText('有差异')).toBeInTheDocument()
    // header 出现返回文件夹按钮
    expect(screen.getByText('← 返回文件夹对比')).toBeInTheDocument()
    // 返回文件夹：清空两侧面板，回到文件夹列表
    fireEvent.click(screen.getByText('← 返回文件夹对比'))
    expect(await screen.findByText('相同 1')).toBeInTheDocument()
    expect(screen.queryByText('aaa')).not.toBeInTheDocument()
  })

  it('双击仅左侧条目：加载左侧并清空右侧', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: folderEntries, truncated: false, total: 3 }),
      readByPath: async (p: string) =>
        p === 'C:/left-dir/c.txt'
          ? { path: p, name: 'c.txt', text: 'only-c', encoding: 'UTF-8', binary: false }
          : null
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('c.txt')
    fireEvent.dblClick(screen.getByText('c.txt'))
    expect(await screen.findByText('only-c')).toBeInTheDocument()
    // 右侧面板为空槽（内容为 only-c 的删除行）
    const paneFiles = Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)
    expect(paneFiles[0]).toBe('c.txt')
    expect(paneFiles[1]).toBe('（未选择）')
  })

  it('返回文件对比后清空文件夹状态回到单文件空态', async () => {
    await enterFolderMode()
    fireEvent.click(screen.getByText('返回文件对比'))
    expect(await screen.findByText(/选择左侧文件/)).toBeInTheDocument()
    // header 不再出现返回文件夹按钮（文件夹状态已清空）
    expect(screen.queryByText('← 返回文件夹对比')).not.toBeInTheDocument()
  })

  it('先有文件对比再进入文件夹模式：返回文件对比后旧面板内容一并清空', async () => {
    // 场景：正在对比 a.txt → 点「对比文件夹」→ 退出：应回到空态而非残留旧对比
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: folderEntries, truncated: false, total: 3 })
    })
    render(<App />)
    // 先加载左侧文件进入对比态
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    // 进入文件夹模式
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('相同 1')
    // 退出文件夹对比：旧文件内容不残留
    fireEvent.click(screen.getByText('返回文件对比'))
    expect(await screen.findByText(/选择左侧文件/)).toBeInTheDocument()
    expect(screen.queryByText('导出报告')).not.toBeInTheDocument()
    expect(screen.queryByText(/line1/)).not.toBeInTheDocument()
  })

  it('两次选择同一文件夹给出防呆提示且不进入文件夹模式', async () => {
    window.api = mockApi({
      pickFolder: async () => 'C:/same-dir',
      scanFolder: async () => ({ entries: folderEntries, truncated: false, total: 3 })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    expect(await screen.findByText(/两次选择的是同一个文件夹/)).toBeInTheDocument()
    // 未进入文件夹模式，也未触发扫描
    expect(screen.getByText(/选择左侧文件/)).toBeInTheDocument()
    expect(screen.queryByText('返回文件对比')).not.toBeInTheDocument()
  })

  it('双击条目一侧读取失败：失败侧清空显示未选择，不残留旧对比内容', async () => {
    // 场景：先在 file 模式加载左侧旧文件 → 进文件夹模式 → 双击条目，
    // 右侧 readByPath 返回读取失败 → 右侧必须清空（不能残留左侧旧对比的右侧内容）
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: folderEntries, truncated: false, total: 3 }),
      readByPath: async (p: string) =>
        p === 'C:/left-dir/b.txt'
          ? { path: p, name: 'b.txt', text: 'fresh-left', encoding: 'UTF-8', binary: false }
          : { error: 'read-failed' as const, name: 'b.txt' }
    })
    render(<App />)
    // 先加载两侧旧文件（默认 mock 两侧均为 a.txt / line1 line2，制造潜在残留源）
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    fireEvent.click(screen.getByText('打开右侧'))
    // 双侧加载完成（相同内容 → 完全一致徽章出现）
    await screen.findByText('两文件内容完全一致')
    // 进入文件夹模式（此路径下旧面板内容未清），双击 b.txt：左侧成功、右侧读取失败
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.dblClick(screen.getByText('b.txt'))
    // 左侧为新条目内容，右侧清空为未选择（不残留旧对比内容）
    expect(await screen.findByText('fresh-left')).toBeInTheDocument()
    const paneFiles = Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)
    expect(paneFiles[0]).toBe('b.txt')
    expect(paneFiles[1]).toBe('（未选择）')
    expect(screen.queryByText('line2')).not.toBeInTheDocument()
  })

  it('双击条目一侧 IPC 异常：同样清空失败侧并给出提示', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: folderEntries, truncated: false, total: 3 }),
      readByPath: async (p: string) => {
        if (p === 'D:/right-dir/b.txt') throw new Error('ipc boom')
        return { path: p, name: 'b.txt', text: 'left-ok', encoding: 'UTF-8', binary: false }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.dblClick(screen.getByText('b.txt'))
    expect(await screen.findByText(/文件读取失败，请重试/)).toBeInTheDocument()
    const paneFiles = Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)
    expect(paneFiles[0]).toBe('b.txt')
    expect(paneFiles[1]).toBe('（未选择）')
  })
})

describe('App - 文件夹条目快速切换竞态（0.12.1）', () => {
  it('慢的旧条目读取不覆盖后打开的新条目', async () => {
    const entries = [
      { rel: 'a.txt', status: 'different' as const, leftSize: 1, rightSize: 2 },
      { rel: 'b.txt', status: 'different' as const, leftSize: 1, rightSize: 2 }
    ]
    const resolvers = new Map<
      string,
      (v: Awaited<ReturnType<typeof window.api.readByPath>>) => void
    >()
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let pick = 0
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: entries.length }),
      readByPath: (p: string) =>
        new Promise<Awaited<ReturnType<typeof window.api.readByPath>>>((resolve) => {
          resolvers.set(p, resolve)
        })
    })
    const fileData = (p: string) => ({
      path: p,
      name: p.split('/').pop() ?? '',
      text: `content of ${p}`,
      encoding: 'UTF-8',
      binary: false
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('a.txt')
    fireEvent.dblClick(screen.getByText('a.txt'))
    fireEvent.dblClick(screen.getByText('b.txt'))
    // 两个左侧读取都在途；先完成 b 的两侧，再完成慢的 a
    await waitFor(() => expect(resolvers.has('C:/left-dir/b.txt')).toBe(true))
    await act(async () => {
      resolvers.get('C:/left-dir/b.txt')!(fileData('C:/left-dir/b.txt'))
    })
    await waitFor(() => expect(resolvers.has('D:/right-dir/b.txt')).toBe(true))
    await act(async () => {
      resolvers.get('D:/right-dir/b.txt')!(fileData('D:/right-dir/b.txt'))
    })
    await waitFor(() =>
      expect(Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)).toEqual(
        ['b.txt', 'b.txt']
      )
    )
    // a 的左侧此刻才返回：过期请求不得改写任何一侧
    await act(async () => {
      resolvers.get('C:/left-dir/a.txt')?.(fileData('C:/left-dir/a.txt'))
    })
    expect(Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)).toEqual([
      'b.txt',
      'b.txt'
    ])
  })
})

describe('App - 文件夹模式搜索与换目录状态重置（0.10.5）', () => {
  const entries = [
    { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
    { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 4 },
    { rel: 'c.txt', status: 'left-only' as const, leftSize: 2, rightSize: null }
  ]

  it('Ctrl+F 聚焦文件名搜索框并 Esc 清空（跨模式一致）', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: 3 })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    // Ctrl+F 聚焦文件夹模式的文件名搜索框
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = screen.getByPlaceholderText(/搜索文件名…/)
    expect(document.activeElement).toBe(input)
    // Esc 清空复位
    fireEvent.change(input, { target: { value: 'b' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
  })

  it('从文件夹进入单文件再返回：搜索/过滤/折叠状态保留（0.12.1）', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let pick = 0
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: 3 }),
      readByPath: async (p: string) => ({
        path: p,
        name: p.split('/').pop() ?? 'f',
        text: 'content',
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    // 搜索 b：列表只剩 b.txt；双击进入单文件对比
    const input = screen.getByPlaceholderText(/搜索文件名…/)
    fireEvent.change(input, { target: { value: 'b' } })
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    fireEvent.dblClick(screen.getByText('b.txt'))
    await screen.findByText('← 返回文件夹对比')
    fireEvent.click(screen.getByText('← 返回文件夹对比'))
    await screen.findByText('b.txt')
    // 返回后搜索词仍在（视图状态由 App 持有，不随 FolderView 卸载丢失）
    expect(screen.getByPlaceholderText(/搜索文件名…/)).toHaveValue('b')
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('c.txt')).not.toBeInTheDocument()
  })

  it('重新选择新目录后旧搜索词不残留（换目录状态重置）', async () => {
    const dirs = ['C:/l1', 'D:/r1', 'C:/l2', 'D:/r2']
    let pick = 0
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => {
        // 第二轮（重新选择后的新目录对）返回含 x.md 的结果供断言（different 在仅看差异下可见）
        return pick >= 3
          ? {
              entries: [
                ...entries,
                { rel: 'x.md', status: 'different' as const, leftSize: 1, rightSize: 2 }
              ],
              truncated: false,
              total: 4
            }
          : { entries, truncated: false, total: 3 }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    // 搜索 b：列表收窄到 b.txt
    fireEvent.change(screen.getByPlaceholderText(/搜索文件名…/), { target: { value: 'b' } })
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    // 重新选择新目录对（第三、四次 pick）
    fireEvent.click(screen.getByText('重新选择'))
    await screen.findByText('x.md')
    // 旧搜索词已重置：全部条目可见（含关闭仅看差异后才能看到的 a.txt）
    const input = screen.getByPlaceholderText(/搜索文件名…/) as HTMLInputElement
    expect(input).toHaveValue('')
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('x.md')).toBeInTheDocument()
  })
})

describe('App - 文件夹扫描竞态', () => {
  it('慢的旧扫描后完成不覆盖新扫描结果（重新选择抢先完成）', async () => {
    const E1 = [{ rel: 'diff1.txt', status: 'different' as const, leftSize: 1, rightSize: 2 }]
    const E2 = [{ rel: 'stale.txt', status: 'different' as const, leftSize: 1, rightSize: 2 }]
    const E3 = [{ rel: 'fresh.txt', status: 'different' as const, leftSize: 1, rightSize: 2 }]
    const dirs = ['C:/l1', 'D:/r1', 'C:/l2', 'D:/r2']
    let pick = 0
    let scan = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveSlow: (v: any) => void = () => {}
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => {
        scan++
        if (scan === 2) {
          // 第二次扫描（语义切换触发）挂起，模拟大目录慢扫描
          return new Promise((res) => {
            resolveSlow = res
          }) as ReturnType<typeof window.api.scanFolder>
        }
        return scan === 1
          ? { entries: E1, truncated: false, total: 1 }
          : { entries: E3, truncated: false, total: 1 }
      }
    })
    render(<App />)
    // 第一轮：进入文件夹模式
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('diff1.txt')
    // 语义切换触发慢扫描（在途），随后重新选择触发新目录的快扫描
    fireEvent.click(screen.getByLabelText('语义判等'))
    fireEvent.click(screen.getByText('重新选择'))
    await screen.findByText('fresh.txt')
    // 慢扫描此刻才完成：过期结果必须被丢弃（不覆盖新目录与条目）
    await act(async () => {
      resolveSlow({ entries: E2, truncated: false, total: 1 })
    })
    expect(screen.queryByText('stale.txt')).not.toBeInTheDocument()
    expect(screen.getByText('fresh.txt')).toBeInTheDocument()
    expect(screen.getAllByText('C:/l2').length).toBeGreaterThan(0)
    // 扫描态不被旧扫描干扰（无残留遮罩）
    expect(screen.queryByText(/正在扫描文件夹/)).not.toBeInTheDocument()
  })

  it('扫描进行中退出文件夹对比：迟到的扫描结果不把界面拉回文件夹模式', async () => {
    const E1 = [{ rel: 'diff1.txt', status: 'different' as const, leftSize: 1, rightSize: 2 }]
    const E2 = [{ rel: 'stale.txt', status: 'different' as const, leftSize: 1, rightSize: 2 }]
    const dirs = ['C:/l1', 'D:/r1']
    let pick = 0
    let scan = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveSlow: (v: any) => void = () => {}
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => {
        scan++
        if (scan === 1) return { entries: E1, truncated: false, total: 1 }
        return new Promise((res) => {
          resolveSlow = res
        }) as ReturnType<typeof window.api.scanFolder>
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('diff1.txt')
    // 语义切换触发慢扫描（在途），随即退出文件夹对比
    fireEvent.click(screen.getByLabelText('语义判等'))
    fireEvent.click(screen.getByText('返回文件对比'))
    expect(await screen.findByText(/选择左侧文件/)).toBeInTheDocument()
    // 迟到的扫描完成：不得把界面拉回文件夹模式，也不得残留扫描遮罩
    await act(async () => {
      resolveSlow({ entries: E2, truncated: false, total: 1 })
    })
    expect(screen.getByText(/选择左侧文件/)).toBeInTheDocument()
    expect(screen.queryByText('stale.txt')).not.toBeInTheDocument()
    expect(screen.queryByText(/正在扫描文件夹/)).not.toBeInTheDocument()
  })
})

describe('App - 文件夹语义判等', () => {
  const semEntries = [
    { rel: 'same.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
    { rel: 'sem.txt', status: 'semantic-same' as const, leftSize: 3, rightSize: 4 },
    { rel: 'diff.txt', status: 'different' as const, leftSize: 3, rightSize: 5 }
  ]

  /** 进入文件夹模式（带语义条目），返回 scanFolder 调用记录 */
  async function enterWithSem() {
    const calls: Array<{ l: string; r: string; s: boolean }> = []
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async (l: string, r: string, s: boolean) => {
        calls.push({ l, r, s })
        return { entries: semEntries, truncated: false, total: 3 }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('语义同 1')
    return calls
  }

  it('语义同条目：统计徽章渲染，仅看差异时被过滤', async () => {
    await enterWithSem()
    expect(screen.getByText('相同 1')).toBeInTheDocument()
    expect(screen.getByText('不同 1')).toBeInTheDocument()
    // 默认仅看差异：same 与 semantic-same 均被过滤
    expect(screen.queryByText('same.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('sem.txt')).not.toBeInTheDocument()
    expect(screen.getByText('diff.txt')).toBeInTheDocument()
    // 关闭仅看差异：语义同条目可见
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(screen.getByText('sem.txt')).toBeInTheDocument()
  })

  it('首次扫描携带语义开关（默认开）', async () => {
    const calls = await enterWithSem()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ l: 'C:/left-dir', r: 'D:/right-dir', s: true })
  })

  it('切换语义开关触发重新扫描（关闭后不再渲染语义同徽章）', async () => {
    const calls = await enterWithSem()
    fireEvent.click(screen.getByLabelText('语义判等'))
    // 重新扫描完成（第二次调用返回后界面稳定）：语义同徽章不再渲染
    await screen.findByText('相同 1')
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].s).toBe(false)
    expect(screen.queryByText(/语义同/)).not.toBeInTheDocument()
  })

  it('语义开关随偏好持久化写回', async () => {
    await enterWithSem()
    fireEvent.click(screen.getByLabelText('语义判等'))
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('difflens.prefs.v1') ?? '{}')
      expect(saved.folderSemantic).toBe(false)
    })
    expect(
      JSON.parse(window.localStorage.getItem('difflens.prefs.v1') ?? '{}').folderOnlyDiff
    ).toBe(true)
  })

  it('导出文件夹报告：内容落盘携带目录与结论，成功提示可打开文件夹', async () => {
    let saved = ''
    let savedName = ''
    const showInFolder = vi.fn(async () => true)
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: semEntries, truncated: false, total: 3 }),
      saveReport: async (content: string, name: string) => {
        saved = content
        savedName = name
        return { ok: true, path: 'C:/docs/folder-report.html' }
      },
      showInFolder
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('语义同 1')
    fireEvent.click(screen.getByRole('button', { name: '导出报告' }))
    fireEvent.click(screen.getByText('HTML 报告'))
    expect(await screen.findByText(/报告已保存/)).toBeInTheDocument()
    expect(savedName).toMatch(/^DiffLens-folder-report-\d{8}-\d{6}\.html$/)
    expect(saved).toContain('<!doctype html>')
    expect(saved).toContain('C:/left-dir')
    expect(saved).toContain('D:/right-dir')
    expect(saved).toContain('判定口径：语义判等开启')
    expect(saved).toContain('共 1 个文件存在差异')
    // 报告含全量条目（不受界面“仅看差异”过滤影响）
    expect(saved).toContain('same.txt')
    expect(saved).toContain('sem.txt')
    fireEvent.click(screen.getByText('打开文件夹'))
    expect(showInFolder).toHaveBeenCalledWith('C:/docs/folder-report.html')
  })

  it('导出文件夹报告 IPC 异常给出失败提示', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: semEntries, truncated: false, total: 3 }),
      saveReport: async () => {
        throw new Error('boom')
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('语义同 1')
    fireEvent.click(screen.getByRole('button', { name: '导出报告' }))
    fireEvent.click(screen.getByText('纯文本'))
    expect(await screen.findByText(/导出失败/)).toBeInTheDocument()
  })
})

describe('App - 差异文件导航', () => {
  /** 3 个差异条目（b/c/d）+ 1 个相同 + 1 个语义同（不参与导航） */
  const navEntries = [
    { rel: 'a.txt', status: 'same' as const, leftSize: 1, rightSize: 1 },
    { rel: 'b.txt', status: 'different' as const, leftSize: 1, rightSize: 2 },
    { rel: 'c.txt', status: 'left-only' as const, leftSize: 1, rightSize: null },
    { rel: 'd.txt', status: 'right-only' as const, leftSize: null, rightSize: 1 },
    { rel: 's.txt', status: 'semantic-same' as const, leftSize: 1, rightSize: 2 }
  ]

  async function enterAndOpen(rel: string) {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: navEntries, truncated: false, total: 5 }),
      readByPath: async (p: string) => ({
        path: p,
        name: p.split('/').pop() ?? 'f',
        text: `content of ${p}`,
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    // 关闭仅看差异让 same/语义同条目可见，双击目标条目
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByLabelText('仅看差异'))
    fireEvent.dblClick(screen.getByText(rel))
    // 等待进入单文件对比（header 差异文件导航出现；内容被词级高亮拆分无法整串匹配）
    await screen.findByText('差异文件')
  }

  /** 当前左侧面板文件名（条目装载状态断言用） */
  const leftPaneFile = (): string =>
    Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)[0] ?? ''

  it('双击差异条目进入后显示导航：位置计数与边界禁用（语义同不计入序列）', async () => {
    await enterAndOpen('b.txt')
    // 差异文件序列 = b/c/d（s 语义同不计入），当前 b → 1/3
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(screen.getByTitle('上一个差异文件（Alt+↑）')).toBeDisabled()
    expect(screen.getByTitle('下一个差异文件（Alt+↓）')).toBeEnabled()
  })

  it('点击下一个差异文件加载新条目并推进计数', async () => {
    await enterAndOpen('b.txt')
    fireEvent.click(screen.getByTitle('下一个差异文件（Alt+↓）'))
    // c 是仅左条目：左侧装载 c.txt，右侧面板为未选择
    await waitFor(() => expect(leftPaneFile()).toBe('c.txt'))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    const paneFiles = Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)
    expect(paneFiles[1]).toBe('（未选择）')
  })

  it('最后一个差异文件时下一个禁用；Alt+↑/Alt+↓ 快捷键同样生效', async () => {
    await enterAndOpen('d.txt')
    expect(screen.getByText('3 / 3')).toBeInTheDocument()
    expect(screen.getByTitle('下一个差异文件（Alt+↓）')).toBeDisabled()
    // Alt+↑ 回到上一个
    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true })
    await waitFor(() => expect(leftPaneFile()).toBe('c.txt'))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    // Alt+↓ 再前进（d 为仅右条目：右侧面板装载）
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })
    await waitFor(() =>
      expect(Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)[1]).toBe(
        'd.txt'
      )
    )
    expect(screen.getByText('3 / 3')).toBeInTheDocument()
  })

  it('返回文件夹列表后导航消失，再次双击重新出现', async () => {
    await enterAndOpen('b.txt')
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    fireEvent.click(screen.getByText('← 返回文件夹对比'))
    await screen.findByText('相同 1')
    // 文件夹列表无差异文件导航
    expect(screen.queryByText('1 / 3')).not.toBeInTheDocument()
    // 再次双击进入：导航重新出现且从该条目计数
    fireEvent.dblClick(screen.getByText('c.txt'))
    await screen.findByText('差异文件')
    await waitFor(() => expect(leftPaneFile()).toBe('c.txt'))
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
  })

  it('普通文件对比（未进入过文件夹模式）不显示差异文件导航', async () => {
    render(<App />)
    fireEvent.click(screen.getByText('打开左侧'))
    await screen.findByText('导出报告')
    expect(screen.queryByText('差异文件')).not.toBeInTheDocument()
    // Alt+↓ 不触发任何导航（无报错即通过）
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })
    expect(screen.getByText('导出报告')).toBeInTheDocument()
  })

  it('双击 same 条目进入对比不显示导航（游标不在差异序列，0.10.1 修复）', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: navEntries, truncated: false, total: 5 }),
      readByPath: async (p: string) => ({
        path: p,
        name: p.split('/').pop() ?? 'f',
        text: `content of ${p}`,
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    // 关闭仅看差异让 same 条目可见，双击 a.txt 进入对比
    fireEvent.click(screen.getByLabelText('仅看差异'))
    fireEvent.dblClick(screen.getByText('a.txt'))
    await screen.findByText('← 返回文件夹对比')
    // 游标不在差异序列：导航组隐藏（缺陷版本显示"—"计数且"下一个"可点无响应）
    expect(screen.queryByText(/差异文件/)).not.toBeInTheDocument()
    // Alt+↓ 无副作用（不报错、不跳转）
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })
    expect(screen.getByText('← 返回文件夹对比')).toBeInTheDocument()
    // 双击差异条目回到序列：导航恢复
    fireEvent.click(screen.getByText('← 返回文件夹对比'))
    await screen.findByText('b.txt')
    fireEvent.dblClick(screen.getByText('b.txt'))
    expect(await screen.findByText(/差异文件/)).toBeInTheDocument()
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
  })
})

describe('App - 增量重扫', () => {
  const incEntries = [
    { rel: 'same.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
    { rel: 'diff.txt', status: 'different' as const, leftSize: 3, rightSize: 5 }
  ]
  const incCache = [
    {
      rel: 'same.txt',
      leftFp: { size: 3, mtime: 100 },
      rightFp: { size: 3, mtime: 100 },
      status: 'same' as const,
      semSame: null
    },
    {
      rel: 'diff.txt',
      leftFp: { size: 3, mtime: 101 },
      rightFp: { size: 5, mtime: 102 },
      status: 'different' as const,
      semSame: null
    }
  ]

  it('同目录重扫（语义切换/重新扫描）携带上次缓存；新目录不带', async () => {
    const calls: Array<{ l: string; r: string; s: boolean; p: unknown }> = []
    let pick = 0
    const dirs = ['C:/l1', 'D:/r1', 'C:/l2', 'D:/r2']
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async (l: string, r: string, s: boolean, p?: unknown) => {
        calls.push({ l, r, s, p: p ?? null })
        return { entries: incEntries, truncated: false, total: 2, cache: incCache }
      }
    })
    render(<App />)
    // 首次扫描：无缓存
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('相同 1')
    expect(calls).toHaveLength(1)
    expect(calls[0].p).toBeNull()
    // 语义切换重扫（同目录）：携带上次返回的 cache
    fireEvent.click(screen.getByLabelText('语义判等'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].p).toEqual(incCache)
    // 重新扫描按钮（同目录）：同样携带
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2].p).toEqual(incCache)
    // 重新选择新目录：不携带缓存
    fireEvent.click(screen.getByText('重新选择'))
    await screen.findByText('相同 1')
    await waitFor(() => expect(calls).toHaveLength(4))
    expect(calls[3].p).toBeNull()
  })

  it('mock 结果未携带 cache 字段时重扫传 null（向后兼容）', async () => {
    const calls: Array<unknown> = []
    const dirs = ['C:/l1', 'D:/r1']
    let pick = 0
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async (_l: unknown, _r: unknown, _s: unknown, p?: unknown) => {
        calls.push(p ?? null)
        // 模拟旧版扫描结果：无 cache 字段
        return { entries: incEntries, truncated: false, total: 2 }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('相同 1')
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toBeNull()
  })
})

describe('App - 目录聚合对比（双击目录行）', () => {
  /** sub 内两个差异（b.txt/sub/x.ts）+ 根层一个差异（c.txt）+ sub 内相同与语义同 */
  const scopeEntries = [
    { rel: 'a.txt', status: 'same' as const, leftSize: 1, rightSize: 1 },
    { rel: 'b.txt', status: 'different' as const, leftSize: 1, rightSize: 2 },
    { rel: 'sub/x.ts', status: 'different' as const, leftSize: 1, rightSize: 2 },
    { rel: 'sub/s.txt', status: 'semantic-same' as const, leftSize: 1, rightSize: 2 },
    { rel: 'sub/deep/y.md', status: 'different' as const, leftSize: 1, rightSize: 2 },
    { rel: 'c.txt', status: 'left-only' as const, leftSize: 1, rightSize: null },
    { rel: 'empty-dir-not-listed', status: 'same' as const, leftSize: 1, rightSize: 1 }
  ]

  /** 进入文件夹模式并双击目录 sub（返回进入后的辅助） */
  async function enterAndOpenDir(dirName: string) {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: scopeEntries, truncated: false, total: 7 }),
      readByPath: async (p: string) => ({
        path: p,
        name: p.split('/').pop() ?? 'f',
        text: `content of ${p}`,
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText(dirName)
    fireEvent.dblClick(screen.getByText(dirName))
    // scope 激活后导航标签为「差异文件 · <dir>/」，用正则匹配两种形态
    await screen.findByText(/差异文件/)
  }

  const leftPaneFile = (): string =>
    Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)[0] ?? ''

  it('双击目录行：导航限定子树（语义同不计入），打开首个差异文件并标注范围', async () => {
    await enterAndOpenDir('sub')
    // sub 子树差异 = x.ts 与 deep/y.md（s 语义同不计入）→ 1/2，标签带范围
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByText(/差异文件 · sub\//)).toBeInTheDocument()
    await waitFor(() => expect(leftPaneFile()).toBe('x.ts'))
    // 根层差异 c.txt 不在序列内：下一个到 deep/y.md 后再下一个禁用
    fireEvent.click(screen.getByTitle('下一个差异文件（Alt+↓）'))
    await waitFor(() => expect(leftPaneFile()).toBe('y.md'))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByTitle('下一个差异文件（Alt+↓）')).toBeDisabled()
  })

  it('聚合范围内 Alt+↓/Alt+↑ 导航保持范围不漂移', async () => {
    await enterAndOpenDir('sub')
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })
    await waitFor(() => expect(leftPaneFile()).toBe('y.md'))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByText(/差异文件 · sub\//)).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true })
    await waitFor(() => expect(leftPaneFile()).toBe('x.ts'))
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('双击文件条目回到全局序列（范围清除）', async () => {
    await enterAndOpenDir('sub')
    expect(screen.getByText(/差异文件 · sub\//)).toBeInTheDocument()
    // 返回文件夹列表，双击根层文件 c.txt：回全局序列（b/c/x/y = 4 个差异）
    fireEvent.click(screen.getByText('← 返回文件夹对比'))
    await screen.findByText('相同 2')
    fireEvent.dblClick(screen.getByText('c.txt'))
    await screen.findByText('差异文件')
    await waitFor(() => expect(leftPaneFile()).toBe('c.txt'))
    // 全局序列按 mock 条目顺序（真实扫描为字典序）：b/x.ts/y.md/c.txt → c.txt 为第 4 个
    expect(screen.getByText('4 / 4')).toBeInTheDocument()
    // 标签不再带子目录范围
    expect(screen.queryByText(/差异文件 · sub\//)).not.toBeInTheDocument()
  })

  it('目录内没有差异文件时提示且不进入单文件对比', async () => {
    const entries = [
      { rel: 'b.txt', status: 'different' as const, leftSize: 1, rightSize: 2 },
      { rel: 'nodiff/a.txt', status: 'same' as const, leftSize: 1, rightSize: 1 },
      { rel: 'nodiff/s.txt', status: 'semantic-same' as const, leftSize: 1, rightSize: 2 }
    ]
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: 3 })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    // 默认仅看差异：nodiff 目录被剪枝不可见；关闭后可见
    fireEvent.click(screen.getByLabelText('仅看差异'))
    expect(screen.getByText('nodiff')).toBeInTheDocument()
    fireEvent.dblClick(screen.getByText('nodiff'))
    // 无差异文件：提示且停留在文件夹列表（不进入单文件对比）
    expect(await screen.findByText(/目录「nodiff」内没有差异文件/)).toBeInTheDocument()
    expect(screen.queryByText('← 返回文件夹对比')).not.toBeInTheDocument()
  })
})

describe('App - 忽略规则', () => {
  const ignEntries = [
    { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
    { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 5 }
  ]

  /** 进入文件夹模式，记录 scanFolder 全部调用参数（含忽略规则） */
  async function enterWithIgnore(
    calls: Array<{ l: string; r: string; s: boolean; p: unknown; ig: unknown }>
  ) {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async (
        l: string,
        r: string,
        s: boolean,
        p?: unknown,
        ig?: unknown
      ): Promise<{ entries: typeof ignEntries; truncated: boolean; total: number }> => {
        calls.push({ l, r, s, p: p ?? null, ig: ig ?? null })
        return { entries: ignEntries, truncated: false, total: 2 }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
  }

  it('首次扫描携带忽略规则参数（默认空数组）', async () => {
    const calls: Array<{ l: string; r: string; s: boolean; p: unknown; ig: unknown }> = []
    await enterWithIgnore(calls)
    expect(calls).toHaveLength(1)
    expect(calls[0].ig).toEqual([])
  })

  it('应用规则后触发重扫并携带规则数组；规则持久化写回', async () => {
    const calls: Array<{ l: string; r: string; s: boolean; p: unknown; ig: unknown }> = []
    await enterWithIgnore(calls)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则' }))
    fireEvent.change(screen.getByPlaceholderText(/每行一条/), {
      target: { value: 'node_modules/\n*.log' }
    })
    fireEvent.click(screen.getByText('应用并重扫'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].ig).toEqual(['node_modules/', '*.log'])
    // 偏好写回
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem('difflens.prefs.v1') ?? '{}')
      expect(saved.folderIgnoreRules).toEqual(['node_modules/', '*.log'])
    })
    // 入口按钮标注规则数
    expect(screen.getByRole('button', { name: '忽略规则 · 2' })).toBeInTheDocument()
  })

  it('偏好中的忽略规则在启动时恢复并随扫描下发', async () => {
    window.localStorage.setItem(
      'difflens.prefs.v1',
      JSON.stringify({ folderIgnoreRules: ['dist/'] })
    )
    const calls: Array<{ l: string; r: string; s: boolean; p: unknown; ig: unknown }> = []
    await enterWithIgnore(calls)
    expect(calls[0].ig).toEqual(['dist/'])
    // 入口按钮直接标注恢复的规则数
    expect(screen.getByRole('button', { name: '忽略规则 · 1' })).toBeInTheDocument()
  })

  it('清空规则后重扫携带空数组', async () => {
    window.localStorage.setItem(
      'difflens.prefs.v1',
      JSON.stringify({ folderIgnoreRules: ['dist/'] })
    )
    const calls: Array<{ l: string; r: string; s: boolean; p: unknown; ig: unknown }> = []
    await enterWithIgnore(calls)
    fireEvent.click(screen.getByRole('button', { name: '忽略规则 · 1' }))
    fireEvent.click(screen.getByText('清空规则'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].ig).toEqual([])
  })

  it('损坏的偏好规则字段回退空数组', async () => {
    window.localStorage.setItem(
      'difflens.prefs.v1',
      JSON.stringify({ folderIgnoreRules: ['ok/', 42, null] })
    )
    const calls: Array<{ l: string; r: string; s: boolean; p: unknown; ig: unknown }> = []
    await enterWithIgnore(calls)
    expect(calls[0].ig).toEqual(['ok/'])
  })
})

describe('App - 快照基线', () => {
  const snapEntries = [
    { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
    { rel: 'b.txt', status: 'same' as const, leftSize: 3, rightSize: 5 }
  ]
  const curEntries = [
    { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
    { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 5 },
    { rel: 'c.txt', status: 'right-only' as const, leftSize: null, rightSize: 2 }
  ]

  function makeSnapJson(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      version: 1,
      leftDir: 'C:/left-dir',
      rightDir: 'D:/right-dir',
      semantic: true,
      truncated: false,
      total: 2,
      entries: snapEntries,
      savedAt: 1700000000000,
      ...overrides
    })
  }

  /** 进入文件夹模式（当前结果 curEntries）；可覆盖 readSnapshot 返回快照内容 */
  async function enterForSnapshot(snapshotText?: string) {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: false, total: 3 }),
      ...(snapshotText !== undefined
        ? {
            readSnapshot: async () => ({
              path: '/tmp/snap.json',
              name: 'snap.json',
              text: snapshotText,
              encoding: 'UTF-8',
              binary: false
            })
          }
        : {})
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    // 关闭仅看差异让全部条目可见后再断言 c.txt
    await screen.findByText('b.txt')
  }

  it('保存快照：落盘内容为合法快照 JSON 且含当前结果与目录对', async () => {
    let saved = ''
    let savedName = ''
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: false, total: 3 }),
      saveReport: async (content: string, name: string) => {
        saved = content
        savedName = name
        return { ok: true, path: 'C:/docs/snap.json' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('保存快照…'))
    expect(await screen.findByText(/快照已保存/)).toBeInTheDocument()
    expect(savedName).toMatch(/^DiffLens-snapshot-\d{8}-\d{6}\.json$/)
    const snap = parseSnapshot(saved)
    expect(snap).not.toBeNull()
    expect(snap!.leftDir).toBe('C:/left-dir')
    expect(snap!.rightDir).toBe('D:/right-dir')
    expect(snap!.entries.map((e) => e.rel)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('扫描结果截断时保存快照被拦截提示，不落盘', async () => {
    const saveReport = vi.fn(async () => ({ ok: true, path: 'C:/docs/snap.json' }))
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: true, total: 9999 }),
      saveReport
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText(/文件过多/)
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('保存快照…'))
    expect(await screen.findByText(/快照不完整无法对照/)).toBeInTheDocument()
    expect(saveReport).not.toHaveBeenCalled()
    expect(screen.queryByText(/快照已保存/)).not.toBeInTheDocument()
  })

  it('加载快照：对照模式渲染变迁统计与标注', async () => {
    await enterForSnapshot(makeSnapJson())
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/已加载快照/)).toBeInTheDocument()
    // 变迁统计徽章：b.txt 快照 same → 当前 different（新增差异）、c.txt 新文件
    expect(screen.getByText('新增差异 1')).toBeInTheDocument()
    expect(screen.getByText('新文件 1')).toBeInTheDocument()
    // 变迁标注的条目行（平铺）：b.txt 与 c.txt 可见，a.txt stable 默认隐藏
    expect(screen.getByText('b.txt')).toBeInTheDocument()
    expect(screen.getByText('c.txt')).toBeInTheDocument()
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    // 基线信息与退出按钮
    expect(screen.getByRole('button', { name: '退出对照' })).toBeInTheDocument()
  })

  it('对照模式下导出报告携带快照口径说明', async () => {
    let saved = ''
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: false, total: 3 }),
      readSnapshot: async () => ({
        path: '/tmp/snap.json',
        name: 'snap.json',
        text: makeSnapJson(),
        encoding: 'UTF-8',
        binary: false
      }),
      saveReport: async (content: string) => {
        saved = content
        return { ok: true, path: 'C:/docs/folder-report.txt' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    fireEvent.click(screen.getByRole('button', { name: '导出报告' }))
    fireEvent.click(screen.getByText('纯文本'))
    await screen.findByText(/报告已保存/)
    expect(saved).toContain('快照对照：修复 0 · 新增差异 1 · 新文件 1 · 已移除 0 · 仍有差异 0')
    // 对照模式导出：条目表为变迁对照表（含变迁标签与当前/基线状态）
    expect(saved).toContain('新增差异')
    expect(saved).toContain('新文件')
    expect(saved).toContain('保持一致')
  })

  it('退出对照恢复常规视图', async () => {
    await enterForSnapshot(makeSnapJson())
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    fireEvent.click(screen.getByRole('button', { name: '退出对照' }))
    // 恢复常规统计徽章（当前结果：相同 1 / 不同 1 / 仅右 1）
    await waitFor(() => expect(screen.getByText('相同 1')).toBeInTheDocument())
    expect(screen.queryByText(/新增差异 \d/)).not.toBeInTheDocument()
  })

  it('快照目录对与当前不一致：拦截提示且不进入对照', async () => {
    await enterForSnapshot(makeSnapJson({ leftDir: 'C:/other-left', rightDir: 'D:/right-dir' }))
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/快照的对比目录与当前不一致/)).toBeInTheDocument()
    expect(screen.queryByText(/已加载快照/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '退出对照' })).not.toBeInTheDocument()
  })

  it('快照文件无效（版本不符）：拦截提示', async () => {
    await enterForSnapshot(makeSnapJson({ version: 99 }))
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/快照文件无效或已损坏/)).toBeInTheDocument()
  })

  it('快照自身截断（手工构造形态）：拦截提示且不进入对照（0.10.4 对称防呆）', async () => {
    // 自家保存链路在截断时已拦截，truncated: true 仅来自手工构造/外部工具；
    // 截断快照缺失的文件会被全部误报为"新文件"，须与保存侧/当前侧拦截对称
    await enterForSnapshot(makeSnapJson({ truncated: true }))
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/条目不完整无法对照/)).toBeInTheDocument()
    expect(screen.queryByText(/已加载快照/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '退出对照' })).not.toBeInTheDocument()
  })

  it('快照读取失败（error 返回）：拦截提示', async () => {
    await enterForSnapshot()
    window.api = mockApi({
      readSnapshot: async () => ({ error: 'read-failed' as const, name: 'snap.json' })
    })
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/快照读取失败，请重试/)).toBeInTheDocument()
  })

  it('未进行文件夹对比时加载快照：拦截提示', async () => {
    render(<App />)
    // header 无加载快照入口（仅 FolderView 内）——空态下按钮不存在，行为由回调守卫保证
    expect(screen.queryByRole('button', { name: '快照' })).not.toBeInTheDocument()
  })

  it('对照模式随重扫刷新：重新扫描后变迁按新结果更新', async () => {
    let scanCall = 0
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let pick = 0
    // 快照基线：a same、b different（仍有差异可被修复）
    const snapBase = [
      { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
      { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 5 }
    ]
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => {
        scanCall++
        // 第一次：b different（仍有差异）；第二次（重扫）：b same（已修复）
        const entries =
          scanCall === 1
            ? snapBase
            : [
                { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
                { rel: 'b.txt', status: 'same' as const, leftSize: 3, rightSize: 5 }
              ]
        return { entries, truncated: false, total: entries.length }
      },
      readSnapshot: async () => ({
        path: '/tmp/snap.json',
        name: 'snap.json',
        text: makeSnapJson({ entries: snapBase }),
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    // 快照 b different ↔ 当前 b different → 仍有差异 1
    expect(screen.getByText('仍有差异 1')).toBeInTheDocument()
    // 修复 b.txt 后重扫：仍有差异归零，已修复 +1
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    await waitFor(() => expect(screen.getByText('已修复 1')).toBeInTheDocument())
    expect(screen.queryByText(/仍有差异 \d/)).not.toBeInTheDocument()
  })

  it('当前扫描结果截断时加载快照被拦截提示，不弹文件选择', async () => {
    const readSnapshot = vi.fn()
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: true, total: 9999 }),
      readSnapshot
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText(/文件过多/)
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/当前扫描结果已截断/)).toBeInTheDocument()
    // 拦截发生在文件选择之前（对称防呆：截断的当前结果会把缺失文件误报为已移除）
    expect(readSnapshot).not.toHaveBeenCalled()
    expect(screen.queryByText(/已加载快照/)).not.toBeInTheDocument()
  })

  it('快照语义判等口径与当前开关不一致：加载提示含口径差异', async () => {
    // 当前语义判等默认开启；快照保存时为关闭口径 → 提示对照结果含口径差异
    await enterForSnapshot(makeSnapJson({ semantic: false }))
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/口径差异/)).toBeInTheDocument()
    // 口径不一致不拦截对照（基线信息行仍展示快照口径）
    expect(screen.getByRole('button', { name: '退出对照' })).toBeInTheDocument()
  })

  it('快照语义判等口径与当前一致：无口径差异提示', async () => {
    // 快照 semantic: true 与当前默认开关一致，提示为常规文案
    await enterForSnapshot(makeSnapJson())
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    expect(await screen.findByText(/已加载快照/)).toBeInTheDocument()
    expect(screen.queryByText(/口径差异/)).not.toBeInTheDocument()
  })

  it('对照模式中重扫结果截断：自动退出对照并提示', async () => {
    let scanCall = 0
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let pick = 0
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => {
        scanCall++
        // 第二次（重扫）结果截断：条目不完整，对照会把截断缺失的文件误报为已移除
        return scanCall === 1
          ? { entries: curEntries, truncated: false, total: 3 }
          : { entries: curEntries.slice(0, 2), truncated: true, total: 9999 }
      },
      readSnapshot: async () => ({
        path: '/tmp/snap.json',
        name: 'snap.json',
        text: makeSnapJson(),
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    expect(screen.getByRole('button', { name: '退出对照' })).toBeInTheDocument()
    // 重扫触发截断：对照自动退出（回到常规视图与截断警示），不残留过期对照
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    await screen.findByText(/快照对照已退出/)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '退出对照' })).not.toBeInTheDocument()
    )
  })
})

describe('App - 快照内容级对照（v2）', () => {
  /** 进入文件夹模式并保存快照的公共流程（返回落盘内容捕获器） */
  async function enterAndSave(
    entries: Array<{
      rel: string
      status: 'same' | 'different' | 'left-only' | 'right-only'
      leftSize: number | null
      rightSize: number | null
    }>,
    readFiles: (
      paths: string[]
    ) => Array<
      | { path: string; name: string; text: string; encoding: string; binary: boolean }
      | { error: 'read-failed'; name: string }
    >,
    saveContent: { get: () => string }
  ): Promise<void> {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: entries.length }),
      readFilesByPaths: async (paths: string[]) => ({ files: readFiles(paths) }),
      saveReport: async (content: string) => {
        saveContent.get = () => content
        return { ok: true, path: 'C:/docs/snap.json' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    // 等待扫描完成进入文件夹模式（保存快照按钮出现即列表就绪）
    await screen.findByRole('button', { name: '快照' })
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('保存快照…'))
    await screen.findByText(/快照已保存/)
  }

  it('保存快照：差异条目双侧内容入 contents（批量读取按路径返回，same 条目不存内容）', async () => {
    const saved = { get: () => '' }
    const entries = [
      { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
      { rel: 'b.txt', status: 'different' as const, leftSize: 6, rightSize: 7 },
      { rel: 'c.txt', status: 'right-only' as const, leftSize: null, rightSize: 2 }
    ]
    await enterAndSave(
      entries,
      (paths) =>
        paths.map((p) => ({
          path: p,
          name: p.split('/').pop() ?? '',
          text: `content of ${p}`,
          encoding: 'UTF-8',
          binary: false
        })),
      saved
    )
    const snap = parseSnapshot(saved.get())
    expect(snap?.version).toBe(2)
    // 差异条目双侧内容入 contents（right-only 条目左侧为 null）
    const b = snap?.contents?.['b.txt'] as SnapshotContents | undefined
    expect(b?.left).toBe('content of C:/left-dir/b.txt')
    expect(b?.right).toBe('content of D:/right-dir/b.txt')
    const c = snap?.contents?.['c.txt'] as SnapshotContents | undefined
    expect(c?.left).toBeNull()
    expect(c?.right).toBe('content of D:/right-dir/c.txt')
    // same 条目不存内容（既定取舍：regressed 场景基线内容不保存）
    expect(snap?.contents?.['a.txt']).toBeUndefined()
  })

  it('保存快照：单文件超限侧不读取内容（该侧 null），快照仍保存状态', async () => {
    const saved = { get: () => '' }
    let requested: string[] = []
    await enterAndSave(
      [{ rel: 'big.txt', status: 'different' as const, leftSize: 3 * 1024 * 1024, rightSize: 7 }],
      (paths) => {
        requested = [...requested, ...paths]
        return paths.map((p) => ({
          path: p,
          name: p.split('/').pop() ?? '',
          text: 'right content',
          encoding: 'UTF-8',
          binary: false
        }))
      },
      saved
    )
    const snap = parseSnapshot(saved.get())
    // 左侧 3MB 超过单文件上限：不发起读取，contents.left 为 null
    expect(requested.some((p) => p.includes('left-dir'))).toBe(false)
    expect(snap?.contents?.['big.txt']).toEqual({ left: null, right: 'right content' })
  })

  it('保存快照：差异内容总量超限整体降级为纯状态快照并提示', async () => {
    // SNAPSHOT_CONTENTS_MAX_CHARS 被文件级 mock 压至 100：两个差异条目内容合计 120 字符超限
    const saved = { get: () => '' }
    await enterAndSave(
      [
        { rel: 'b1.txt', status: 'different' as const, leftSize: 60, rightSize: 60 },
        { rel: 'b2.txt', status: 'different' as const, leftSize: 60, rightSize: 60 }
      ],
      (paths) =>
        paths.map((p) => ({
          path: p,
          name: p.split('/').pop() ?? '',
          text: 'x'.repeat(30),
          encoding: 'UTF-8',
          binary: false
        })),
      saved
    )
    await screen.findByText(/仅保存状态不含内容/)
    const snap = parseSnapshot(saved.get())
    expect(snap).not.toBeNull()
    expect(snap?.contents).toBeUndefined()
  })

  it('对照模式双击含基线内容的条目：左为快照基线、右为当前内容（内容级对照）', async () => {
    const curEntries = [
      { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
      { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 5 }
    ]
    const snapJson = JSON.stringify({
      version: 2,
      leftDir: 'C:/left-dir',
      rightDir: 'D:/right-dir',
      semantic: true,
      truncated: false,
      total: 2,
      savedAt: 1700000000000,
      entries: curEntries,
      contents: { 'b.txt': { left: 'alpha baseline', right: 'alpha baseline-r' } }
    })
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: false, total: 2 }),
      readSnapshot: async () => ({
        path: '/tmp/snap.json',
        name: 'snap.json',
        text: snapJson,
        encoding: 'UTF-8',
        binary: false
      }),
      readByPath: async (p: string) =>
        p === 'C:/left-dir/b.txt'
          ? { path: p, name: 'b.txt', text: 'alpha current', encoding: 'UTF-8', binary: false }
          : null
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    fireEvent.dblClick(screen.getByText('b.txt'))
    // 左面板：快照基线内容（面板头标注"快照 · b.txt"），右面板：当前左侧文件（跟踪左文件优先）
    // 注：状态栏也含同名文本，用 selector 限定面板头
    expect(await screen.findByText('快照 · b.txt', { selector: '.pane-file' })).toBeInTheDocument()
    expect(screen.getByText('baseline', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('current', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('有差异')).toBeInTheDocument()
  })

  it('快照内容对照导出报告：头部含对照说明（基线来源与保存时间）与生成器版本号（0.11.0）', async () => {
    const curEntries = [
      { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
      { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 5 }
    ]
    const snapJson = JSON.stringify({
      version: 2,
      leftDir: 'C:/left-dir',
      rightDir: 'D:/right-dir',
      semantic: true,
      truncated: false,
      total: 2,
      savedAt: 1700000000000,
      entries: curEntries,
      contents: { 'b.txt': { left: 'alpha baseline', right: 'alpha baseline-r' } }
    })
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    let savedContent = ''
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: false, total: 2 }),
      readSnapshot: async () => ({
        path: '/tmp/snap.json',
        name: 'snap.json',
        text: snapJson,
        encoding: 'UTF-8',
        binary: false
      }),
      readByPath: async (p: string) =>
        p === 'C:/left-dir/b.txt'
          ? { path: p, name: 'b.txt', text: 'alpha current', encoding: 'UTF-8', binary: false }
          : null,
      saveReport: async (content: string) => {
        savedContent = content
        return { ok: true, path: 'C:/docs/DiffLens-report.html' }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    fireEvent.dblClick(screen.getByText('b.txt'))
    await screen.findByText('快照 · b.txt', { selector: '.pane-file' })
    // 导出 HTML：报告头部应注明左侧为快照基线及其保存时间，尾部含生成器版本号
    fireEvent.click(screen.getByText('导出报告'))
    fireEvent.click(screen.getByText('HTML 报告'))
    await screen.findByText(/报告已保存/)
    expect(savedContent).toContain('对照说明：左侧为快照基线')
    expect(savedContent).toContain('右侧为当前文件')
    // 版本号来自 app:get-version（mock 固定值 9.9.9-test）
    expect(savedContent).toContain('v9.9.9-test')
  })

  it('对照模式双击无基线内容的条目（v1 快照）：走常规当前文件双击', async () => {
    const curEntries = [
      { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
      { rel: 'b.txt', status: 'different' as const, leftSize: 3, rightSize: 5 }
    ]
    // v1 快照（无 contents 字段）：加载后双击走现状（当前文件对比，无"快照 ·"面板）
    const snapJson = JSON.stringify({
      version: 1,
      leftDir: 'C:/left-dir',
      rightDir: 'D:/right-dir',
      semantic: true,
      truncated: false,
      total: 2,
      savedAt: 1700000000000,
      entries: curEntries
    })
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: false, total: 2 }),
      readSnapshot: async () => ({
        path: '/tmp/snap.json',
        name: 'snap.json',
        text: snapJson,
        encoding: 'UTF-8',
        binary: false
      }),
      readByPath: async (p: string) => ({
        path: p,
        name: 'b.txt',
        text: 'plain current content',
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('b.txt')
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    fireEvent.dblClick(screen.getByText('b.txt'))
    // 两侧面板均为当前文件（无快照基线面板）
    await screen.findByText('← 返回文件夹对比')
    const paneFiles = Array.from(document.querySelectorAll('.pane-file')).map((e) => e.textContent)
    expect(paneFiles).toEqual(['b.txt', 'b.txt'])
    expect(screen.queryByText(/快照 ·/)).not.toBeInTheDocument()
  })

  it('对照模式双击 fixed 条目进入内容对照：游标不在差异序列，导航组隐藏（0.10.1 修复）', async () => {
    // 当前结果全部一致（无差异文件）；快照基线 b.txt different（含基线内容）→ fixed
    const curEntries = [
      { rel: 'a.txt', status: 'same' as const, leftSize: 3, rightSize: 3 },
      { rel: 'b.txt', status: 'same' as const, leftSize: 3, rightSize: 3 }
    ]
    const snapJson = JSON.stringify({
      version: 2,
      leftDir: 'C:/left-dir',
      rightDir: 'D:/right-dir',
      semantic: true,
      truncated: false,
      total: 2,
      savedAt: 1700000000000,
      entries: [
        { rel: 'a.txt', status: 'same', leftSize: 3, rightSize: 3 },
        { rel: 'b.txt', status: 'different', leftSize: 3, rightSize: 5 }
      ],
      contents: { 'b.txt': { left: 'baseline old value', right: null } }
    })
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: curEntries, truncated: false, total: 2 }),
      readSnapshot: async () => ({
        path: '/tmp/snap.json',
        name: 'snap.json',
        text: snapJson,
        encoding: 'UTF-8',
        binary: false
      }),
      readByPath: async (p: string) => ({
        path: p,
        name: 'b.txt',
        text: 'current fixed value',
        encoding: 'UTF-8',
        binary: false
      })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByRole('button', { name: '快照' })
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('加载快照…'))
    await screen.findByText(/已加载快照/)
    // 对照列表：b.txt 为已修复（默认隐藏 stable 的 a.txt）
    fireEvent.dblClick(screen.getByText('b.txt'))
    // 进入内容对照：左面板快照基线、右面板当前文件（缺陷版本此处导航显示"—"）
    expect(await screen.findByText('快照 · b.txt', { selector: '.pane-file' })).toBeInTheDocument()
    expect(screen.getByText('有差异')).toBeInTheDocument()
    expect(screen.queryByText(/差异文件/)).not.toBeInTheDocument()
  })

  it('快照保存读取阶段遮罩显示分批进度（0.10.1）', async () => {
    // 110 个差异条目 × 双侧 = 220 文件 > 200/批 → 两批：第一批完成后进度可见、第二批挂起
    const entries = Array.from({ length: 110 }, (_, i) => ({
      rel: `d${String(i).padStart(3, '0')}.txt`,
      status: 'different' as const,
      leftSize: 1,
      rightSize: 2
    }))
    const okFile = (p: string) => ({
      path: p,
      name: p.split('/').pop() ?? '',
      text: '',
      encoding: 'UTF-8',
      binary: false
    })
    let readCall = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveSecond: (v: any) => void = () => {}
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: entries.length }),
      readFilesByPaths: async (paths: string[]) => {
        readCall++
        if (readCall === 1) return { files: paths.map(okFile) }
        // 第二批挂起：进度文案保持可见可断言
        return new Promise((res) => {
          resolveSecond = res
        }) as unknown as ReturnType<typeof window.api.readFilesByPaths>
      },
      saveReport: async () => ({ ok: true, path: 'C:/docs/snap.json' })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByRole('button', { name: '快照' })
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('保存快照…'))
    // 第一批（200 个文件）完成、第二批挂起：遮罩显示 已读取 200 / 220
    expect(await screen.findByText(/已读取 200 \/ 220/)).toBeInTheDocument()
    await act(async () => {
      resolveSecond({ files: [] })
    })
    // 第二批完成：快照保存成功，遮罩与进度消失
    await screen.findByText(/快照已保存/)
    expect(screen.queryByText(/正在读取差异文件内容/)).not.toBeInTheDocument()
    expect(screen.queryByText(/已读取/)).not.toBeInTheDocument()
  })

  it('保存中退出文件夹对比：在途保存静默终止，不弹保存对话框（0.10.4）', async () => {
    // 保存遮罩不拦截交互：批量读取途中点「返回文件对比」后，保存流程须终止——
    // 否则读取全部完成后会在单文件空态界面上突然弹出保存对话框（上下文已消失）
    const entries = Array.from({ length: 110 }, (_, i) => ({
      rel: `d${String(i).padStart(3, '0')}.txt`,
      status: 'different' as const,
      leftSize: 1,
      rightSize: 2
    }))
    const okFile = (p: string) => ({
      path: p,
      name: p.split('/').pop() ?? '',
      text: '',
      encoding: 'UTF-8',
      binary: false
    })
    let readCall = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveSecond: (v: any) => void = () => {}
    const saveReport = vi.fn(async () => ({ ok: true, path: 'C:/docs/snap.json' }))
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: entries.length }),
      readFilesByPaths: async (paths: string[]) => {
        readCall++
        if (readCall === 1) return { files: paths.map(okFile) }
        // 第二批挂起：挂起期间用户退出文件夹对比
        return new Promise((res) => {
          resolveSecond = res
        }) as unknown as ReturnType<typeof window.api.readFilesByPaths>
      },
      saveReport
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByRole('button', { name: '快照' })
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('保存快照…'))
    // 第一批（200 个文件）完成、第二批挂起：遮罩显示读取进度
    expect(await screen.findByText(/已读取 200 \/ 220/)).toBeInTheDocument()
    // 退出文件夹对比：遮罩即时消失、回到单文件空态
    fireEvent.click(screen.getByRole('button', { name: '返回文件对比' }))
    await screen.findByText(/选择左侧文件/)
    expect(screen.queryByText(/正在读取差异文件内容/)).not.toBeInTheDocument()
    // 第二批此刻才完成：保存流程已被作废（世代号推进），静默终止
    await act(async () => {
      resolveSecond({ files: [] })
    })
    expect(saveReport).not.toHaveBeenCalled()
    expect(screen.queryByText(/快照已保存/)).not.toBeInTheDocument()
    expect(screen.queryByText(/正在读取差异文件内容/)).not.toBeInTheDocument()
  })
})

describe('App - 快照保存在新扫描开始时作废（0.12.1）', () => {
  it('保存读取期间点重新扫描：旧保存静默终止，不弹保存对话框', async () => {
    const entries = Array.from({ length: 110 }, (_, i) => ({
      rel: `d${String(i).padStart(3, '0')}.txt`,
      status: 'different' as const,
      leftSize: 1,
      rightSize: 2
    }))
    const okFile = (p: string) => ({
      path: p,
      name: p.split('/').pop() ?? '',
      text: '',
      encoding: 'UTF-8',
      binary: false
    })
    let readCall = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveSecond: (v: any) => void = () => {}
    const saveReport = vi.fn(async () => ({ ok: true, path: 'C:/docs/snap.json' }))
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let pick = 0
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      scanFolder: async () => ({ entries, truncated: false, total: entries.length }),
      readFilesByPaths: async (paths: string[]) => {
        readCall++
        if (readCall === 1) return { files: paths.map(okFile) }
        // 第二批挂起：挂起期间用户触发重新扫描
        return new Promise((res) => {
          resolveSecond = res
        }) as ReturnType<typeof window.api.readFilesByPaths>
      },
      saveReport
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByRole('button', { name: '快照' })
    fireEvent.click(screen.getByRole('button', { name: '快照' }))
    fireEvent.click(screen.getByText('保存快照…'))
    expect(await screen.findByText(/已读取 200 \/ 220/)).toBeInTheDocument()
    // 新扫描开始：旧保存世代号推进
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))
    await waitFor(() => expect(screen.queryByText(/正在读取差异文件内容/)).not.toBeInTheDocument())
    // 第二批此刻完成：旧保存静默终止
    await act(async () => {
      resolveSecond({ files: [] })
    })
    expect(saveReport).not.toHaveBeenCalled()
    expect(screen.queryByText(/快照已保存/)).not.toBeInTheDocument()
  })
})

describe('App - 扫描进度反馈', () => {
  it('扫描中进度事件显示在遮罩；旧会话的迟到进度被丢弃；完成后遮罩消失', async () => {
    let progressCb: ((d: { scanId: number; done: number; total: number }) => void) | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveScan: (v: any) => void = () => {}
    const dirs = ['C:/l', 'D:/r']
    let pick = 0
    window.api = mockApi({
      pickFolder: async () => dirs[pick++] ?? null,
      // 扫描挂起：遮罩期间触发进度事件验证显示与过滤
      scanFolder: async () =>
        new Promise((res) => {
          resolveScan = res
        }) as unknown as ReturnType<typeof window.api.scanFolder>,
      onScanProgress: (cb: (d: { scanId: number; done: number; total: number }) => void) => {
        progressCb = cb
        return () => {
          progressCb = null
        }
      }
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    // 扫描挂起中：App 层遮罩可见（mode 仍为 file）
    await screen.findByText(/正在扫描文件夹/)
    // 当前会话（seq=1）的进度事件：遮罩显示已比对进度
    act(() => {
      progressCb?.({ scanId: 1, done: 3, total: 9 })
    })
    expect(screen.getByText(/已比对 3 \/ 9/)).toBeInTheDocument()
    // 旧会话（scanId=0）的迟到进度被丢弃（不覆盖当前显示）
    act(() => {
      progressCb?.({ scanId: 0, done: 8, total: 9 })
    })
    expect(screen.getByText(/已比对 3 \/ 9/)).toBeInTheDocument()
    // 扫描完成：遮罩与进度消失
    await act(async () => {
      resolveScan({ entries: [], truncated: false, total: 0 })
    })
    await waitFor(() => expect(screen.queryByText(/正在扫描文件夹/)).not.toBeInTheDocument())
    expect(screen.queryByText(/已比对/)).not.toBeInTheDocument()
  })
})

describe('App - 关于弹框（0.10.2）', () => {
  it('点击 header 关于按钮打开弹框：版本/作者/邮箱/开源地址可见，Esc 关闭', async () => {
    render(<App />)
    // 两种模式常驻入口
    fireEvent.click(screen.getByTitle('关于 DiffLens'))
    // 版本号来自 app:get-version（mock 固定 9.9.9-test）
    expect(await screen.findByText('版本 9.9.9-test')).toBeInTheDocument()
    expect(screen.getByText('ThzxxArt')).toBeInTheDocument()
    expect(screen.getByText('stinanimz@gmail.com')).toBeInTheDocument()
    expect(screen.getByText('1440196015@qq.com')).toBeInTheDocument()
    expect(screen.getByText('https://github.com/ThzxxArt/DiffLens')).toBeInTheDocument()
    expect(screen.getByText('MIT License')).toBeInTheDocument()
    // Esc 关闭
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('版本 9.9.9-test')).not.toBeInTheDocument())
  })

  it('点击邮箱复制到剪贴板并 toast 反馈', async () => {
    render(<App />)
    fireEvent.click(screen.getByTitle('关于 DiffLens'))
    fireEvent.click(await screen.findByText('stinanimz@gmail.com'))
    expect(clipboardSpy).toHaveBeenCalledWith('stinanimz@gmail.com')
    expect(await screen.findByText(/邮箱已复制到剪贴板/)).toBeInTheDocument()
  })

  it('文件夹模式下关于按钮同样可见', async () => {
    const dirs = ['C:/left-dir', 'D:/right-dir']
    let call = 0
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder: async () => ({ entries: [], truncated: false, total: 0 })
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    await screen.findByText('文件夹对比 · 双击条目进入单文件对比')
    expect(screen.getByTitle('关于 DiffLens')).toBeInTheDocument()
  })
})

describe('App - 同目录防呆归一化（0.10.2）', () => {
  it('Windows 异写路径（盘符大小写/分隔符/尾斜杠差异）的同一目录被拦截，不进入扫描', async () => {
    // 注：normDir 有意保留路径段大小写（大小写敏感文件系统取舍），仅归一化盘符/分隔符/尾斜杠
    const dirs = ['C:\\Foo', 'c:/Foo/']
    let call = 0
    const scanFolder = vi.fn(async () => ({ entries: [], truncated: false, total: 0 }))
    window.api = mockApi({
      pickFolder: async () => dirs[call++] ?? null,
      scanFolder
    })
    render(<App />)
    fireEvent.click(screen.getByText('对比文件夹'))
    expect(await screen.findByText(/两次选择的是同一个文件夹/)).toBeInTheDocument()
    expect(scanFolder).not.toHaveBeenCalled()
    expect(screen.queryByText('返回文件对比')).not.toBeInTheDocument()
  })
})
