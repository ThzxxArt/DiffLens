// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { decodeMaybeWorker, isTextRel, MAX_FILE_SIZE, readTextFile } from './fileService'

const tempPaths: string[] = []

function tmpPath(name: string): string {
  const p = join(
    os.tmpdir(),
    `difflens-test-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`
  )
  tempPaths.push(p)
  return p
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => fs.promises.rm(p, { force: true })))
})

describe('fileService - isTextRel', () => {
  it('按扩展名识别文本文件，无扩展名放行，大小写不敏感', () => {
    expect(isTextRel('a.txt')).toBe(true)
    expect(isTextRel('a.md')).toBe(true)
    expect(isTextRel('a.ts')).toBe(true)
    expect(isTextRel('a.png')).toBe(false)
    expect(isTextRel('noext')).toBe(true)
    expect(isTextRel('A.TXT')).toBe(true)
  })

  it('dotfile 与带点目录按最后一段文件名判定', () => {
    expect(isTextRel('.gitignore')).toBe(true)
    expect(isTextRel('config/.env.local')).toBe(true)
    expect(isTextRel('v1.2/README')).toBe(true)
    expect(isTextRel('v1.2/app.png')).toBe(false)
  })
})

describe('fileService - readTextFile', () => {
  it('读取 UTF-8 文本并返回元信息', async () => {
    const p = tmpPath('utf8.txt')
    await fs.promises.writeFile(p, '你好\nworld\n', 'utf-8')
    const r = await readTextFile(p)
    expect('error' in r).toBe(false)
    if (!('error' in r)) {
      expect(r.name).toMatch(/utf8\.txt$/)
      expect(r.text).toContain('你好')
      expect(r.encoding).toBe('UTF-8')
      expect(r.binary).toBe(false)
    }
  })

  it('超过 10MB 返回 too-large 且不读取内容', async () => {
    const p = tmpPath('big.txt')
    await fs.promises.writeFile(p, '', 'utf-8')
    await fs.promises.truncate(p, MAX_FILE_SIZE + 1)
    const r = await readTextFile(p)
    expect(r).toMatchObject({ error: 'too-large' })
  })

  it('不存在/不可读路径返回 read-failed', async () => {
    const r = await readTextFile(join(os.tmpdir(), `difflens-missing-${Date.now()}.txt`))
    expect(r).toMatchObject({ error: 'read-failed' })
  })
})

describe('fileService - decodeMaybeWorker', () => {
  it('小缓冲走同步解码路径', async () => {
    const r = await decodeMaybeWorker(Buffer.from('hello', 'utf-8'))
    expect(r.text).toBe('hello')
    expect(r.binary).toBe(false)
  })
})
