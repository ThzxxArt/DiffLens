import type { DiffOptions } from '../diff/diffEngine'
import { IGNORE_RULES_MAX, IGNORE_RULE_MAX_LEN } from '../../../shared/ignoreRules'
import { DEFAULT_OPTIONS, PREF_BOOL_KEYS, PREFS_KEY } from './constants'

/** 持久化偏好的完整结构（比较选项 + 单文件/文件夹视图开关 + 文件夹忽略规则） */
export interface Prefs {
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
export function loadPrefs(): Prefs {
  const fallback: Prefs = {
    options: { ...DEFAULT_OPTIONS },
    onlyDiff: false,
    folderOnlyDiff: true,
    folderSemantic: true,
    folderIgnoreRules: []
  }
  let raw: string | null
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
    // 严格 boolean：非布尔值（损坏数据中的 "yes" / 1 / null）一律回退默认值，
    // 不能把默认 true 的字段静默降级为 false（会误关语义判等/文件夹仅看差异）
    const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)
    const options: DiffOptions = { ...DEFAULT_OPTIONS }
    for (const k of PREF_BOOL_KEYS) {
      options[k] = bool(obj.options?.[k], false)
    }
    const ignoreRaw = obj.folderIgnoreRules
    const folderIgnoreRules = Array.isArray(ignoreRaw)
      ? ignoreRaw
          .filter((r): r is string => typeof r === 'string' && r.length <= IGNORE_RULE_MAX_LEN)
          .slice(0, IGNORE_RULES_MAX)
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

/** 写回偏好（存储不可用时静默忽略，不影响本次会话） */
export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 忽略写入失败（隐私模式/配额满等）
  }
}
