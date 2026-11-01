import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { decodeText, looksBinary } from './decode'

describe('looksBinary - 二进制启发式', () => {
  it('空输入不判为二进制', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false)
  })

  it('出现 NUL 字节立即判定二进制', () => {
    const buf = new Uint8Array([0x61, 0x00, 0x62])
    expect(looksBinary(buf)).toBe(true)
  })

  it('纯可见 ASCII 判为文本', () => {
    const buf = new TextEncoder().encode('hello world text')
    expect(looksBinary(buf)).toBe(false)
  })

  it('不可见控制字符占比超过 5% 判为二进制', () => {
    // 20 字节中 2 字节为 0x01（10%）＞ 5%；探测窗口默认 8KB，短输入全量统计
    const buf = new Uint8Array([0x61, 0x61, 0x01, 0x01, ...Array(16).fill(0x61)])
    expect(looksBinary(buf)).toBe(true)
  })

  it('制表符与换行等常见空白不计入可疑字符', () => {
    const buf = new TextEncoder().encode('a\tb\nc\r\nd')
    expect(looksBinary(buf)).toBe(false)
  })
})

describe('decodeText - BOM 探测', () => {
  it('UTF-8 BOM：剥离 BOM 解码并标注', () => {
    const body = new TextEncoder().encode('中文内容')
    const buf = new Uint8Array([0xef, 0xbb, 0xbf, ...body])
    const r = decodeText(buf)
    expect(r.encoding).toBe('UTF-8 (BOM)')
    expect(r.text).toBe('中文内容')
    expect(r.binary).toBe(false)
  })

  it('UTF-16 LE BOM：剥离 BOM 解码并标注', () => {
    // UTF-16 LE：'中' = 0x2D 0x4E 小端
    const buf = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e])
    const r = decodeText(buf)
    expect(r.encoding).toBe('UTF-16 LE')
    expect(r.text).toBe('中')
  })

  it('UTF-16 BE BOM：iconv 解码并标注', () => {
    // '中' 的 UTF-16 BE = 0x4E 0x2D
    const buf = new Uint8Array([0xfe, 0xff, 0x4e, 0x2d])
    const r = decodeText(buf)
    expect(r.encoding).toBe('UTF-16 BE')
    expect(r.text).toBe('中')
  })

  it('仅 BOM 无内容：返回空文本', () => {
    const r = decodeText(new Uint8Array([0xef, 0xbb, 0xbf]))
    expect(r.encoding).toBe('UTF-8 (BOM)')
    expect(r.text).toBe('')
  })

  it('短于 BOM 长度的输入走严格 UTF-8 路径', () => {
    const r = decodeText(new Uint8Array([0xef, 0xbb]))
    // 0xEF 0xBB 不是合法 UTF-8 序列开头 → GBK 回退
    expect(r.encoding).toBe('GBK')
  })
})

describe('decodeText - 严格 UTF-8 与 GBK 回退', () => {
  it('无 BOM 合法 UTF-8 中文：标注 UTF-8', () => {
    const r = decodeText(new TextEncoder().encode('你好，世界'))
    expect(r.encoding).toBe('UTF-8')
    expect(r.text).toBe('你好，世界')
    expect(r.binary).toBe(false)
  })

  it('纯 ASCII：标注 UTF-8', () => {
    const r = decodeText(new TextEncoder().encode('plain ascii'))
    expect(r.encoding).toBe('UTF-8')
    expect(r.text).toBe('plain ascii')
  })

  it('GBK 编码中文：回退 GBK 解码正确', () => {
    const r = decodeText(iconv.encode('中文GBK编码内容', 'gbk'))
    expect(r.encoding).toBe('GBK')
    expect(r.text).toBe('中文GBK编码内容')
    expect(r.binary).toBe(false)
  })

  it('空输入：UTF-8 空文本', () => {
    const r = decodeText(new Uint8Array(0))
    expect(r.encoding).toBe('UTF-8')
    expect(r.text).toBe('')
  })

  it('含 NUL 字节的非法 UTF-8：GBK 回退且判定二进制（NUL 启发式）', () => {
    // 0xFF 破坏严格 UTF-8 触发 GBK 回退；0x00 命中 NUL 启发式判二进制
    const buf = new Uint8Array([0x41, 0x00, 0xff, 0x43])
    const r = decodeText(buf)
    expect(r.encoding).toBe('GBK')
    expect(r.binary).toBe(true)
  })

  it('替换符占比超过 5% 判定二进制（乱码防护）', () => {
    // 构造 GBK 解出大量替换符的字节：非法 GBK 序列密集
    const buf = new Uint8Array(200).fill(0xff)
    const r = decodeText(buf)
    expect(r.encoding).toBe('GBK')
    expect(r.binary).toBe(true)
  })
})
