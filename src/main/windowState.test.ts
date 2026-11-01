import { describe, it, expect } from 'vitest'
import { parseState, clampBounds, MIN_WIDTH, MIN_HEIGHT, type Rect } from './windowState'

/** 1920×1040 工作区（常见全高清屏去掉任务栏） */
const work: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

describe('parseState', () => {
  it('空输入回退空状态', () => {
    expect(parseState(null)).toEqual({})
    expect(parseState(undefined)).toEqual({})
    expect(parseState('')).toEqual({})
  })

  it('非法 JSON 回退空状态', () => {
    expect(parseState('{broken json!!')).toEqual({})
  })

  it('合法 bounds 与 lastDir 被保留', () => {
    const s = parseState(
      JSON.stringify({ bounds: { x: 10, y: 20, width: 1000, height: 700 }, lastDir: 'C:/docs' })
    )
    expect(s.bounds).toEqual({ x: 10, y: 20, width: 1000, height: 700 })
    expect(s.lastDir).toBe('C:/docs')
  })

  it('bounds 字段类型异常或缺失时被忽略', () => {
    expect(parseState(JSON.stringify({ bounds: { x: 'a', y: 2, width: 1000, height: 700 } })).bounds).toBeUndefined()
    expect(parseState(JSON.stringify({ bounds: { x: 1, y: 2, width: 1000 } })).bounds).toBeUndefined()
    expect(parseState(JSON.stringify({ bounds: null })).bounds).toBeUndefined()
  })

  it('bounds 含 NaN/Infinity 等非有限数值时被忽略', () => {
    const s = parseState(
      '{"bounds":{"x":NaN,"y":2,"width":1000,"height":700}}'
    )
    expect(s.bounds).toBeUndefined()
  })

  it('lastDir 非字符串或空串时被忽略', () => {
    expect(parseState(JSON.stringify({ lastDir: 42 })).lastDir).toBeUndefined()
    expect(parseState(JSON.stringify({ lastDir: '' })).lastDir).toBeUndefined()
  })

  it('lastReportDir 合法字符串被保留；非字符串或空串被忽略（0.11.0）', () => {
    const s = parseState(JSON.stringify({ lastReportDir: 'C:/export' }))
    expect(s.lastReportDir).toBe('C:/export')
    expect(parseState(JSON.stringify({ lastReportDir: 42 })).lastReportDir).toBeUndefined()
    expect(parseState(JSON.stringify({ lastReportDir: '' })).lastReportDir).toBeUndefined()
    expect(parseState(JSON.stringify({})).lastReportDir).toBeUndefined()
  })
})

describe('clampBounds', () => {
  it('工作区内合法 bounds 原样保留', () => {
    const b = { x: 100, y: 50, width: 1280, height: 820 }
    expect(clampBounds(b, work)).toEqual(b)
  })

  it('小于最小尺寸时钳制到最小值', () => {
    const c = clampBounds({ x: 100, y: 100, width: 400, height: 300 }, work)
    expect(c.width).toBe(MIN_WIDTH)
    expect(c.height).toBe(MIN_HEIGHT)
  })

  it('超出工作区尺寸时封顶到工作区大小', () => {
    const c = clampBounds({ x: 0, y: 0, width: 4000, height: 3000 }, work)
    expect(c.width).toBe(work.width)
    expect(c.height).toBe(work.height)
  })

  it('窗口移出屏幕左侧时拉回（右边缘至少 60px 进入工作区）', () => {
    const c = clampBounds({ x: -2000, y: 100, width: 1000, height: 700 }, work)
    expect(c.x).toBe(work.x - 1000 + 60)
  })

  it('窗口移出屏幕右侧时拉回（左边缘至少 60px 进入工作区）', () => {
    const c = clampBounds({ x: 5000, y: 100, width: 1000, height: 700 }, work)
    expect(c.x).toBe(work.x + work.width - 60)
  })

  it('窗口移出屏幕下方时拉回', () => {
    const c = clampBounds({ x: 100, y: 5000, width: 1000, height: 700 }, work)
    expect(c.y).toBe(work.y + work.height - 60)
  })

  it('带偏移的工作区（多显示器副屏）同样钳制', () => {
    const side: Rect = { x: 1920, y: 200, width: 1080, height: 900 }
    const c = clampBounds({ x: 0, y: 0, width: 1000, height: 700 }, side)
    // 左边缘至少 60px 进入副屏
    expect(c.x).toBe(side.x - 1000 + 60)
  })

  it('非整数尺寸与坐标被取整', () => {
    const c = clampBounds({ x: 10.6, y: 20.2, width: 1000.7, height: 700.1 }, work)
    expect(Number.isInteger(c.x)).toBe(true)
    expect(Number.isInteger(c.y)).toBe(true)
    expect(Number.isInteger(c.width)).toBe(true)
    expect(Number.isInteger(c.height)).toBe(true)
  })

  it('工作区小于最小尺寸时尺寸仍保持最小值', () => {
    const tiny: Rect = { x: 0, y: 0, width: 800, height: 500 }
    const c = clampBounds({ x: 0, y: 0, width: 1000, height: 700 }, tiny)
    expect(c.width).toBe(MIN_WIDTH)
    expect(c.height).toBe(MIN_HEIGHT)
  })
})
