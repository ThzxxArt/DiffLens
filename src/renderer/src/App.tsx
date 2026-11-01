import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  type ReactElement,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { DiffOptions, DiffSummary, DiffRow } from './diff/diffEngine'
import DiffView, { type DisplayItem, type FoldMarker, isFold } from './components/DiffView'
import Toolbar from './components/Toolbar'
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu'
import TextInputModal from './components/TextInputModal'
import {
  buildReport,
  canBuildPatch,
  REPORT_EXT,
  type ReportFormat,
  type ReportContext
} from './diff/report'
import { buildFolderReport } from './diff/folderReport'
import {
  parseSnapshot,
  diffSnapshot,
  snapshotDirsMatch,
  isDiffStatus,
  SNAPSHOT_VERSION,
  SNAPSHOT_FILE_MAX_BYTES,
  SNAPSHOT_CONTENTS_MAX_CHARS,
  type FolderSnapshot,
  type SnapshotContents,
  type SnapshotDiffResult
} from './diff/snapshotDiff'
import { normDir } from '../../shared/pathNorm'
import { IGNORE_RULES_MAX } from '../../shared/ignoreRules'
import { isTextFile, countLines, HEAVY_LINES } from './diff/textUtils'
import { useDismiss } from './hooks/useDismiss'
import { useDiff } from './hooks/useDiff'
import type { PaneMeta } from './components/DiffView'
import type { SideCell } from './diff/diffEngine'
import FolderView from './components/FolderView'
import AboutModal from './components/AboutModal'
import LogoIcon from './components/LogoIcon'
import type { FolderEntry, FolderScanResult } from '../../preload/index'

