import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { loadPrefs, savePrefs } from '../app/prefs'
import type { DiffOptions } from '../diff/diffEngine'

/**
 * 偏好状态：比较选项、单文件/文件夹视图开关、文件夹忽略规则。
 * 初始值只读一次盘；任一字段变化即写回 localStorage。
 */
export function usePreferences(): {
  options: DiffOptions
  setOptions: Dispatch<SetStateAction<DiffOptions>>
  onlyDiff: boolean
  setOnlyDiff: Dispatch<SetStateAction<boolean>>
  folderOnlyDiff: boolean
  setFolderOnlyDiff: Dispatch<SetStateAction<boolean>>
  folderSemantic: boolean
  setFolderSemantic: Dispatch<SetStateAction<boolean>>
  folderIgnoreRules: string[]
  setFolderIgnoreRules: Dispatch<SetStateAction<string[]>>
} {
  // 偏好只读一次盘：全部初始 state 共享同一次 loadPrefs 结果
  const [initialPrefs] = useState(() => loadPrefs())
  const [options, setOptions] = useState<DiffOptions>(initialPrefs.options)
  const [onlyDiff, setOnlyDiff] = useState<boolean>(initialPrefs.onlyDiff)
  const [folderOnlyDiff, setFolderOnlyDiff] = useState<boolean>(initialPrefs.folderOnlyDiff)
  const [folderSemantic, setFolderSemantic] = useState<boolean>(initialPrefs.folderSemantic)
  const [folderIgnoreRules, setFolderIgnoreRules] = useState<string[]>(
    initialPrefs.folderIgnoreRules
  )

  // 偏好写回：比较选项与全部视图开关、忽略规则变更即持久化
  useEffect(() => {
    savePrefs({ options, onlyDiff, folderOnlyDiff, folderSemantic, folderIgnoreRules })
  }, [options, onlyDiff, folderOnlyDiff, folderSemantic, folderIgnoreRules])

  return {
    options,
    setOptions,
    onlyDiff,
    setOnlyDiff,
    folderOnlyDiff,
    setFolderOnlyDiff,
    folderSemantic,
    setFolderSemantic,
    folderIgnoreRules,
    setFolderIgnoreRules
  }
}
