import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { FolderEntry, FolderScanResult } from '../../../preload/index'
import { SNAPSHOT_READ_BATCH } from '../app/constants'
import type { PaneState } from '../app/types'
import { buildFolderReport } from '../diff/folderReport'
import { REPORT_EXT, type ReportFormat } from '../diff/report'
import {
  diffSnapshot,
  isDiffStatus,
  parseSnapshot,
  snapshotDirsMatch,
  SNAPSHOT_CONTENTS_MAX_CHARS,
  SNAPSHOT_FILE_MAX_BYTES,
  SNAPSHOT_VERSION,
  type FolderSnapshot,
  type SnapshotContents,
  type SnapshotDiffResult
} from '../diff/snapshotDiff'
import { normDir } from '../../../shared/pathNorm'
import { stamp } from '../utils/stamp'
import type { ShowToast } from './useToast'

interface UseFolderComparisonOptions {
  showToast: ShowToast
  setPaneL: Dispatch<SetStateAction<PaneState | null>>
  setPaneR: Dispatch<SetStateAction<PaneState | null>>
  clearPanes: () => void
  applyFileData: (
    side: 'left' | 'right',
    data: NonNullable<Awaited<ReturnType<typeof window.api.readByPath>>>
  ) => boolean
  folderSemantic: boolean
  setFolderSemantic: Dispatch<SetStateAction<boolean>>
  folderIgnoreRules: string[]
  setFolderIgnoreRules: Dispatch<SetStateAction<string[]>>
  appVersion: string
}

/**
 * 文件夹对比会话状态机：选择/扫描、增量重扫、快照基线与内容级对照、
 * 双击条目进入单文件、差异文件导航、聚合目录范围与报告导出。
 */
export function useFolderComparison({
  showToast,
  setPaneL,
  setPaneR,
  clearPanes,
  applyFileData,
  folderSemantic,
  setFolderSemantic,
  folderIgnoreRules,
  setFolderIgnoreRules,
  appVersion
}: UseFolderComparisonOptions): {
  mode: 'file' | 'folder'
  folderState: (FolderScanResult & { leftDir: string; rightDir: string }) | null
  folderScanning: boolean
  scanProgress: { done: number; total: number } | null
  snapshotSaving: boolean
  snapshotProgress: { done: number; total: number } | null
  folderEntryCursor: string | null
  folderNavScope: string | null
  snapshot: FolderSnapshot | null
  snapshotDiff: SnapshotDiffResult | null
  runFolderScan: (
    leftDir: string,
    rightDir: string,
    semantic: boolean,
    ignoreRules: string[]
  ) => Promise<void>
  startFolderCompare: () => Promise<void>
  handleSemanticChange: (v: boolean) => void
  handleIgnoreRulesChange: (rules: string[]) => void
  exportFolderReport: (fmt: ReportFormat) => Promise<void>
  saveSnapshot: () => void
  loadSnapshot: () => void
  exitSnapshot: () => void
  openFolderEntry: (entry: FolderEntry, navScope?: string | null) => Promise<void>
  diffFileEntries: FolderEntry[]
  openDirScope: (dirPath: string) => void
  goDiffFile: (dir: 1 | -1) => void
  cursorIdx: number
  backToFolder: () => void
  exitFolder: () => void
} {
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
  // 快照基线与对照结果（null = 非对照模式；加载快照后列表按状态变迁标注）
  const [snapshot, setSnapshot] = useState<FolderSnapshot | null>(null)
  const [snapshotDiff, setSnapshotDiff] = useState<SnapshotDiffResult | null>(null)

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

  /** 文件夹对比：选择两侧目录并扫描（扫描完成切入文件夹模式；语义判等开关与忽略规则随扫描参数下发）。 */
  const runFolderScan = useCallback(
    async (
      leftDir: string,
      rightDir: string,
      semantic: boolean,
      ignoreRules: string[]
    ): Promise<void> => {
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
      if (data.scanId === scanSeqRef.current)
        setScanProgress({ done: data.done, total: data.total })
    })
    return off
  }, [])

  /** 入口：连续选择左右两个文件夹后开始对比 */
  const startFolderCompare = useCallback(async (): Promise<void> => {
    let leftDir: string | null
    let rightDir: string | null
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
    [folderState, runFolderScan, folderIgnoreRules, setFolderSemantic]
  )

  /** 忽略规则应用：记忆规则并对当前目录重新扫描（被忽略的目录/文件不再枚举） */
  const handleIgnoreRulesChange = useCallback(
    (rules: string[]): void => {
      setFolderIgnoreRules(rules)
      if (folderState)
        void runFolderScan(folderState.leftDir, folderState.rightDir, folderSemantic, rules)
    },
    [folderState, runFolderScan, folderSemantic, setFolderIgnoreRules]
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

  /** 保存当前对比结果为快照基线（JSON 落盘，复用报告保存管线）。 */
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
              targets.flatMap((t) =>
                [t.leftPath, t.rightPath].filter((p): p is string => p !== null)
              )
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
    if (snapshotSaving) {
      showToast('正在保存快照，请稍候')
      return
    }
    if (folderState.truncated) {
      showToast('当前扫描结果已截断（文件过多），条目不完整无法对照，请先缩小对比范围')
      return
    }
    void (async (): Promise<void> => {
      let data: Awaited<ReturnType<typeof window.api.readSnapshot>>
      try {
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

  /** 双击文件夹条目：按路径读取存在侧进入单文件对比（保留文件夹状态供返回）。 */
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
      if (
        snapContents !== undefined &&
        (snapContents.left !== null || snapContents.right !== null)
      ) {
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
          ? `${baseSide === 'left' ? folderState.leftDir : folderState.rightDir}/${entry.rel}`
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
    [folderState, snapshot, snapshotDiff, applyFileData, setPaneL, setPaneR, showToast]
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
      const inScope = diffFileEntries.filter((e) => e.rel.startsWith(dirPath + '/'))
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
    folderEntryCursor === null ? -1 : diffFileEntries.findIndex((e) => e.rel === folderEntryCursor)

  /** 从单文件对比返回文件夹列表（清空两侧面板与导航游标/聚合范围，文件夹扫描结果保留） */
  const backToFolder = useCallback((): void => {
    // 作废在途快照保存（用户主动离开当前视图）：保存流程静默终止（防御未来交互路径）
    snapshotSaveSeqRef.current++
    setSnapshotSaving(false)
    setSnapshotProgress(null)
    clearPanes()
    setFolderEntryCursor(null)
    setFolderNavScope(null)
    setMode('folder')
  }, [clearPanes])

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
    clearPanes()
    setFolderEntryCursor(null)
    setFolderNavScope(null)
    setSnapshot(null)
    setSnapshotDiff(null)
    setMode('file')
  }, [clearPanes])

  return {
    mode,
    folderState,
    folderScanning,
    scanProgress,
    snapshotSaving,
    snapshotProgress,
    folderEntryCursor,
    folderNavScope,
    snapshot,
    snapshotDiff,
    runFolderScan,
    startFolderCompare,
    handleSemanticChange,
    handleIgnoreRulesChange,
    exportFolderReport,
    saveSnapshot,
    loadSnapshot,
    exitSnapshot,
    openFolderEntry,
    diffFileEntries,
    openDirScope,
    goDiffFile,
    cursorIdx,
    backToFolder,
    exitFolder
  }
}