/** 生成默认报告文件名所需的时间戳：YYYYMMDD-HHmmss */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`
}

/** 拖拽导入的文件大小上限（与主进程 file:open 的 10MB 限制保持一致） */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 快照保存批量读取的分批大小（主进程 folder:read-batch 上限 256，留余量） */
const SNAPSHOT_READ_BATCH = 200

/** 用户偏好（比较选项 + 视图开关）持久化键 */
const PREFS_KEY = 'difflens.prefs.v1'

/** 全部比较选项的默认值（严格对比；charDiffMaxEdit 为内部数值参数，不属于偏好） */
const DEFAULT_OPTIONS: DiffOptions = {
  trimWhitespace: false,
  ignoreCase: false,
  ignoreBlankLines: false,
  ignoreAllWhitespace: false,
  charMode: false
}

/** 布尔型偏好键：持久化恢复只遍历这些字段（数值型内部参数不持久化）；as const 收窄保证赋值类型为 boolean */
const PREF_BOOL_KEYS = [
  'trimWhitespace',
  'ignoreCase',
  'ignoreBlankLines',
  'ignoreAllWhitespace',
  'charMode'
] as const satisfies (keyof DiffOptions)[]

/** 持久化偏好的完整结构（比较选项 + 单文件/文件夹视图开关 + 文件夹忽略规则） */
interface Prefs {
  options: DiffOptions
  onlyDiff: boolean
  /** 文件夹模式「仅看差异」（默认开：文件夹场景默认关心差异文件） */
  folderOnlyDiff: boolean
  /** 文件夹模式「语义判等」（默认开：换行符/空白差异不再计为不同） */
  folderSemantic: boolean
  /** 文件夹扫描忽略规则（默认空；条目为字符串，上限与主进程一致） */
  folderIgnoreRules: string[]
}

/**
 * 读取持久化偏好：只接受已知字段的严格 boolean 值与合法忽略规则数组；
 * 数据损坏（JSON 非法 / 字段类型异常 / 存储不可用）一律回退默认，保证启动不受影响。
 */
function loadPrefs(): Prefs {
  const fallback: Prefs = {
    options: { ...DEFAULT_OPTIONS },
    onlyDiff: false,
    folderOnlyDiff: true,
    folderSemantic: true,
    folderIgnoreRules: []
  }
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(PREFS_KEY)
  } catch {
    return fallback
  }
  if (!raw) return fallback
  try {
    const obj = JSON.parse(raw) as {
      options?: Partial<Record<keyof DiffOptions, unknown>>
      onlyDiff?: unknown
      folderOnlyDiff?: unknown
      folderSemantic?: unknown
      folderIgnoreRules?: unknown
    }
    const bool = (v: unknown, def: boolean): boolean => (v === undefined ? def : v === true)
    const options: DiffOptions = { ...DEFAULT_OPTIONS }
    for (const k of PREF_BOOL_KEYS) {
      options[k] = bool(obj.options?.[k], false)
    }
    const ignoreRaw = obj.folderIgnoreRules
    const folderIgnoreRules = Array.isArray(ignoreRaw)
      ? ignoreRaw.filter((r): r is string => typeof r === 'string').slice(0, IGNORE_RULES_MAX)
      : []
    return {
      options,
      onlyDiff: bool(obj.onlyDiff, false),
      folderOnlyDiff: bool(obj.folderOnlyDiff, true),
      folderSemantic: bool(obj.folderSemantic, true),
      folderIgnoreRules
    }
  } catch {
    return fallback
  }
}

/** 计算中/无内容时的空统计（保持状态栏与徽章渲染稳定） */
const EMPTY_SUMMARY: DiffSummary = {
  changedLines: 0,
  inserted: 0,
  deleted: 0,
  modified: 0,
  charsAdded: 0,
  charsDeleted: 0
}

/** toast 队列元素 */
interface ToastItem {
  id: number
  text: string
  action?: { label: string; onClick: () => void }
}

/** toast 队列上限：超出时顶掉最旧的一条 */
const TOAST_MAX = 3

/** 清空二次确认窗口时长：第一次点击后在此时间内再点确认，超时自动复位 */
const CLEAR_CONFIRM_MS = 3000

interface PaneState {
  meta: PaneMeta
  path: string
  text: string
}

function EmptyPane({
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

export default function App(): ReactElement {
  const [paneL, setPaneL] = useState<PaneState | null>(null)
  const [paneR, setPaneR] = useState<PaneState | null>(null)
  // 工作模式：单文件对比 / 文件夹对比（双击文件夹条目临时切回 file，可返回）
  const [mode, setMode] = useState<'file' | 'folder'>('file')
  // 文件夹对比状态（扫描结果 + 两侧目录）；从文件夹双击进入单文件对比时保留，供返回
  const [folderState, setFolderState] = useState<
    (FolderScanResult & { leftDir: string; rightDir: string }) | null
  >(null)
  const [folderScanning, setFolderScanning] = useState(false)
  // 扫描比对进度（push 型 IPC 推送；仅显示与当前会话序号一致的事件，null = 无进度态）
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null)
  // 快照保存中（批量读取差异条目内容期间的遮罩态）
  const [snapshotSaving, setSnapshotSaving] = useState(false)
  // 快照保存批量读取进度（已读取文件数 / 总数；null = 尚无进度态）
  const [snapshotProgress, setSnapshotProgress] = useState<{ done: number; total: number } | null>(
    null
  )
  // 从文件夹进入单文件对比时的当前条目 rel（差异文件导航的游标；返回/退出文件夹模式时清空）
  const [folderEntryCursor, setFolderEntryCursor] = useState<string | null>(null)
  // 目录聚合对比的导航范围（双击目录行进入：差异文件导航限定在该子树内；
  // 双击任意文件条目回到全局序列；返回/退出文件夹模式时清空）
  const [folderNavScope, setFolderNavScope] = useState<string | null>(null)
  // 偏好只读一次盘：全部初始 state 共享同一次 loadPrefs 结果（原实现挂载期读取两次）
  const [initialPrefs] = useState(() => loadPrefs())
  // 文件夹模式的「仅看差异」：与单文件模式的 onlyDiff 独立（文件夹场景默认关心差异文件）
  const [folderOnlyDiff, setFolderOnlyDiff] = useState<boolean>(initialPrefs.folderOnlyDiff)
  // 文件夹模式的「语义判等」：字节不同但剔除空白后一致计为语义同（默认开，消除换行符误报）
  const [folderSemantic, setFolderSemantic] = useState<boolean>(initialPrefs.folderSemantic)
  // 文件夹扫描的忽略规则（gitignore 简化子集；随偏好持久化，应用后触发重扫）
  const [folderIgnoreRules, setFolderIgnoreRules] = useState<string[]>(initialPrefs.folderIgnoreRules)
  // 快照基线与对照结果（null = 非对照模式；加载快照后列表按状态变迁标注）
  const [snapshot, setSnapshot] = useState<FolderSnapshot | null>(null)
  const [snapshotDiff, setSnapshotDiff] = useState<SnapshotDiffResult | null>(null)
  // 比较选项与视图开关：初始值从持久化偏好恢复
  const [options, setOptions] = useState<DiffOptions>(initialPrefs.options)
  // 仅看差异：视图层过滤选项（不影响比较语义，也与报告导出无关，报告始终全量行）
  const [onlyDiff, setOnlyDiff] = useState<boolean>(initialPrefs.onlyDiff)
  const [activeRowId, setActiveRowId] = useState<string | null>(null)
  const [navIndex, setNavIndex] = useState(0)
  // 视图内文本搜索（单文件模式）：关键字 + 当前命中序号（会话级临时状态，不持久化）
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // 文件夹模式的文件名搜索框 ref（Ctrl+F 跨模式聚焦分流用）
  const folderSearchRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [pasteSide, setPasteSide] = useState<'left' | 'right' | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  // 「关于」弹框开关与应用版本号（挂载时经 IPC 取一次，package.json 为唯一来源）
  const [aboutOpen, setAboutOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const pasteWrapRef = useRef<HTMLDivElement>(null)
  const closePaste = useCallback((): void => setPasteOpen(false), [])
  // 点击外部 / 按 Esc 关闭粘贴下拉
  useDismiss(pasteWrapRef, closePaste)

  // 挂载时获取应用版本号（关于弹框展示；失败静默显示占位）
  useEffect(() => {
    let alive = true
    window.api
      .getVersion()
      .then((v) => {
        if (alive && typeof v === 'string') setAppVersion(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // toast 队列：最多同时展示 3 条，各自独立计时互不清除
  // （此前单条覆盖式会互顶：二进制乱码预警被行数预警立即顶掉，用户看不到前一条）
  const toastSeq = useRef(0)
  const toastTimers = useRef(new Map<number, number>())

  const showToast = useCallback(
    (text: string, action?: { label: string; onClick: () => void }) => {
      const id = ++toastSeq.current
      setToasts((prev) => {
        const next = [...prev, { id, text, action }]
        // 超出上限时顶掉最旧的一条（其定时器到期后空过滤，无副作用）
        return next.length > TOAST_MAX ? next.slice(next.length - TOAST_MAX) : next
      })
      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
        toastTimers.current.delete(id)
      }, 3600)
      toastTimers.current.set(id, timer)
    },
    []
  )

  const dismissToast = useCallback((id: number): void => {
    const timer = toastTimers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      toastTimers.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // 卸载时清理全部定时器，避免泄漏
  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [])

  // 偏好写回：比较选项与全部视图开关、忽略规则变更即持久化（存储不可用时静默忽略，不影响本次会话）
  useEffect(() => {
    try {
      window.localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ options, onlyDiff, folderOnlyDiff, folderSemantic, folderIgnoreRules })
      )
    } catch {
      // 忽略写入失败（隐私模式/配额满等）
    }
  }, [options, onlyDiff, folderOnlyDiff, folderSemantic, folderIgnoreRules])

  // 超多行预警：行数超过阈值时提示后台计算耗时（渲染已虚拟化、计算已 worker 化，均不阻塞界面）
  const warnHeavyLines = useCallback(
    (text: string): void => {
      const lines = countLines(text)
      if (lines > HEAVY_LINES) showToast(`行数较多（${lines} 行），差异将在后台计算，可能需要一些时间`)
    },
    [showToast]
  )

  /** 将主进程文件读取结果应用到指定侧面板（openPane 与文件夹双击进入共用：错误提示/预警/装载） */
  const applyFileData = useCallback(
    (
      side: 'left' | 'right',
      data: NonNullable<Awaited<ReturnType<typeof window.api.readByPath>>>
    ): boolean => {
      if ('error' in data) {
        showToast(
          data.error === 'too-large'
            ? `文件超过 10MB，暂不支持对比：${data.name ?? ''}`
            : `文件读取失败：${data.name ?? ''}（可能被占用或权限不足）`
        )
        return false
      }
      if (data.binary) showToast(`疑似二进制文件，内容可能乱码：${data.name}`)
      warnHeavyLines(data.text)
      const pane: PaneState = {
        meta: { name: data.name, encoding: data.encoding },
        path: data.path,
        text: data.text
      }
      if (side === 'left') setPaneL(pane)
      else setPaneR(pane)
      return true
    },
    [showToast, warnHeavyLines]
  )

  const openPane = useCallback(
    async (side: 'left' | 'right') => {
      let data: Awaited<ReturnType<typeof window.api.openFile>>
      try {
        data = await window.api.openFile(side)
      } catch {
        showToast('文件读取失败，请重试')
        return
      }
      if (!data) return
      applyFileData(side, data)
    },
    [showToast, applyFileData]
  )

  const dropPane = useCallback(
    async (side: 'left' | 'right', files: File[]) => {
      const file = files[0]
      if (!file) return
      if (files.length > 1) showToast('一次只能导入一个文件，已取第一个')
      if (!isTextFile(file.name)) {
        showToast(`仅支持文本文件：${file.name}`)
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        showToast(`文件超过 10MB，暂不支持对比：${file.name}`)
        return
      }
      let text = ''
      let encoding = 'UTF-8'
      let binary = false
      try {
        const buf = await file.arrayBuffer()
        const decoded = await window.api.decodeBuffer(buf)
        text = decoded.text
        encoding = decoded.encoding
        binary = decoded.binary
      } catch {
        // IPC 解码失败时回退浏览器原生读取；两者都失败则明确报错，不静默加载空文本
        const fallback = await file.text().catch(() => null)
        if (fallback === null) {
          showToast(`文件读取失败：${file.name}`)
          return
        }
        text = fallback
      }
      if (binary) showToast(`疑似二进制文件，内容可能乱码：${file.name}`)
      warnHeavyLines(text)
      const pane: PaneState = { meta: { name: file.name, encoding }, path: '', text }
      if (side === 'left') setPaneL(pane)
      else setPaneR(pane)
    },
    [showToast, warnHeavyLines]
  )

  /**
   * 文件夹扫描会话序号：并发扫描（语义切换触发重扫 / 重新选择新目录）按序号丢弃过期结果，
   * 慢的旧扫描后完成不得覆盖新扫描的目录与条目、不得误弹失败提示；
   * 退出文件夹对比时递增以作废在途扫描（迟到的结果不得把界面拉回文件夹模式）。
   */
  const scanSeqRef = useRef(0)

  /**
   * 快照保存世代号：退出文件夹对比 / 返回文件列表时递增作废在途保存。
   * 保存遮罩不拦截交互（0.10.2 有意设计，pointer-events:none 仅视觉反馈），
   * 保存批量读取期间离开视图后保存流程静默终止——否则全部读取完成后会在
   * 单文件空态界面上突然弹出保存对话框（保存的目录对上下文已消失，名不符实）。
   * 世代号而非布尔：连续多次进入/退出不误判（与 scanSeqRef 同款模式）。
   */
  const snapshotSaveSeqRef = useRef(0)

  /** 文件夹对比：选择两侧目录并扫描（扫描完成切入文件夹模式；语义判等开关与忽略规则随扫描参数下发）。
   *  目录与上次一致且未截断时携带增量缓存——指纹一致的条目零 IO 沿用判定，
   *  语义判等开关切换触发的重扫从全量 IO 变为近乎零 IO；
   *  未携带缓存时（跨会话首次扫描）主进程自动注入 userData 落盘的持久化缓存 */
  const runFolderScan = useCallback(
    async (leftDir: string, rightDir: string, semantic: boolean, ignoreRules: string[]): Promise<void> => {
      const seq = ++scanSeqRef.current
      setFolderScanning(true)
      setScanProgress(null)
      try {
        const prev =
          folderState &&
          folderState.leftDir === leftDir &&
          folderState.rightDir === rightDir &&
          !folderState.truncated
            ? (folderState.cache ?? null)
            : null
        // scanId = 会话序号：进度事件携带回传，渲染端按序号过滤旧扫描的迟到进度
        const res = await window.api.scanFolder(leftDir, rightDir, semantic, prev, ignoreRules, seq)
        // 过期扫描（期间已发起新扫描或已退出文件夹对比）：结果整体丢弃
        if (seq !== scanSeqRef.current) return
        if ('error' in res) {
          showToast('文件夹扫描失败，请检查目录是否存在且可访问')
          return
        }
        setFolderState({ ...res, leftDir, rightDir })
        setMode('folder')
      } catch {
        if (seq !== scanSeqRef.current) return
        showToast('文件夹扫描失败，请重试')
      } finally {
        // 仅最新会话允许复位扫描态（新扫描进行中不被旧扫描的 finally 误清）
        if (seq === scanSeqRef.current) {
          setFolderScanning(false)
          setScanProgress(null)
        }
      }
    },
    [showToast, folderState]
  )

  // 订阅主进程扫描进度推送：仅显示与当前会话序号一致的事件（旧扫描迟到进度天然丢弃）
  useEffect(() => {
    const off = window.api.onScanProgress((data) => {
      if (data.scanId === scanSeqRef.current) setScanProgress({ done: data.done, total: data.total })
    })
    return off
  }, [])

  /** 入口：连续选择左右两个文件夹后开始对比 */
  const startFolderCompare = useCallback(async (): Promise<void> => {
    let leftDir: string | null = null
    let rightDir: string | null = null
    try {
      leftDir = await window.api.pickFolder()
      if (!leftDir) return
      rightDir = await window.api.pickFolder()
    } catch {
      showToast('选择文件夹失败，请重试')
      return
    }
    if (!rightDir) return
    // 同目录防呆（路径归一化后比较，与 scanCacheStore/snapshotDiff 同款逻辑）：
    // Windows 异写路径（大小写/分隔符差异）不得绕过；两侧相同只能得到"全部一致"的无意义结果
    if (normDir(leftDir) === normDir(rightDir)) {
      showToast('两次选择的是同一个文件夹，请选择两个不同的文件夹')
      return
    }
    await runFolderScan(leftDir, rightDir, folderSemantic, folderIgnoreRules)
  }, [showToast, runFolderScan, folderSemantic, folderIgnoreRules])

  /** 语义判等开关切换：记忆开关并对当前结果重新扫描（状态判定随语义变化） */
  const handleSemanticChange = useCallback(
    (v: boolean): void => {
      setFolderSemantic(v)
      if (folderState)
        void runFolderScan(folderState.leftDir, folderState.rightDir, v, folderIgnoreRules)
    },
    [folderState, runFolderScan, folderIgnoreRules]
  )

  /** 忽略规则应用：记忆规则并对当前目录重新扫描（被忽略的目录/文件不再枚举） */
  const handleIgnoreRulesChange = useCallback(
    (rules: string[]): void => {
      setFolderIgnoreRules(rules)
      if (folderState)
        void runFolderScan(folderState.leftDir, folderState.rightDir, folderSemantic, rules)
    },
    [folderState, runFolderScan, folderSemantic]
  )

  /** 导出文件夹对比报告（三格式；报告含全量条目，与界面过滤无关；对照模式附快照口径说明） */
  const exportFolderReport = useCallback(
    async (fmt: ReportFormat): Promise<void> => {
      if (!folderState) return
      const content = buildFolderReport(
        folderState.entries,
        {
          leftDir: folderState.leftDir,
          rightDir: folderState.rightDir,
          semantic: folderSemantic,
          truncated: folderState.truncated,
          total: folderState.total,
          // 生成器版本号 + 生效的忽略规则（被忽略条目不进报告，头部可辨识缺失原因）
          ...(appVersion !== '' ? { version: appVersion } : {}),
          ...(folderIgnoreRules.length > 0 ? { ignoreRules: folderIgnoreRules } : {}),
          ...(snapshotDiff !== null
            ? {
                snapshotNote: `修复 ${snapshotDiff.stats.fixed} · 新增差异 ${snapshotDiff.stats.regressed} · 新文件 ${snapshotDiff.stats.new} · 已移除 ${snapshotDiff.stats.gone} · 仍有差异 ${snapshotDiff.stats.changed}（基线 ${new Date(
                  snapshot?.savedAt ?? Date.now()
                ).toLocaleString('zh-CN')}）`,
                // 对照模式导出：条目表替换为变迁对照表（含当前/基线状态与大小）
                snapshotEntries: snapshotDiff.entries
              }
            : {})
        },
        fmt
      )
      const defaultName = `DiffLens-folder-report-${stamp()}.${REPORT_EXT[fmt]}`
      let res: { ok: boolean; path: string | null }
      try {
        res = await window.api.saveReport(content, defaultName)
      } catch {
        showToast('导出失败，请重试')
        return
      }
      if (res.ok && res.path) {
        const p = res.path
        showToast(`报告已保存：${p}`, {
          label: '打开文件夹',
          onClick: () => void window.api.showInFolder(p)
        })
      }
    },
    [folderState, folderSemantic, snapshotDiff, snapshot, showToast, appVersion, folderIgnoreRules]
  )

  /** 保存当前对比结果为快照基线（JSON 落盘，复用报告保存管线）。
   *  截断结果（文件过多）条目不完整：快照缺失的文件在日后对照中会被误判为"新文件"，拦截保存。
   *  v2 起可选保存差异条目的双侧内容（对照模式双击进入"快照基线 vs 当前"的内容对比）：
   *  仅差异条目（same/语义同不存——regressed 场景基线内容不保存为既定取舍）、
   *  单文件超 2MB 的侧不读（该侧 null）、内容总量超 32MB 整体降级为纯状态快照（保存永不失败）；
   *  批量读取期间遮罩显示"已读取 N / M"进度（与扫描进度反馈对称，大差异目录不再无反馈干等） */
  const saveSnapshot = useCallback((): void => {
    if (!folderState) return
    if (folderState.truncated) {
      showToast('扫描结果已截断（文件过多），快照不完整无法对照，请先缩小对比范围')
      return
    }
    const seq = ++snapshotSaveSeqRef.current
    void (async (): Promise<void> => {
      // ===== 收集差异条目双侧路径（超限/单侧缺失的侧不读） =====
      const targets: Array<{ rel: string; leftPath: string | null; rightPath: string | null }> = []
      for (const e of folderState.entries) {
        if (!isDiffStatus(e.status) || e.status === 'unreadable') continue
        const lOver = e.leftSize !== null && e.leftSize > SNAPSHOT_FILE_MAX_BYTES
        const rOver = e.rightSize !== null && e.rightSize > SNAPSHOT_FILE_MAX_BYTES
        targets.push({
          rel: e.rel,
          leftPath: e.status === 'right-only' || lOver ? null : `${folderState.leftDir}/${e.rel}`,
          rightPath: e.status === 'left-only' || rOver ? null : `${folderState.rightDir}/${e.rel}`
        })
      }
      let contents: Record<string, SnapshotContents> | undefined
      let contentsOverflow = false
      if (targets.length > 0) {
        setSnapshotSaving(true)
        setSnapshotProgress(null)
        try {
          // 去重路径分批批量读：单文件读取失败该条目按"该侧无内容"处理（不整体失败）；
          // 每批完成更新读取进度（文件数口径，去重后的双侧路径总数）
          const allPaths = [
            ...new Set(
              targets.flatMap((t) => [t.leftPath, t.rightPath].filter((p): p is string => p !== null))
            )
          ]
          const readMap = new Map<string, string>()
          for (let i = 0; i < allPaths.length; i += SNAPSHOT_READ_BATCH) {
            // 世代号推进（退出文件夹对比等）：保存静默终止（finally 复位遮罩）
            if (seq !== snapshotSaveSeqRef.current) return
            const batch = allPaths.slice(i, i + SNAPSHOT_READ_BATCH)
            let res: Awaited<ReturnType<typeof window.api.readFilesByPaths>>
            try {
              res = await window.api.readFilesByPaths(batch)
            } catch {
              showToast('快照保存失败：差异文件读取失败，请重试')
              return
            }
            if ('error' in res) {
              showToast('快照保存失败：差异文件读取失败，请重试')
              return
            }
            res.files.forEach((f, k) => {
              if (f && !('error' in f)) readMap.set(batch[k], f.text)
            })
            setSnapshotProgress({
              done: Math.min(i + SNAPSHOT_READ_BATCH, allPaths.length),
              total: allPaths.length
            })
          }
          // ===== 组装内容并执行总量上限（超出整体降级为纯状态快照） =====
          const map: Record<string, SnapshotContents> = {}
          let totalChars = 0
          for (const t of targets) {
            const lc = t.leftPath !== null ? (readMap.get(t.leftPath) ?? null) : null
            const rc = t.rightPath !== null ? (readMap.get(t.rightPath) ?? null) : null
            if (lc === null && rc === null) continue
            totalChars += (lc?.length ?? 0) + (rc?.length ?? 0)
            if (totalChars > SNAPSHOT_CONTENTS_MAX_CHARS) {
              contentsOverflow = true
              break
            }
            map[t.rel] = { left: lc, right: rc }
          }
          if (!contentsOverflow && Object.keys(map).length > 0) contents = map
        } finally {
          setSnapshotSaving(false)
          setSnapshotProgress(null)
        }
      }
      const snap: FolderSnapshot = {
        version: SNAPSHOT_VERSION,
        leftDir: folderState.leftDir,
        rightDir: folderState.rightDir,
        semantic: folderSemantic,
        truncated: folderState.truncated,
        total: folderState.total,
        entries: folderState.entries,
        savedAt: Date.now(),
        ...(contents !== undefined ? { contents } : {})
      }
      // 世代号推进（读取完成后才离开视图）：不再弹保存对话框（静默终止）
      if (seq !== snapshotSaveSeqRef.current) return
      const defaultName = `DiffLens-snapshot-${stamp()}.json`
      let res: { ok: boolean; path: string | null }
      try {
        res = await window.api.saveReport(JSON.stringify(snap, null, 2), defaultName)
      } catch {
        showToast('快照保存失败，请重试')
        return
      }
      if (res.ok && res.path) {
        const p = res.path
        showToast(
          contentsOverflow
            ? `快照已保存（差异内容总量超限，仅保存状态不含内容）：${p}`
            : `快照已保存：${p}`,
          {
            label: '打开文件夹',
            onClick: () => void window.api.showInFolder(p)
          }
        )
      }
    })()
  }, [folderState, folderSemantic, showToast])

  /** 加载快照文件并与当前结果对照：无当前结果 / 保存中 / 当前结果截断 / 目录对不一致 / 文件无效时拦截提示 */
  const loadSnapshot = useCallback((): void => {
    if (!folderState) {
      showToast('请先进行文件夹对比，再加载快照')
      return
    }
    // 保存中防抖：保存遮罩不拦截交互（pointer-events:none 仅视觉反馈），此处守卫
    // 防止保存与加载并发竞争（FolderView 侧按钮已同步禁用，此为双保险）
    if (snapshotSaving) {
      showToast('正在保存快照，请稍候')
      return
    }
    // 当前结果截断：条目不完整，快照有而当前"缺失"的条目会被误报为已移除（与保存侧拦截对称）
    if (folderState.truncated) {
      showToast('当前扫描结果已截断（文件过多），条目不完整无法对照，请先缩小对比范围')
      return
    }
    void (async (): Promise<void> => {
      let data: Awaited<ReturnType<typeof window.api.readSnapshot>>
      try {
        // 快照专用读取通道：读取上限 128MB（通用文件 10MB 上限会拦截自家保存的大快照），
        // 且不写 lastDir（不污染文件对话框的目录记忆）
        data = await window.api.readSnapshot()
      } catch {
        showToast('快照读取失败，请重试')
        return
      }
      if (!data) return
      if ('error' in data) {
        showToast('快照读取失败，请重试')
        return
      }
      const snap = parseSnapshot(data.text)
      if (!snap) {
        showToast('快照文件无效或已损坏')
        return
      }
      // 快照自身截断（仅可能来自手工构造/外部工具——自家保存链路在截断时已拦截）：
      // 快照缺失的文件在对照中会被全部误报为"新文件"，与保存侧/当前侧拦截对称的第三面防呆
      if (snap.truncated) {
        showToast('快照保存时扫描结果已截断（文件过多），条目不完整无法对照')
        return
      }
      if (!snapshotDirsMatch(snap, folderState.leftDir, folderState.rightDir)) {
        showToast('快照的对比目录与当前不一致，无法对照')
        return
      }
      setSnapshot(snap)
      setSnapshotDiff(diffSnapshot(snap.entries, folderState.entries))
      // 快照保存时的语义判等口径与当前开关不一致：原语义同文件会被重新判定，
      // 口径变化混入状态变迁（如误显示"新增差异"），提示用户甄别
      showToast(
        snap.semantic !== folderSemantic
          ? '已加载快照，列表按状态变迁标注（注意：快照的语义判等口径与当前开关不一致，对照结果含口径差异）'
          : '已加载快照，列表按状态变迁标注'
      )
    })()
  }, [folderState, folderSemantic, snapshotSaving, showToast])

  /** 退出快照对照（清空基线与对照结果） */
  const exitSnapshot = useCallback((): void => {
    setSnapshot(null)
    setSnapshotDiff(null)
  }, [])

  // 快照加载后扫描结果变化（重新扫描/语义切换）：目录对仍一致则刷新对照，否则清空对照；
  // 重扫后当前结果截断时同样清空对照（条目不完整会把截断缺失的文件误报为已移除）
  useEffect(() => {
    if (snapshot === null || folderState === null) return
    if (!snapshotDirsMatch(snapshot, folderState.leftDir, folderState.rightDir)) {
      setSnapshot(null)
      setSnapshotDiff(null)
      return
    }
    if (folderState.truncated) {
      setSnapshot(null)
      setSnapshotDiff(null)
      showToast('当前扫描结果已截断，快照对照已退出（条目不完整会误报已移除）')
      return
    }
    setSnapshotDiff(diffSnapshot(snapshot.entries, folderState.entries))
  }, [folderState, snapshot, showToast])

  /** 双击文件夹条目：按路径读取存在侧进入单文件对比（保留文件夹状态供返回）。
   *  快照对照模式下条目含基线内容时优先进入"内容对照"：左面板为快照基线内容、
   *  右面板为当前文件内容（跟踪左文件优先，快照时刻该侧不存在则跟踪右），
   *  完整复用单文件对比能力（比较选项/字符级/搜索/差异导航/导出）。
   *  navScope 为本次进入后的导航范围：手动双击文件条目传 null（回全局序列），
   *  目录聚合入口与差异文件导航传当前 scope（保持子树范围不被清除） */
  const openFolderEntry = useCallback(
    async (entry: FolderEntry, navScope: string | null = null): Promise<void> => {
      if (!folderState) return
      setFolderNavScope(navScope)
      // 清空指定侧面板：双击新条目的任一读取失败路径都必须清掉旧内容，
      // 否则成功侧与旧内容组成“名不符实”的对比（面板头还是旧文件名）
      const clearSide = (side: 'left' | 'right'): void => {
        if (side === 'left') setPaneL(null)
        else setPaneR(null)
      }
      const loadSide = async (side: 'left' | 'right', path: string | null): Promise<boolean> => {
        // 条目单侧不存在：清空该侧面板（避免残留上一个条目的内容）
        if (path === null) {
          clearSide(side)
          return true
        }
        let data: Awaited<ReturnType<typeof window.api.readByPath>>
        try {
          data = await window.api.readByPath(path)
        } catch {
          showToast('文件读取失败，请重试')
          clearSide(side)
          return false
        }
        if (!data) {
          clearSide(side)
          return false
        }
        const ok = applyFileData(side, data)
        if (!ok) clearSide(side)
        return ok
      }
      // ===== 快照内容对照：对照模式且快照 v2 含该条目基线内容（双侧均为 null 时走常规双击） =====
      const snapContents =
        snapshot !== null && snapshotDiff !== null ? snapshot.contents?.[entry.rel] : undefined
      if (snapContents !== undefined && (snapContents.left !== null || snapContents.right !== null)) {
        // 跟踪侧选择：优先"基线有内容且当前也存在"的一侧；兜底跟基线存在侧（当前侧空面板展示基线 vs 已删除）
        const baseSide: 'left' | 'right' =
          snapContents.left !== null && entry.status !== 'right-only'
            ? 'left'
            : snapContents.right !== null && entry.status !== 'left-only'
              ? 'right'
              : snapContents.left !== null
                ? 'left'
                : 'right'
        const baseText = baseSide === 'left' ? snapContents.left : snapContents.right
        if (baseText !== null) {
          setPaneL({
            meta: {
              name: `快照 · ${entry.rel.split('/').pop() ?? entry.rel}`,
              encoding: '快照基线'
            },
            path: '',
            text: baseText
          })
        } else {
          clearSide('left')
        }
        const curExists =
          baseSide === 'left' ? entry.status !== 'right-only' : entry.status !== 'left-only'
        const curPath = curExists
          ? `${(baseSide === 'left' ? folderState.leftDir : folderState.rightDir)}/${entry.rel}`
          : null
        const okCur = await loadSide('right', curPath)
        if (baseText !== null || okCur) {
          setFolderEntryCursor(entry.rel)
          setMode('file')
        }
        return
      }
      const okL = await loadSide(
        'left',
        entry.status === 'right-only' ? null : `${folderState.leftDir}/${entry.rel}`
      )
      const okR = await loadSide(
        'right',
        entry.status === 'left-only' ? null : `${folderState.rightDir}/${entry.rel}`
      )
      // 至少一侧装载成功才进入对比视图（双侧失败保持文件夹列表）
      if (okL || okR) {
        setFolderEntryCursor(entry.rel)
        setMode('file')
      }
    },
    [folderState, snapshot, snapshotDiff, applyFileData, showToast]
  )

  /** 差异文件序列（不同/仅左/仅右；语义同不计入），批量审查时的导航范围；
   *  目录聚合对比激活时限定在该子树内（folderNavScope） */
  const diffFileEntries = useMemo(() => {
    if (!folderState) return []
    const all = folderState.entries.filter(
      (e) => e.status === 'different' || e.status === 'left-only' || e.status === 'right-only'
    )
    if (folderNavScope === null) return all
    const prefix = folderNavScope + '/'
    return all.filter((e) => e.rel.startsWith(prefix))
  }, [folderState, folderNavScope])

  /** 双击目录行进入聚合对比：差异导航限定在该子树，打开其中第一个差异文件 */
  const openDirScope = useCallback(
    (dirPath: string): void => {
      if (!folderState) return
      const inScope = diffFileEntries.filter((e) =>
        e.rel.startsWith(dirPath + '/')
      )
      if (inScope.length === 0) {
        showToast(`目录「${dirPath}」内没有差异文件`)
        return
      }
      void openFolderEntry(inScope[0], dirPath)
    },
    [folderState, diffFileEntries, openFolderEntry, showToast]
  )

  /** 差异文件导航：跳转到上/下一个差异文件（不循环，越界不动；导航不改变当前聚合范围） */
  const goDiffFile = useCallback(
    (dir: 1 | -1): void => {
      if (diffFileEntries.length === 0) return
      const idx = diffFileEntries.findIndex((e) => e.rel === folderEntryCursor)
      const next = idx + dir
      if (idx < 0 || next < 0 || next >= diffFileEntries.length) return
      void openFolderEntry(diffFileEntries[next], folderNavScope)
    },
    [diffFileEntries, folderEntryCursor, folderNavScope, openFolderEntry]
  )

  // 导航游标在差异序列中的位置（-1 = 不在序列：双击 same/语义同条目，或快照对照模式
  // 双击 fixed/regressed/new 等当前无差异的条目——导航组随之隐藏，避免显示"—"计数
  // 与可点但无响应的按钮；双击差异条目即回到序列、导航恢复）
  const cursorIdx =
    folderEntryCursor === null
      ? -1
      : diffFileEntries.findIndex((e) => e.rel === folderEntryCursor)

  /** 从单文件对比返回文件夹列表（清空两侧面板与导航游标/聚合范围，文件夹扫描结果保留） */
  const backToFolder = useCallback((): void => {
    // 作废在途快照保存（用户主动离开当前视图）：保存流程静默终止（防御未来交互路径）
    snapshotSaveSeqRef.current++
    setSnapshotSaving(false)
    setSnapshotProgress(null)
    setPaneL(null)
    setPaneR(null)
    setFolderEntryCursor(null)
    setFolderNavScope(null)
    setMode('folder')
  }, [])

  /** 退出文件夹对比（清空文件夹状态、导航游标/聚合范围、快照对照与两侧面板，回到单文件空态） */
  const exitFolder = useCallback((): void => {
    // 作废在途扫描并复位扫描态：迟到的扫描结果不得把界面拉回文件夹模式，
    // 也不得让扫描遮罩与进度残留到下一次文件夹会话
    scanSeqRef.current++
    // 作废在途快照保存：批量读取完成后不得在单文件空态上突然弹出保存对话框
    //（保存的目录对上下文已消失）；遮罩即时复位（finally 的复位幂等兜底）
    snapshotSaveSeqRef.current++
    setSnapshotSaving(false)
    setSnapshotProgress(null)
    setFolderScanning(false)
    setScanProgress(null)
    setFolderState(null)
    setPaneL(null)
    setPaneR(null)
    setFolderEntryCursor(null)
    setFolderNavScope(null)
    setSnapshot(null)
    setSnapshotDiff(null)
    setMode('file')
  }, [])

  // diff 计算已 worker 化：大输入后台计算（computing 期间 diff 为 null），小输入同步快路径
  const { diff, computing } = useDiff(paneL?.text ?? '', paneR?.text ?? '', options)

  // 字符级对比因内容超限或差异过大自动降级为行级时提示（依赖 diff 对象，同一结果只提示一次）；
  // 部分降级（部分超限组行级配对、其余组仍字符级）单独提示
  useEffect(() => {
    if (diff?.charModeDowngraded) {
      showToast('内容或差异过大，字符级对比已自动降级为行级对比')
    } else if (diff?.charModePartial) {
      showToast('部分差异块过大已按行级对比，其余差异仍为字符级高亮')
    }
  }, [diff, showToast])

  const rows = useMemo(() => diff?.rows ?? [], [diff])
  const changedRows = useMemo(() => rows.filter((r) => r.isChanged), [rows])
  const summary: DiffSummary = diff?.summary ?? EMPTY_SUMMARY

  // “仅看差异”视图行集：过滤未更改行，在连续省略处插入折叠提示行（占一个虚拟行位）
  const displayRows = useMemo(() => {
    if (!onlyDiff) return rows as DisplayItem[]
    if (rows.length === 0) return [] as DisplayItem[]
    if (changedRows.length === 0) {
      const m: FoldMarker = {
        fold: true,
        skipped: rows.length,
        note: '两文件内容完全一致，已折叠全部未更改行'
      }
      return [m]
    }
    const out: DisplayItem[] = []
    let skipped = 0
    for (const r of rows) {
      if (r.isChanged) {
        if (skipped > 0) {
          out.push({ fold: true, skipped })
          skipped = 0
        }
        out.push(r)
      } else {
        skipped++
      }
    }
    if (skipped > 0) out.push({ fold: true, skipped })
    return out
  }, [rows, onlyDiff, changedRows.length])

  // ===== 视图内文本搜索 =====
  // 命中行集（大小写不敏感，两侧任一命中即算；含未更改行，与“仅看差异”独立——
  // rows 为全量行，5 万行线性扫描毫秒级，无需 worker）
  const searchHits = useMemo<DiffRow[]>(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q === '') return []
    return rows.filter(
      (r) =>
        (r.left.text !== null && r.left.text.toLowerCase().includes(q)) ||
        (r.right.text !== null && r.right.text.toLowerCase().includes(q))
    )
  }, [rows, searchQuery])

  // 关键字变化：命中序号归零并定位到第一个命中行（GitHub 风格即时反馈）；
  // 仅依赖 searchQuery（rows 变化触发的 hits 重算不抢跳，由下方 clamp 兜底）
  useEffect(() => {
    setSearchIndex(0)
    if (searchQuery.trim() !== '' && searchHits.length > 0) setActiveRowId(searchHits[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  // diff 重算（切选项/交换/新文件）导致命中集变化：序号钳制回有效范围
  useEffect(() => {
    setSearchIndex((i) => Math.min(i, Math.max(0, searchHits.length - 1)))
  }, [searchHits])

  /** 命中行之间循环跳转（Enter / Shift+Enter）；目标行被“仅看差异”折叠时提示且不推进 */
  const goSearch = useCallback(
    (dir: 1 | -1): void => {
      const len = searchHits.length
      if (len === 0) return
      let ni = searchIndex + dir
      if (ni >= len) ni = 0
      if (ni < 0) ni = len - 1
      const hit = searchHits[ni]
      if (!displayRows.some((it) => !isFold(it) && it.id === hit.id)) {
        showToast('命中行位于“仅看差异”折叠段内，关闭该开关后可定位')
        return
      }
      setSearchIndex(ni)
      setActiveRowId(hit.id)
    },
    [searchHits, searchIndex, displayRows, showToast]
  )

  // Ctrl+F 聚焦搜索框（跨模式一致：单文件聚焦内容搜索，文件夹聚焦文件名搜索；
  // 粘贴弹窗/右键菜单打开时不抢占焦点）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return
      if (pasteSide !== null || menu !== null) return
      e.preventDefault()
      const target = mode === 'folder' ? folderSearchRef.current : searchInputRef.current
      target?.focus()
      target?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, pasteSide, menu])

  // 交换左右两侧（React 18 事件回调内自动批处理，两态一同更新）
  const swapPanes = useCallback((): void => {
    setPaneL(paneR)
    setPaneR(paneL)
  }, [paneL, paneR])

  // 清空二次确认：两侧有内容时第一次点击仅提示，确认窗口内再点才真正清空
  // （文件可重新打开，粘贴输入的手动文本无法恢复，需防误触）
  const clearArmedRef = useRef(false)
  const clearTimer = useRef<number | null>(null)

  const handleClear = useCallback((): void => {
    // 空态无内容，无需确认成本
    if (paneL === null && paneR === null) return
    if (clearArmedRef.current) {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
      clearArmedRef.current = false
      clearTimer.current = null
      setPaneL(null)
      setPaneR(null)
      return
    }
    clearArmedRef.current = true
    showToast('再次点击“清空”将移除两侧内容')
    clearTimer.current = window.setTimeout(() => {
      clearArmedRef.current = false
      clearTimer.current = null
    }, CLEAR_CONFIRM_MS)
  }, [paneL, paneR, showToast])

  // 卸载时清理确认窗口定时器
  useEffect(() => {
    return () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
    }
  }, [])

  // diff 内容或视图选项变化时重置导航；搜索激活时 active 行同步定位到钳制后的
  // 当前命中行——rows 重建后行 id 全部重新编号（r{index}），旧 activeRowId 不再
  // 命中任何行，搜索计数（由 clamp 钳制保持）与行高亮会脱节直到下次 Enter；
  // 无命中时清空高亮。searchHits/searchIndex 有意不列入依赖：关键字变化路径由
  // 上方 effect 负责重置定位（首个命中行），若因 hits 变化触发会按旧序号定位，
  // 覆盖正确的首个命中定位。
  useEffect(() => {
    setNavIndex(0)
    const ni = Math.min(searchIndex, Math.max(0, searchHits.length - 1))
    setActiveRowId(searchHits.length > 0 ? searchHits[ni].id : null)
  }, [paneL, paneR, options, onlyDiff])

  const go = useCallback(
    (dir: 1 | -1) => {
      const len = changedRows.length
      if (len === 0) return
      let ni = navIndex + dir
      if (ni >= len) ni = 0
      if (ni < 0) ni = len - 1
      setNavIndex(ni)
      setActiveRowId(changedRows[ni].id)
    },
    [changedRows, navIndex]
  )

  // 差异导航快捷键：F7 下一处 / Shift+F7 上一处；粘贴弹窗或右键菜单打开时不抢占
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F7') return
      if (pasteSide !== null || menu !== null) return
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, pasteSide, menu])

  // 差异文件导航快捷键：Alt+↓ 下一个 / Alt+↑ 上一个（仅从文件夹进入的单文件对比可用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
      if (pasteSide !== null || menu !== null || folderEntryCursor === null) return
      e.preventDefault()
      goDiffFile(e.key === 'ArrowDown' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goDiffFile, pasteSide, menu, folderEntryCursor])

  // 行级右键菜单
  const onRowContext = useCallback(
    (e: ReactMouseEvent, side: 'left' | 'right', cell: SideCell) => {
      e.preventDefault()
      const pane = side === 'left' ? paneL : paneR
      const sideName = side === 'left' ? '左侧' : '右侧'
      const items: ContextMenuItem[] = [
        {
          label: `复制${sideName}此行内容`,
          action: () => void window.api.setClipboard(cell.text ?? '')
        },
        {
          label: '复制文件名',
          action: () => void window.api.setClipboard(pane?.meta.name ?? '')
        },
        {
          label: '在文件夹中显示',
          disabled: !pane?.path,
          action: () => {
            if (pane?.path) void window.api.showInFolder(pane.path)
          }
        }
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [paneL, paneR]
  )

  // 状态栏行数（面板内容不变时不重算；切分规则与 diff 引擎一致；
  // 声明提前——exportReport 的依赖数组在声明期求值引用）
  const leftLines = useMemo(() => (paneL ? countLines(paneL.text) : 0), [paneL])
  const rightLines = useMemo(() => (paneR ? countLines(paneR.text) : 0), [paneR])

  // Patch（unified diff）可导出性：判等类选项把两侧不同文本判为 unchanged 时不可表达
  const canPatch = useMemo(() => canBuildPatch(rows), [rows])

  const exportReport = useCallback(
    async (fmt: ReportFormat) => {
      // 计算中（diff 为 null）不导出：正常情况下导出按钮已禁用，此处兜底防御
      if (!diff) return
      // Patch 兜底守卫（菜单项已禁用）：判等污染的行集无法产出可应用的 unified diff
      if (fmt === 'patch' && !canPatch) {
        showToast('当前比较选项把部分不同内容判为相同，Patch 无法表达，请关闭相关选项后导出')
        return
      }
      // 字符级对比降级时，报告头部按实际生效语义描述：
      // 整体降级按行级语义；部分降级保持字符级语义并标注部分块按行级
      const reportOptions: DiffOptions = diff.charModeDowngraded
        ? { ...options, charMode: false, ignoreAllWhitespace: true, ignoreBlankLines: true, trimWhitespace: false }
        : options
      // 快照基线内容对照场景：左侧面板为快照基线（encoding 为 0.10.0 起的既定标记），
      // 报告头部注明数据来源与基线保存时间——脱离应用后仍可辨识
      const isSnapshotCompare =
        snapshot !== null && paneL !== null && paneL.meta.encoding === '快照基线'
      const ctx: ReportContext = {
        leftName: paneL?.meta.name ?? '',
        rightName: paneR?.meta.name ?? '',
        leftEncoding: paneL?.meta.encoding ?? '',
        rightEncoding: paneR?.meta.encoding ?? '',
        leftPath: paneL?.path || undefined,
        rightPath: paneR?.path || undefined,
        options: reportOptions,
        ...(diff.charModePartial && !diff.charModeDowngraded
          ? { charModePartial: true }
          : {}),
        // 生成器版本号（可追溯）与原始文本行数（忽略空行开启时 rows 统计偏小）
        ...(appVersion !== '' ? { version: appVersion } : {}),
        ...(leftLines > 0 ? { leftLines } : {}),
        ...(rightLines > 0 ? { rightLines } : {}),
        ...(isSnapshotCompare
          ? {
              compareNote: `左侧为快照基线（保存于 ${new Date(
                snapshot!.savedAt
              ).toLocaleString('zh-CN')}），右侧为当前文件`
            }
          : {})
      }
      // 尾部无换行标记（patch 格式专用）：splitLines 吃掉了尾部换行信息，按原文判定
      const tail =
        fmt === 'patch'
          ? {
              leftNoNewline: (paneL?.text ?? '') !== '' && !paneL!.text.endsWith('\n'),
              rightNoNewline: (paneR?.text ?? '') !== '' && !paneR!.text.endsWith('\n')
            }
          : undefined
      const content = buildReport(rows, ctx, summary, fmt, tail)
      const defaultName =
        fmt === 'patch'
          ? `DiffLens-patch-${stamp()}.${REPORT_EXT[fmt]}`
          : `DiffLens-report-${stamp()}.${REPORT_EXT[fmt]}`
      let res: { ok: boolean; path: string | null }
      try {
        res = await window.api.saveReport(content, defaultName)
      } catch {
        showToast('导出失败，请重试')
        return
      }
      if (res.ok && res.path) {
        const p = res.path
        showToast(`报告已保存：${p}`, {
          label: '打开文件夹',
          onClick: () => void window.api.showInFolder(p)
        })
      }
    },
    [diff, rows, paneL, paneR, summary, options, showToast, canPatch, appVersion, leftLines, rightLines, snapshot]
  )

  const anyPane = paneL !== null || paneR !== null

  const confirmPaste = useCallback(
    (side: 'left' | 'right', text: string) => {
      // 空白内容拦截：进入对比只会得到空面板与"完全一致"的误导性结果
      if (text.trim() === '') {
        showToast('内容为空，请先输入或粘贴文本')
        return
      }
      // 与文件入口的 10MB 字节上限保持对称：超限拒绝且不关闭弹窗，保留内容供编辑
      if (new TextEncoder().encode(text).length > MAX_FILE_SIZE) {
        showToast('粘贴内容超过 10MB，暂不支持对比')
        return
      }
      warnHeavyLines(text)
      const pane: PaneState = { meta: { name: '手动文本', encoding: '文本' }, path: '', text }
      if (side === 'left') setPaneL(pane)
      else setPaneR(pane)
      setPasteSide(null)
    },
    [showToast, warnHeavyLines]
  )

  const leftMeta = paneL?.meta ?? null
  const rightMeta = paneR?.meta ?? null

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <div className="logo-mark">
            <LogoIcon />
          </div>
          <div>
            <span className="logo-title">DiffLens</span>
            <span className="logo-sub">TEXT DIFF</span>
          </div>
        </div>
        <div className="header-spacer" />
        {mode === 'file' && (
          <>
            {folderState && (
              <button className="btn ghost" onClick={backToFolder} title="返回文件夹列表（扫描结果保留）">
                ← 返回文件夹对比
              </button>
            )}
            {folderState && cursorIdx >= 0 && (
              <div
                className="tool-group diff-file-nav"
                title={
                  folderNavScope !== null
                    ? `在目录「${folderNavScope}/」的差异文件之间跳转（Alt+↓ / Alt+↑）；双击任意文件条目回到全局序列`
                    : '在文件夹的差异文件之间跳转（Alt+↓ / Alt+↑）'
                }
              >
                <button
                  className="nav-btn"
                  title="上一个差异文件（Alt+↑）"
                  disabled={cursorIdx <= 0}
                  onClick={() => goDiffFile(-1)}
                >
                  ▲
                </button>
                <span className="nav-count">{`${cursorIdx + 1} / ${diffFileEntries.length}`}</span>
                <button
                  className="nav-btn"
                  title="下一个差异文件（Alt+↓）"
                  disabled={cursorIdx >= diffFileEntries.length - 1}
                  onClick={() => goDiffFile(1)}
                >
                  ▼
                </button>
                <span className="diff-file-label">
                  差异文件{folderNavScope !== null ? ` · ${folderNavScope}/` : ''}
                </span>
              </div>
            )}
            <button className="btn ghost" onClick={() => void openPane('left')}>
              打开左侧
            </button>
            <button className="btn ghost" onClick={() => void openPane('right')}>
              打开右侧
            </button>
          </>
        )}
        {mode === 'file' && (
          <div className="tool-group export-wrap" ref={pasteWrapRef}>
            <button className="btn ghost" onClick={() => setPasteOpen((o) => !o)}>
              粘贴文本
            </button>
            {pasteOpen && (
              <div className="export-menu">
                <button
                  className="ctx-item"
                  onClick={() => {
                    setPasteOpen(false)
                    setPasteSide('left')
                  }}
                >
                  粘贴到左侧
                </button>
                <button
                  className="ctx-item"
                  onClick={() => {
                    setPasteOpen(false)
                    setPasteSide('right')
                  }}
                >
                  粘贴到右侧
                </button>
              </div>
            )}
          </div>
        )}
        {mode === 'file' && (
          <>
            <button className="btn ghost" onClick={handleClear}>
              清空
            </button>
            <button className="btn ghost" onClick={() => void startFolderCompare()} title="选择两个文件夹，对比全部文件差异">
              对比文件夹
            </button>
          </>
        )}
        <button
          className="btn ghost about-btn"
          title="关于 DiffLens"
          onClick={() => setAboutOpen(true)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="12" cy="7.6" r="1.35" fill="currentColor" />
            <line x1="12" y1="10.6" x2="12" y2="17" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {mode === 'folder' && folderState ? (
        <FolderView
          leftDir={folderState.leftDir}
          rightDir={folderState.rightDir}
          entries={folderState.entries}
          truncated={folderState.truncated}
          total={folderState.total}
          scanning={folderScanning}
          saving={snapshotSaving}
          searchInputRef={folderSearchRef}
          progress={scanProgress}
          onlyDiff={folderOnlyDiff}
          onOnlyDiffChange={setFolderOnlyDiff}
          semantic={folderSemantic}
          onSemanticChange={handleSemanticChange}
          ignoreRules={folderIgnoreRules}
          onIgnoreRulesChange={handleIgnoreRulesChange}
          snapshot={snapshot}
          snapshotDiff={snapshotDiff}
          onSaveSnapshot={saveSnapshot}
          onLoadSnapshot={loadSnapshot}
          onExitSnapshot={exitSnapshot}
          onReopen={() => void startFolderCompare()}
          onRescan={() => {
            if (folderState)
              void runFolderScan(
                folderState.leftDir,
                folderState.rightDir,
                folderSemantic,
                folderIgnoreRules
              )
          }}
          onExit={exitFolder}
          onExport={(fmt) => void exportFolderReport(fmt)}
          onOpenEntry={(e) => void openFolderEntry(e)}
          onOpenDir={openDirScope}
        />
      ) : anyPane ? (
        <>
          <DiffView
            items={displayRows}
            leftMeta={leftMeta}
            rightMeta={rightMeta}
            activeRowId={activeRowId}
            searchQuery={searchQuery.trim()}
            onOpen={(s) => void openPane(s)}
            onRowContext={onRowContext}
            onDropFile={(s, f) => void dropPane(s, f)}
          />
          <Toolbar
            options={options}
            onOptionsChange={setOptions}
            summary={summary}
            navIndex={navIndex}
            navCount={changedRows.length}
            onNav={go}
            onExport={(fmt) => void exportReport(fmt)}
            computing={computing}
            onlyDiff={onlyDiff}
            onOnlyDiffChange={setOnlyDiff}
            onSwap={swapPanes}
            onOptionBlocked={(label) =>
              showToast(`「${label}」已包含在字符级对比中，关闭字符级后可单独设置`)
            }
            charModeDowngraded={diff?.charModeDowngraded ?? false}
            charModePartial={diff?.charModePartial ?? false}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchIndex={searchIndex}
            searchCount={searchHits.length}
            onSearchNav={goSearch}
            searchInputRef={searchInputRef}
            canPatch={canPatch}
          />
        </>
      ) : (
        <div className="diff-main">
          <EmptyPane side="left" onOpen={(s) => void openPane(s)} onDrop={(s, f) => void dropPane(s, f)} />
          <EmptyPane side="right" onOpen={(s) => void openPane(s)} onDrop={(s, f) => void dropPane(s, f)} />
        </div>
      )}

      <footer className="status-bar">
        {mode === 'folder' ? (
          <>
            <div className="status-left">
              <span className="status-item">文件夹对比 · 双击条目进入单文件对比</span>
            </div>
            <div className="status-spacer" />
          </>
        ) : (
          <>
            <div className="status-left">
              <span className="status-item">
                左：<b>{paneL ? paneL.meta.name : '—'}</b>
                {paneL ? ` · ${leftLines} 行` : ''}
              </span>
              <span className="status-item">
                右：<b>{paneR ? paneR.meta.name : '—'}</b>
                {paneR ? ` · ${rightLines} 行` : ''}
              </span>
              <span className="status-item">
                变更行：<b>{summary.changedLines}</b>
              </span>
            </div>
            <div className="status-spacer" />
            <div className="status-right">
              {computing ? (
                <span className="eq-badge busy">正在计算差异…</span>
              ) : summary.changedLines === 0 ? (
                <span className="eq-badge same">两文件内容完全一致</span>
              ) : (
                <span className="eq-badge diff">有差异</span>
              )}
            </div>
          </>
        )}
      </footer>

      {folderScanning && mode !== 'folder' && (
        <div className="computing-overlay">
          <span className="computing-ring" />
          <span>
            正在扫描文件夹…
            {scanProgress ? ` 已比对 ${scanProgress.done} / ${scanProgress.total}` : ''}
          </span>
        </div>
      )}

      {snapshotSaving && (
        <div className="computing-overlay">
          <span className="computing-ring" />
          <span>
            正在读取差异文件内容，准备快照…
            {snapshotProgress ? ` 已读取 ${snapshotProgress.done} / ${snapshotProgress.total}` : ''}
          </span>
        </div>
      )}

      {computing && (
        <div className="computing-overlay">
          <span className="computing-ring" />
          <span>正在计算差异…</span>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {aboutOpen && (
        <AboutModal
          version={appVersion}
          onClose={() => setAboutOpen(false)}
          onCopy={(text, label) => {
            void window.api.setClipboard(text)
            showToast(`${label}已复制到剪贴板`)
          }}
        />
      )}
      {pasteSide && (
        <TextInputModal
          title={`粘贴${pasteSide === 'left' ? '左侧' : '右侧'}文本`}
          onCancel={() => setPasteSide(null)}
          onConfirm={(t) => confirmPaste(pasteSide, t)}
        />
      )}
      {toasts.length > 0 && (
        <div className="toast-wrap">
          {toasts.map((t) => (
            <div className="toast" key={t.id}>
              <span className="toast-text">{t.text}</span>
              {t.action && (
                <button
                  className="toast-btn"
                  onClick={() => {
                    t.action!.onClick()
                    dismissToast(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}