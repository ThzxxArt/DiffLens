import { describe, it, expect } from 'vitest'
import { normDir } from './pathNorm'

describe('normDir - 路径归一化（两进程共用）', () => {
  it('反斜杠转斜杠、去尾分隔符', () => {
    expect(normDir('C:\\left\\sub\\')).toBe('c:/left/sub')
    expect(normDir('D:/right/')).toBe('d:/right')
  })

  it('仅去掉多余尾分隔符（保留单个根斜杠）', () => {
    expect(normDir('/home/user//')).toBe('/home/user')
    expect(normDir('/')).toBe('/')
  })

  it('Windows 盘符小写（其余路径段保留原大小写）', () => {
    expect(normDir('D:\\Foo\\Bar')).toBe('d:/Foo/Bar')
    expect(normDir('c:/Foo')).toBe('c:/Foo')
    // 大小写敏感文件系统的路径段大小写不强制小写（避免误撞键）
    expect(normDir('/home/A')).toBe('/home/A')
  })

  it('非路径形态输入原样透传（盘符位置以外的小写化不生效）', () => {
    expect(normDir('ABC')).toBe('ABC')
    expect(normDir('')).toBe('')
  })
})
