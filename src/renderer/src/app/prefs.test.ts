import { beforeEach, describe, expect, it } from 'vitest'
import { loadPrefs } from './prefs'
import { PREFS_KEY } from './constants'
import { IGNORE_RULE_MAX_LEN } from '../../../shared/ignoreRules'

describe('loadPrefs - 防御性解析', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('损坏 JSON / 存储缺失回退默认', () => {
    expect(loadPrefs().folderSemantic).toBe(true)
    window.localStorage.setItem(PREFS_KEY, '{broken json!!')
    expect(loadPrefs().folderSemantic).toBe(true)
    expect(loadPrefs().folderOnlyDiff).toBe(true)
  })

  it('默认 true 的字段遇到非布尔值回退 true，而不是静默变成 false', () => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ folderOnlyDiff: 'yes', folderSemantic: 1, onlyDiff: 'true' })
    )
    const p = loadPrefs()
    expect(p.folderOnlyDiff).toBe(true)
    expect(p.folderSemantic).toBe(true)
    expect(p.onlyDiff).toBe(false)
  })

  it('合法布尔值原样保留', () => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ folderOnlyDiff: false, folderSemantic: false, onlyDiff: true })
    )
    const p = loadPrefs()
    expect(p.folderOnlyDiff).toBe(false)
    expect(p.folderSemantic).toBe(false)
    expect(p.onlyDiff).toBe(true)
  })

  it('忽略规则过滤非字符串与超长条目，合法规则保留', () => {
    const long = 'x'.repeat(IGNORE_RULE_MAX_LEN + 1)
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ folderIgnoreRules: ['node_modules/', 42, long, '*.log'] })
    )
    expect(loadPrefs().folderIgnoreRules).toEqual(['node_modules/', '*.log'])
  })
})
