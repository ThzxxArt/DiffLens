import { describe, it, expect } from 'vitest'
import { TEXT_EXTENSIONS, isTextFile, HEAVY_LINES, countLines, displayCols } from './textUtils'

describe('textUtils', () => {
  it('常见文本扩展名放行', () => {
    expect(isTextFile('a.json')).toBe(true)
    expect(isTextFile('b.ts')).toBe(true)
    expect(isTextFile('c.md')).toBe(true)
    expect(isTextFile('d.log')).toBe(true)
  })

  it('无扩展名文件按文本放行', () => {
    expect(isTextFile('README')).toBe(true)
    expect(isTextFile('Makefile')).toBe(true)
  })

  it('非文本扩展名拒绝', () => {
    expect(isTextFile('img.png')).toBe(false)
    expect(isTextFile('a.exe')).toBe(false)
    expect(isTextFile('b.zip')).toBe(false)
    expect(isTextFile('c.jpg')).toBe(false)
  })

  it('扩展名大小写不敏感', () => {
    expect(isTextFile('A.TXT')).toBe(true)
    expect(isTextFile('CODE.MD')).toBe(true)
  })

  it('dotfile 与常见无扩展名文件按文本放行', () => {
    expect(isTextFile('.gitignore')).toBe(true)
    expect(isTextFile('.env.local')).toBe(true)
    expect(isTextFile('.editorconfig')).toBe(true)
    expect(isTextFile('Dockerfile')).toBe(true)
    expect(isTextFile('Dockerfile.dev')).toBe(true)
    expect(isTextFile('Makefile')).toBe(true)
    expect(isTextFile('v1.2/README')).toBe(true)
  })

  it('带点目录不参与扩展名截取（取最后一段文件名）', () => {
    expect(isTextFile('v1.2/README')).toBe(true)
    expect(isTextFile('v1.2/app.png')).toBe(false)
  })

  it('文本扩展名清单非空', () => {
    expect(TEXT_EXTENSIONS.length).toBeGreaterThan(0)
    expect(TEXT_EXTENSIONS).toContain('txt')
  })
})

describe('countLines / HEAVY_LINES', () => {
  it('空文本为 0 行', () => {
    expect(countLines('')).toBe(0)
  })

  it('无结尾换行按实际行数', () => {
    expect(countLines('a\nb\nc')).toBe(3)
  })

  it('结尾换行不产生额外空行（与 diff 引擎切分一致）', () => {
    expect(countLines('a\nb\n')).toBe(2)
  })

  it('CRLF 换行同样切分', () => {
    expect(countLines('a\r\nb')).toBe(2)
  })

  it('超多行预警阈值为 50000', () => {
    expect(HEAVY_LINES).toBe(50000)
  })
})

describe('displayCols 列宽估算', () => {
  it('半角字符按 1 列计', () => {
    expect(displayCols('hello')).toBe(5)
    expect(displayCols('')).toBe(0)
  })

  it('CJK 与全角字符按 2 列计', () => {
    expect(displayCols('中文')).toBe(4)
    expect(displayCols('ａｂ')).toBe(4)
  })

  it('中英混排按叠加列宽计', () => {
    expect(displayCols('a中b')).toBe(4)
  })

  it('传入 cap 时达到上限提前返回', () => {
    expect(displayCols('a'.repeat(9999), 5000)).toBe(5000)
  })

  it('未达 cap 时返回真实列宽', () => {
    expect(displayCols('abc', 5000)).toBe(3)
  })

  it('全角字符跨过 cap 时返回实际累计列宽', () => {
    // 2499 个半角后接全角：2499 + 2 = 2501 ≥ 2500
    expect(displayCols('a'.repeat(2499) + '中', 2500)).toBe(2501)
  })
})
