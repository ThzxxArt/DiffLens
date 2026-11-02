import { test, expect } from '@playwright/test'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  launchApp,
  stubOpenDialogSeq,
  stubSaveDialog,
  makeTmpDir,
  removeTmpDir,
  writeTextFixture,
  pasteText,
  dropFiles
} from './helpers'

/**
 * DiffLens E2E 主链路验收（对 build 产物运行真实 Electron）：
 * 覆盖 jsdom 单测无法触达的主进程解码 / 报告写盘 / 剪贴板 IPC / 偏好持久化生命周期。
 * 运行前必须先 npm run build。
 */

test.describe('启动与基础交互', () => {
  test('应用启动：窗口标题与双空态面板', async () => {
    const { app, window } = await launchApp()
    await expect(window).toHaveTitle('DiffLens')
    await expect(window.getByText('选择左侧文件')).toBeVisible()
    await expect(window.getByText('选择右侧文件')).toBeVisible()
    // 空态不出现导出入口
    await expect(window.getByRole('button', { name: '导出报告' })).toHaveCount(0)
    await app.close()
  })

  test('粘贴两侧文本：差异渲染与统计徽章', async () => {
    const { app, window } = await launchApp()
    await pasteText(window, 'left', 'alpha\nbeta\ngamma')
    await expect(window.getByRole('button', { name: '导出报告' })).toBeVisible()
    await pasteText(window, 'right', 'alpha\nBETA\ngamma')
    // 差异徽章与状态栏结论
    await expect(window.getByText('有差异')).toBeVisible()
    await expect(window.getByText('~1')).toBeVisible()
    // 修改行内容渲染（词级高亮行；exact 避免大小写不敏感的重复命中）
    await expect(window.getByText('beta', { exact: true })).toBeVisible()
    await expect(window.getByText('BETA', { exact: true })).toBeVisible()
    await app.close()
  })
})

test.describe('文件打开与编码识别（主进程真实解码链路）', () => {
  let dir: string

  test.beforeAll(async () => {
    dir = await makeTmpDir('difflens-e2e-enc-')
  })

  test.afterAll(async () => {
    await removeTmpDir(dir)
  })

  test('打开 GBK 与 UTF-8 BOM 文件：编码标注与内容正确渲染', async () => {
    const gbkPath = await writeTextFixture(dir, 'gbk.txt', '中文内容第一行\n第二行数据', 'gbk')
    const bomPath = await writeTextFixture(dir, 'bom.txt', 'BOM 首行\nBOM 第二行', 'utf8-bom')
    const { app, window } = await launchApp()
    await stubOpenDialogSeq(app, [[gbkPath], [bomPath]])
    await window.getByRole('button', { name: '打开左侧' }).click()
    await expect(window.getByText('中文内容第一行')).toBeVisible()
    await window.getByRole('button', { name: '打开右侧' }).click()
    await expect(window.getByText('BOM 首行')).toBeVisible()
    // 面板头编码标注（主进程探测结果；exact 避免文件名 gbk.txt 的子串误匹配）
    await expect(window.locator('.pane-meta').filter({ hasText: 'GBK' })).toBeVisible()
    await expect(window.locator('.pane-meta').filter({ hasText: 'UTF-8 (BOM)' })).toBeVisible()
    await app.close()
  })

  test('大体积 GBK 文件：后台 worker 解码后完整渲染', async () => {
    // 约 300KB（≥ 解码 worker 快路径阈值 256KB）：走 worker_threads 后台解码链路
    const bigLines = Array.from({ length: 15000 }, (_, i) => `中文大文件行${i}数据`).join('\n')
    const bigPath = await writeTextFixture(dir, 'big-gbk.txt', bigLines, 'gbk')
    const { app, window } = await launchApp()
    await stubOpenDialogSeq(app, [[bigPath]])
    await window.getByRole('button', { name: '打开左侧' }).click()
    // 首行在视口内；末行在虚拟滚动视口外，以状态栏总行数断言完整性
    await expect(window.getByText('中文大文件行0数据')).toBeVisible()
    await expect(window.locator('.status-item').filter({ hasText: '15000 行' })).toBeVisible()
    await expect(window.locator('.pane-meta').filter({ hasText: 'GBK' })).toBeVisible()
    await app.close()
  })
})

test.describe('比较选项端到端', () => {
  test('忽略大小写与忽略所有空白组合生效', async () => {
    const { app, window } = await launchApp()
    await pasteText(window, 'left', 'alpha\nbeta')
    await pasteText(window, 'right', 'ALPHA\n beta')
    // 默认严格对比：两处差异
    await expect(window.getByText('有差异')).toBeVisible()
    // 仅忽略大小写：仍有行首空白差异
    await window.getByLabel('忽略大小写').check()
    await expect(window.getByText('有差异')).toBeVisible()
    // 再忽略所有空白：判为完全一致
    await window.getByLabel('忽略所有空白').check()
    await expect(window.getByText('两文件内容完全一致')).toBeVisible()
    await app.close()
  })

  test('字符级对比：跨行重组判为一致，字符粒度统计徽章出现（0.10.5）', async () => {
    const { app, window } = await launchApp()
    await pasteText(window, 'left', 'ab cd')
    await pasteText(window, 'right', 'ab\ncd')
    await expect(window.getByText('有差异')).toBeVisible()
    await window.getByLabel('字符级对比').check()
    await expect(window.getByText('两文件内容完全一致')).toBeVisible()
    // 字符级模式追加字符粒度增删徽章（一致场景为 +0 字 / −0 字）
    await expect(window.getByText('+0 字')).toBeVisible()
    await expect(window.getByText('−0 字')).toBeVisible()
    await app.close()
  })

  test('字符级大输入：重算期间滚动位置不回弹（0.6.3 回退缺陷的回归锚）', async () => {
    // fixture 严格对齐用户实测场景：真实文件打开 + 行数不等（左 950 / 右 942：改 3 + 删 20 + 插 12），
    // 字符量约 4.7 万 > 重输入阈值（5000）→ 开字符级即进 worker 重路径
    const dir = await makeTmpDir('difflens-e2e-scroll-')
    try {
      const pad = (i: number): string => String(i).padStart(4, '0')
      const left = Array.from({ length: 950 }, (_, i) => `L${pad(i)}-abcdefghijklmnopqrstuvwxyz`)
      const right = [...left]
      right[300] = 'L0300-abcdefghijXlmnopqrstuvwxyz'
      right.splice(530, 20)
      right.splice(
        812,
        0,
        ...Array.from({ length: 12 }, (_, k) => `N${pad(k)}-newcontent-${k}0987654321`)
      )
      const lp = await writeTextFixture(dir, 'left.txt', left.join('\n'))
      const rp = await writeTextFixture(dir, 'right.txt', right.join('\n'))

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[lp], [rp]])
      await window.getByRole('button', { name: '打开左侧' }).click()
      await window.getByText('L0000-abcdefghijklmnopqrstuvwxyz').first().waitFor()
      await window.getByRole('button', { name: '打开右侧' }).click()
      await window.getByText('L0001-abcdefghijklmnopqrstuvwxyz').first().waitFor()

      // 开字符级（首次进入重路径：快路径结果兜底撑住容器高度，不塌陷归零）
      await window.getByLabel('字符级对比').check()
      await window.getByText('有差异').first().waitFor()

      // 滚到中部后二次触发重算（切选项）：computing 期间位置必须保持
      const scrollSel = '.pane-left .diff-scroll'
      await window.evaluate((s) => {
        const el = document.querySelector(s)
        el.scrollTop = 5000
        el.dispatchEvent(new Event('scroll'))
      }, scrollSel)
      expect(await window.evaluate((s) => document.querySelector(s).scrollTop, scrollSel)).toBe(
        5000
      )

      await window.getByLabel('忽略大小写').check()
      await window.waitForTimeout(150)
      // 关键断言：重算期间 scrollTop 不被钳制归零（缺陷版本会多级下坠到 0）
      const during = await window.evaluate((s) => document.querySelector(s).scrollTop, scrollSel)
      expect(during).toBeGreaterThanOrEqual(4000)

      // 重算完成后位置仍稳定
      await window.getByText('有差异').first().waitFor()
      await window.waitForTimeout(300)
      expect(await window.evaluate((s) => document.querySelector(s).scrollTop, scrollSel)).toBe(
        5000
      )

      // 滚到底部验证内容连续无重复渲染错乱
      await window.evaluate((s) => {
        const el = document.querySelector(s)
        el.scrollTop = el.scrollHeight
        el.dispatchEvent(new Event('scroll'))
      }, scrollSel)
      await window.waitForTimeout(300)
      const lastRow = await window.evaluate((s) => {
        const sc = document.querySelector(s)
        const rows = sc.querySelectorAll('.diff-row')
        return rows.length > 0 ? rows[rows.length - 1].textContent : ''
      }, scrollSel)
      expect(lastRow).toContain('L0949')
      await app.close()
    } finally {
      await removeTmpDir(dir)
    }
  })
})

test.describe('差异导航与视图', () => {
  test('F7 / Shift+F7 导航与仅看差异折叠', async () => {
    const { app, window } = await launchApp()
    await pasteText(window, 'left', 'a\nX1\nb\nY1\nc')
    await pasteText(window, 'right', 'a\nX2\nb\nY2\nc')
    await expect(window.getByText('1 / 2')).toBeVisible()
    await window.keyboard.press('F7')
    await expect(window.getByText('2 / 2')).toBeVisible()
    await window.keyboard.press('Shift+F7')
    await expect(window.getByText('1 / 2')).toBeVisible()
    // 仅看差异：未更改行折叠为提示行
    await window.getByLabel('仅看差异').check()
    await expect(window.getByText(/已折叠/).first()).toBeVisible()
    await app.close()
  })

  test('单文件视图搜索：Ctrl+F 聚焦、计数跳转、行内高亮与 Esc 清空（0.9.3）', async () => {
    const { app, window } = await launchApp()
    await pasteText(window, 'left', 'alpha\nfind target one\ngamma\nfind target two')
    await pasteText(window, 'right', 'alpha\nfind target one\ngamma\nfind target two')
    await expect(window.getByText('两文件内容完全一致')).toBeVisible()
    // Ctrl+F 聚焦搜索框
    await window.keyboard.press('Control+f')
    const input = window.getByPlaceholder('搜索内容… (Ctrl+F)')
    await expect(input).toBeFocused()
    // 输入关键字：即时计数与行内命中高亮
    await input.fill('target')
    await expect(window.locator('.search-count')).toHaveText('1 / 2')
    await expect(window.locator('.search-hit').first()).toBeVisible()
    // Enter 跳转下一个命中行（第一个命中行 active 定位）
    await window.keyboard.press('Enter')
    await expect(window.locator('.search-count')).toHaveText('2 / 2')
    await expect(window.locator('.diff-row.active .ln').first()).toHaveText('4')
    // Esc 清空关键字（计数复位消失）
    await window.keyboard.press('Escape')
    await expect(input).toHaveValue('')
    await expect(window.locator('.search-count')).toHaveText('')
    await app.close()
  })

  test('交换左右侧后面板文件互换', async () => {
    const dir = await makeTmpDir('difflens-e2e-swap-')
    try {
      const aPath = await writeTextFixture(dir, 'a.txt', 'aaa')
      const bPath = await writeTextFixture(dir, 'b.txt', 'bbb')
      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[aPath], [bPath]])
      await window.getByRole('button', { name: '打开左侧' }).click()
      await expect(window.locator('.pane-file').filter({ hasText: 'a.txt' })).toBeVisible()
      await window.getByRole('button', { name: '打开右侧' }).click()
      await expect(window.locator('.pane-file').filter({ hasText: 'b.txt' })).toBeVisible()
      await window.getByRole('button', { name: '⇄ 交换左右' }).click()
      // 面板头文件名互换（用 .pane-file 定位，避免与状态栏文件名混淆）
      const paneFiles = window.locator('.pane-file')
      await expect(paneFiles.nth(0)).toHaveText(/b\.txt/)
      await expect(paneFiles.nth(1)).toHaveText(/a\.txt/)
      await app.close()
    } finally {
      await removeTmpDir(dir)
    }
  })
})

test.describe('报告导出（主进程写盘链路）', () => {
  test('导出 HTML 报告：文件落盘且包含结论', async () => {
    const dir = await makeTmpDir('difflens-e2e-report-')
    try {
      const { app, window } = await launchApp()
      await pasteText(window, 'left', 'same\ndiff-left')
      await pasteText(window, 'right', 'same\ndiff-right')
      const savePath = join(dir, 'report.html')
      await stubSaveDialog(app, savePath)
      await window.getByRole('button', { name: '导出报告' }).click()
      await window.getByRole('button', { name: 'HTML 报告' }).click()
      await expect(window.getByText(/报告已保存/)).toBeVisible()
      const html = await readFile(savePath, 'utf-8')
      expect(html).toContain('<!doctype html>')
      expect(html).toContain('共 1 处不同：修改 1 行')
      // 统计卡与未更改行渲染（diff-left 被词级高亮拆分 span，不作整串断言）
      expect(html).toContain('~1')
      expect(html).toContain('same')
      await app.close()
    } finally {
      await removeTmpDir(dir)
    }
  })

  test('导出 Patch 标准差异：unified diff 落盘且含 hunk 头与增删行（0.11.0）', async () => {
    const dir = await makeTmpDir('difflens-e2e-patch-')
    try {
      const { app, window } = await launchApp()
      await pasteText(window, 'left', 'ctx1\nold line\nctx2')
      await pasteText(window, 'right', 'ctx1\nnew line\nctx2')
      const savePath = join(dir, 'changes.patch')
      await stubSaveDialog(app, savePath)
      await window.getByRole('button', { name: '导出报告' }).click()
      await window.getByRole('button', { name: 'Patch 标准差异' }).click()
      await expect(window.getByText(/报告已保存/)).toBeVisible()
      const patch = await readFile(savePath, 'utf-8')
      // 标准 unified diff 结构：文件头 + hunk 头（两侧各 3 行）+ 上下文/增删行
      expect(patch).toMatch(/^--- a\//)
      expect(patch).toContain('+++ b/')
      expect(patch).toContain('@@ -1,3 +1,3 @@')
      expect(patch.split('\n')).toContain(' ctx1')
      expect(patch.split('\n')).toContain('-old line')
      expect(patch.split('\n')).toContain('+new line')
      expect(patch.split('\n')).toContain(' ctx2')
      await app.close()
    } finally {
      await removeTmpDir(dir)
    }
  })

  test('开忽略大小写后 Patch 菜单项禁用（判等污染守卫，0.11.0）', async () => {
    const { app, window } = await launchApp()
    await pasteText(window, 'left', 'same\nBeta')
    await pasteText(window, 'right', 'same\nBETA')
    await window.getByLabel('忽略大小写').check()
    await expect(window.getByText('两文件内容完全一致')).toBeVisible()
    await window.getByRole('button', { name: '导出报告' }).click()
    // 判等选项把 Beta/BETA 判为相同：unchanged 行两侧文本不同，Patch 无法表达
    const item = window.getByRole('button', { name: 'Patch 标准差异' })
    await expect(item).toBeDisabled()
    await app.close()
  })

  test('开忽略空行后 Patch 菜单项禁用（行号省略导致 hunk 错位，0.12.1）', async () => {
    const { app, window } = await launchApp()
    await pasteText(window, 'left', 'a\n\nb')
    await pasteText(window, 'right', 'a\n\nB')
    await window.getByLabel('忽略空行').check()
    await expect(window.getByText('有差异')).toBeVisible()
    await window.getByRole('button', { name: '导出报告' }).click()
    const item = window.getByRole('button', { name: 'Patch 标准差异' })
    await expect(item).toBeDisabled()
    await app.close()
  })
})

test.describe('文件夹对比（主进程真实扫描链路）', () => {
  test('选择两个文件夹：状态判定、过滤与双击进入单文件对比', async () => {
    const root = await makeTmpDir('difflens-e2e-folder-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(join(leftDir, 'sub'), { recursive: true })
      await mkdir(join(rightDir, 'sub'), { recursive: true })
      await wf(join(leftDir, 'same.txt'), 'identical')
      await wf(join(rightDir, 'same.txt'), 'identical')
      await wf(join(leftDir, 'diff.txt'), 'left content\nsame tail')
      await wf(join(rightDir, 'diff.txt'), 'right content\nsame tail')
      await wf(join(leftDir, 'only-left.txt'), 'L')
      await wf(join(leftDir, 'sub', 'nested.txt'), 'nested L')
      await wf(join(rightDir, 'sub', 'nested.txt'), 'nested R')

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()

      // 文件夹模式：路径卡片与统计徽章
      await expect(window.getByText('相同 1')).toBeVisible()
      await expect(window.getByText('不同 2')).toBeVisible()
      await expect(window.getByText('仅左 1')).toBeVisible()
      // 默认仅看差异：same.txt 被过滤，差异条目可见（树形视图显示文件尾段名）
      await expect(window.getByText('diff.txt')).toBeVisible()
      await expect(window.getByText('sub', { exact: true })).toBeVisible()
      await expect(window.getByText('nested.txt')).toBeVisible()
      await expect(window.getByText('same.txt')).toHaveCount(0)

      // 双击差异条目进入单文件对比
      await window.getByText('diff.txt').dblclick()
      await expect(window.getByText('left content')).toBeVisible()
      await expect(window.getByText('right content')).toBeVisible()
      await expect(window.getByText('有差异')).toBeVisible()
      await expect(window.getByRole('button', { name: '← 返回文件夹对比' })).toBeVisible()

      // 返回文件夹列表（扫描结果保留）
      await window.getByRole('button', { name: '← 返回文件夹对比' }).click()
      await expect(window.getByText('相同 1')).toBeVisible()
      await expect(window.getByText('diff.txt')).toBeVisible()
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('根目录不存在/不可读：提示扫描失败，而不是显示全部仅一侧（0.12.1）', async () => {
    const root = await makeTmpDir('difflens-e2e-missing-root-')
    try {
      const missingLeft = join(root, 'missing-left')
      const missingRight = join(root, 'missing-right')
      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[missingLeft], [missingRight]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(window.getByText(/文件夹扫描失败，请检查目录是否存在且可访问/)).toBeVisible()
      await expect(window.getByText('返回文件对比')).toHaveCount(0)
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('增量重扫：修改文件后点重新扫描，状态正确更新', async () => {
    const root = await makeTmpDir('difflens-e2e-rescan-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(leftDir, { recursive: true })
      await mkdir(rightDir, { recursive: true })
      await wf(join(leftDir, 'same.txt'), 'identical')
      await wf(join(rightDir, 'same.txt'), 'identical')
      await wf(join(leftDir, 'diff.txt'), 'left v1')
      await wf(join(rightDir, 'diff.txt'), 'right v1')

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(window.getByText('相同 1')).toBeVisible()
      await expect(window.getByText('不同 1')).toBeVisible()

      // 修改右侧 same.txt（真实 mtime 变化）→ 重新扫描（增量）→ 判定更新
      await wf(join(rightDir, 'same.txt'), 'identical changed')
      await window.getByRole('button', { name: '重新扫描' }).click()
      await expect(window.getByText('相同 0')).toBeVisible()
      await expect(window.getByText('不同 2')).toBeVisible()

      // 改回一致 → 再扫 → 恢复
      await wf(join(rightDir, 'same.txt'), 'identical')
      await window.getByRole('button', { name: '重新扫描' }).click()
      await expect(window.getByText('相同 1')).toBeVisible()
      await expect(window.getByText('不同 1')).toBeVisible()
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('语义判等、树形折叠、搜索与文件夹报告导出', async () => {
    const root = await makeTmpDir('difflens-e2e-folder2-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(join(leftDir, 'sub'), { recursive: true })
      await mkdir(join(rightDir, 'sub'), { recursive: true })
      // 仅换行符差异（左 CRLF 右 LF）→ 语义同
      await wf(join(leftDir, 'crlf.txt'), 'line1\r\nline2\r\n')
      await wf(join(rightDir, 'crlf.txt'), 'line1\nline2\n')
      // 实质内容差异 → 不同
      await wf(join(leftDir, 'real.txt'), 'value = 1\n')
      await wf(join(rightDir, 'real.txt'), 'value = 2\n')
      // 完全一致（子目录）
      await wf(join(leftDir, 'sub', 'same.txt'), 'identical')
      await wf(join(rightDir, 'sub', 'same.txt'), 'identical')

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()

      // 语义判等默认开：crlf.txt 计为语义同（统计徽章）
      await expect(window.getByText('语义同 1')).toBeVisible()
      await expect(window.getByText('不同 1')).toBeVisible()
      // 默认仅看差异：语义同被过滤，只剩 real.txt
      await expect(window.getByText('real.txt')).toBeVisible()
      await expect(window.getByText('crlf.txt')).toHaveCount(0)
      // 关闭仅看差异：树形展示（sub 目录行 + 语义同条目标注）
      await window.getByLabel('仅看差异').uncheck()
      await expect(window.getByText('crlf.txt')).toBeVisible()
      await expect(window.getByText('sub', { exact: true })).toBeVisible()
      await expect(window.getByText('same.txt')).toBeVisible()
      // 目录折叠/展开
      await window.getByText('sub', { exact: true }).click()
      await expect(window.getByText('same.txt')).toHaveCount(0)
      await window.getByText('sub', { exact: true }).click()
      await expect(window.getByText('same.txt')).toBeVisible()
      // 搜索过滤
      await window.getByPlaceholder('搜索文件名…').fill('crlf')
      await expect(window.getByText('crlf.txt')).toBeVisible()
      await expect(window.getByText('real.txt')).toHaveCount(0)
      await window.getByPlaceholder('搜索文件名…').fill('')
      // 导出文件夹报告（真实写盘）
      const savePath = join(root, 'folder-report.txt')
      await stubSaveDialog(app, savePath)
      await window.getByRole('button', { name: '导出报告' }).click()
      await window.getByRole('button', { name: '纯文本' }).click()
      await expect(window.getByText(/报告已保存/)).toBeVisible()
      const txt = await readFile(savePath, 'utf-8')
      expect(txt).toContain('DiffLens 文件夹对比报告')
      expect(txt).toContain('判定口径：语义判等开启')
      expect(txt).toContain('共 1 个文件存在差异')
      expect(txt).toContain('语义同')
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('忽略规则：目录整树剪枝不参与对比（应用后重扫）', async () => {
    const root = await makeTmpDir('difflens-e2e-ignore-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(join(leftDir, 'node_modules', 'pkg'), { recursive: true })
      await mkdir(join(rightDir, 'node_modules', 'pkg'), { recursive: true })
      await wf(join(leftDir, 'keep.txt'), 'identical')
      await wf(join(rightDir, 'keep.txt'), 'identical')
      await wf(join(leftDir, 'node_modules', 'pkg', 'x.js'), 'left')
      await wf(join(rightDir, 'node_modules', 'pkg', 'x.js'), 'right')

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      // 无规则：node_modules 内差异文件参与对比
      await expect(window.getByText('不同 1')).toBeVisible()
      await expect(window.getByText('x.js')).toBeVisible()

      // 应用忽略规则：node_modules/ 整树剪枝
      await window.getByRole('button', { name: '忽略规则' }).click()
      await window.getByPlaceholder(/每行一条/).fill('node_modules/')
      await window.getByText('应用并重扫').click()
      // 重扫完成：无差异（keep.txt 一致，node_modules 被忽略）
      await expect(window.getByText('不同 0')).toBeVisible()
      await expect(window.getByText('没有差异文件（两侧内容全部一致）')).toBeVisible()
      await expect(window.getByText('x.js')).toHaveCount(0)
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('忽略规则高级 glob：** 跨段剪枝、否定规则救回与无效规则提示', async () => {
    const root = await makeTmpDir('difflens-e2e-glob-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      // build 下深层 temp 目录（** 跨段目标）+ 保留文件 + log 类差异文件
      for (const d of [leftDir, rightDir]) {
        await mkdir(join(d, 'build', 'a', 'temp'), { recursive: true })
        await mkdir(join(d, 'build', 'b', 'deep', 'temp'), { recursive: true })
        await wf(join(d, 'build', 'a', 'temp', 't1.txt'), 'L')
        await wf(join(d, 'build', 'b', 'deep', 'temp', 't2.txt'), 'L')
        await wf(join(d, 'build', 'keep.txt'), 'L')
        await wf(join(d, 'app.log'), 'L')
        await wf(join(d, 'keep.log'), 'L')
      }
      await wf(join(rightDir, 'build', 'a', 'temp', 't1.txt'), 'R')
      await wf(join(rightDir, 'build', 'b', 'deep', 'temp', 't2.txt'), 'R')
      await wf(join(rightDir, 'build', 'keep.txt'), 'R')
      await wf(join(rightDir, 'app.log'), 'R')
      await wf(join(rightDir, 'keep.log'), 'R')

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(window.getByText('不同 5')).toBeVisible()

      await window.getByRole('button', { name: '忽略规则' }).click()
      // 先输入含无效规则的草稿：提示出现（不再静默丢弃）
      await window.getByPlaceholder(/每行一条/).fill('a**b')
      await expect(window.getByText(/将被忽略的无效规则：a\*\*b/)).toBeVisible()
      // 替换为正式规则：build 下任意深度 temp 剪枝 + *.log 忽略 + keep.log 否定救回
      await window.getByPlaceholder(/每行一条/).fill('build/**/temp\n*.log\n!keep.log')
      await window.getByText('应用并重扫').click()
      // t1/t2 被剪（** 跨段）、app.log 被忽略、keep.log 被否定救回 → 仅剩 keep.txt 与 keep.log 差异
      await expect(window.getByText('不同 2')).toBeVisible()
      await expect(window.getByText('t1.txt')).toHaveCount(0)
      await expect(window.getByText('keep.log')).toBeVisible()
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('扫描进度反馈：大目录比对期间遮罩显示已比对进度', async () => {
    const root = await makeTmpDir('difflens-e2e-progress-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(leftDir, { recursive: true })
      await mkdir(rightDir, { recursive: true })
      // 4000 个大小一致条目需读内容比对（250 个并发批次）：快机上比对窗口约数百毫秒，
      // 进度文本存在时间足够被轮询采样抓到（2000 条在快机上仅 ~120ms，采样易错过）
      for (let i = 0; i < 4000; i++) {
        const name = `f${String(i).padStart(4, '0')}.txt`
        await wf(join(leftDir, name), `L${i}`)
        await wf(join(rightDir, name), `R${i}`)
      }

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      // 瞬态进度文案：轮询抓取扫描期间的遮罩文本（完成后遮罩消失）。
      // evaluate 直读 DOM：遮罩消失后 querySelector 返回空串立即结束本轮采样，
      // 避免 locator.textContent() 的自动重试在元素消失后阻塞 10s 吞掉后续采样窗口；
      // intervals 前密后疏，抓住数百毫秒级的瞬态窗口
      await expect
        .poll(
          async () =>
            /已比对 \d+ \/ 4000/.test(
              (await window.evaluate(
                () => document.querySelector('.computing-overlay')?.textContent ?? ''
              )) ?? ''
            ),
          { intervals: [50, 100] }
        )
        .toBe(true)
      // 扫描完成：全量判定与遮罩消失
      await expect(window.getByText('不同 4000')).toBeVisible()
      await expect(window.locator('.computing-overlay')).toHaveCount(0)
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('增量缓存跨会话持久化：落盘文件存在且重启后重扫正确', async () => {
    const root = await makeTmpDir('difflens-e2e-cachestore-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(leftDir, { recursive: true })
      await mkdir(rightDir, { recursive: true })
      await wf(join(leftDir, 'same.txt'), 'identical')
      await wf(join(rightDir, 'same.txt'), 'identical')
      await wf(join(leftDir, 'diff.txt'), 'left v1')
      await wf(join(rightDir, 'diff.txt'), 'right v1')

      // 第一实例：扫描后缓存异步落盘 userData/scan-cache.json
      const first = await launchApp()
      await stubOpenDialogSeq(first.app, [[leftDir], [rightDir]])
      await first.window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(first.window.getByText('相同 1')).toBeVisible()
      const cachePath = await first.app
        .evaluate(({ app }) => app.getPath('userData'))
        .then((userData) => join(userData, 'scan-cache.json'))
      await first.app.close()

      // 落盘文件存在且含本目录对的缓存条目（等待异步写盘完成）
      let raw = ''
      for (let i = 0; i < 20; i++) {
        raw = await readFile(cachePath, 'utf-8').catch(() => '')
        if (raw.includes('same.txt')) break
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(raw).toContain('same.txt')
      expect(raw).toContain('diff.txt')
      // 结构为合法存储（版本 + 目录对键）
      const stored = JSON.parse(raw)
      expect(stored.version).toBe(2)
      expect(Object.keys(stored.pairs).length).toBeGreaterThanOrEqual(1)

      // 第二实例（同 userData，渲染端无内存缓存）：主进程注入盘上缓存，重扫结果正确
      const second = await launchApp({ fresh: false })
      await stubOpenDialogSeq(second.app, [[leftDir], [rightDir]])
      await second.window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(second.window.getByText('相同 1')).toBeVisible()
      await expect(second.window.getByText('不同 1')).toBeVisible()
      await second.app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('快照基线：保存后修复差异并新增文件，加载快照对照变迁', async () => {
    const root = await makeTmpDir('difflens-e2e-snapshot-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(leftDir, { recursive: true })
      await mkdir(rightDir, { recursive: true })
      await wf(join(leftDir, 'same.txt'), 'identical')
      await wf(join(rightDir, 'same.txt'), 'identical')
      await wf(join(leftDir, 'diff.txt'), 'left v1')
      await wf(join(rightDir, 'diff.txt'), 'right v1')

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(window.getByText('相同 1')).toBeVisible()
      await expect(window.getByText('不同 1')).toBeVisible()

      // 保存快照（真实写盘）：v2 结构含差异条目双侧内容（0.10.0 内容级对照）；
      // 快照归组下拉（0.10.5 布局重构）：先开「快照」下拉再点菜单项
      const snapPath = join(root, 'baseline.json')
      await stubSaveDialog(app, snapPath)
      await window.getByRole('button', { name: '快照' }).click()
      await window.getByText('保存快照…').click()
      await expect(window.getByText(/快照已保存/)).toBeVisible()
      const snapRaw = await readFile(snapPath, 'utf-8')
      expect(snapRaw).toContain('"version": 2')
      expect(snapRaw).toContain('diff.txt')
      expect(snapRaw).toContain('left v1')
      expect(snapRaw).toContain('right v1')

      // 修复 diff.txt（两侧一致）+ 新增 new.txt → 重扫
      await wf(join(rightDir, 'diff.txt'), 'left v1')
      await wf(join(leftDir, 'new.txt'), 'n')
      await wf(join(rightDir, 'new.txt'), 'n')
      await window.getByRole('button', { name: '重新扫描' }).click()
      await expect(window.getByText('相同 3')).toBeVisible()

      // 加载快照对照：diff.txt 已修复、new.txt 新文件
      await stubOpenDialogSeq(app, [[snapPath]])
      await window.getByRole('button', { name: '快照' }).click()
      await window.getByText('加载快照…').click()
      await expect(window.getByText(/已加载快照/)).toBeVisible()
      await expect(window.getByText('已修复 1')).toBeVisible()
      await expect(window.getByText('新文件 1')).toBeVisible()
      // 对照条目行（平铺）与变迁标注可见
      await expect(window.getByText('diff.txt')).toBeVisible()
      await expect(window.getByText('new.txt')).toBeVisible()
      // 对照模式导出报告：条目表为变迁对照表（真实写盘断言变迁明细）
      const cmpPath = join(root, 'compare-report.txt')
      await stubSaveDialog(app, cmpPath)
      await window.getByRole('button', { name: '导出报告' }).click()
      await window.getByRole('button', { name: '纯文本' }).click()
      await expect(window.getByText(/报告已保存/)).toBeVisible()
      const cmp = await readFile(cmpPath, 'utf-8')
      expect(cmp).toContain('快照对照：修复 1')
      expect(cmp).toContain('已修复')
      expect(cmp).toContain('新文件')
      expect(cmp).toContain('保持一致')
      // 退出对照恢复
      await window.getByRole('button', { name: '退出对照' }).click()
      await expect(window.getByText('相同 3')).toBeVisible()
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('快照内容级对照：保存含内容快照 → 修改文件 → 对照双击查看基线 vs 当前', async () => {
    const root = await makeTmpDir('difflens-e2e-snapcontent-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(leftDir, { recursive: true })
      await mkdir(rightDir, { recursive: true })
      await wf(join(leftDir, 'same.txt'), 'identical')
      await wf(join(rightDir, 'same.txt'), 'identical')
      await wf(join(leftDir, 'diff.txt'), 'snapshot baseline value A')
      await wf(join(rightDir, 'diff.txt'), 'snapshot baseline value B')

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[leftDir], [rightDir]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(window.getByText('相同 1')).toBeVisible()
      await expect(window.getByText('不同 1')).toBeVisible()

      // 保存快照（v2）：差异条目双侧内容写入 JSON
      const snapPath = join(root, 'baseline.json')
      await stubSaveDialog(app, snapPath)
      await window.getByRole('button', { name: '快照' }).click()
      await window.getByText('保存快照…').click()
      await expect(window.getByText(/快照已保存/)).toBeVisible()
      const snapRaw = await readFile(snapPath, 'utf-8')
      expect(snapRaw).toContain('"version": 2')
      expect(snapRaw).toContain('snapshot baseline value A')
      expect(snapRaw).toContain('snapshot baseline value B')

      // 修改左侧 diff.txt → 重扫（相对快照基线出现内容变化）
      await wf(join(leftDir, 'diff.txt'), 'current changed value A')
      await window.getByRole('button', { name: '重新扫描' }).click()
      await expect(window.getByText('不同 1')).toBeVisible()

      // 加载快照对照 → 双击 diff.txt 进入内容对照（左=快照基线，右=当前左侧文件）
      await stubOpenDialogSeq(app, [[snapPath]])
      await window.getByRole('button', { name: '快照' }).click()
      await window.getByText('加载快照…').click()
      await expect(window.getByText(/已加载快照/)).toBeVisible()
      await window.getByText('diff.txt').dblclick()
      await expect(
        window.locator('.pane-file').filter({ hasText: '快照 · diff.txt' })
      ).toBeVisible()
      // 左面板渲染快照基线旧词、右面板渲染当前新词（词级高亮拆分为独立段）
      await expect(window.getByText('snapshot', { exact: true })).toBeVisible()
      await expect(window.getByText('current', { exact: true })).toBeVisible()
      await expect(window.getByText('有差异')).toBeVisible()
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })

  test('加载自身截断的快照被拦截（手工构造快照的对称防呆，0.10.4）', async () => {
    const root = await makeTmpDir('difflens-e2e-snaptrunc-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(leftDir, { recursive: true })
      await mkdir(rightDir, { recursive: true })
      await wf(join(leftDir, 'same.txt'), 'identical')
      await wf(join(rightDir, 'same.txt'), 'identical')

      // 手工构造截断快照（自家保存链路在截断时已拦截，此形态仅来自外部）：
      // 截断快照缺失的文件会被全部误报为"新文件"，加载时须拦截
      const snap = {
        version: 2,
        leftDir,
        rightDir,
        semantic: true,
        truncated: true,
        total: 9999,
        entries: [{ rel: 'same.txt', status: 'same', leftSize: 9, rightSize: 9 }],
        savedAt: Date.now()
      }
      const snapPath = join(root, 'truncated-snapshot.json')
      await wf(snapPath, JSON.stringify(snap), 'utf-8')

      const { app, window } = await launchApp()
      // 对话框调用序：folder:pick 左 → folder:pick 右 → snapshot:read 快照
      await stubOpenDialogSeq(app, [[leftDir], [rightDir], [snapPath]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(window.getByText('相同 1')).toBeVisible()
      await window.getByRole('button', { name: '快照' }).click()
      await window.getByText('加载快照…').click()
      // 拦截提示出现，不进入对照模式
      await expect(window.getByText(/条目不完整无法对照/)).toBeVisible()
      await expect(window.getByText(/已加载快照/)).toHaveCount(0)
      await expect(window.getByRole('button', { name: '退出对照' })).toHaveCount(0)
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })
})

test.describe('拖拽导入（真实 Chromium DataTransfer 链路）', () => {
  test('空面板拖入文件：内容渲染与文件名显示', async () => {
    const { app, window } = await launchApp()
    await dropFiles(window, '.pane-empty', [
      { name: 'dropped-left.txt', content: 'drag line 1\ndrag line 2' }
    ])
    // 文件名出现在面板头，内容渲染（file.arrayBuffer → decodeBuffer IPC → 编码探测全链路）
    await expect(window.locator('.pane-file').filter({ hasText: 'dropped-left.txt' })).toBeVisible()
    await expect(window.getByText('drag line 1').first()).toBeVisible()
    await app.close()
  })

  test('双侧拖入形成对比：差异渲染', async () => {
    const { app, window } = await launchApp()
    await dropFiles(window, '.pane-empty', [{ name: 'a.txt', content: 'same\nleft-unique' }])
    // 左侧装载后进入对比视图：右侧为 DiffView 面板（.pane-right），不再是空态
    await dropFiles(window, '.pane-right', [{ name: 'b.txt', content: 'same\nright-unique' }])
    await expect(window.getByText('有差异')).toBeVisible()
    await expect(window.getByText('left-unique').first()).toBeVisible()
    await expect(window.getByText('right-unique').first()).toBeVisible()
    await app.close()
  })

  test('拖入非文本扩展名被拒绝并提示', async () => {
    const { app, window } = await launchApp()
    await dropFiles(window, '.pane-empty', [
      { name: 'image.png', content: 'fake-binary', type: 'image/png' }
    ])
    await expect(window.getByText(/仅支持文本文件：image\.png/)).toBeVisible()
    // 保持空态（无导出入口）
    await expect(window.getByRole('button', { name: '导出报告' })).toHaveCount(0)
    await app.close()
  })

  test('多文件拖入提示已取第一个并加载首个文件', async () => {
    const { app, window } = await launchApp()
    await dropFiles(window, '.pane-empty', [
      { name: 'first.txt', content: 'first content' },
      { name: 'second.txt', content: 'second content' }
    ])
    await expect(window.getByText(/一次只能导入一个文件/)).toBeVisible()
    await expect(window.locator('.pane-file').filter({ hasText: 'first.txt' })).toBeVisible()
    await app.close()
  })

  test('dotfile 拖入按文本放行（.gitignore，0.12.1）', async () => {
    const { app, window } = await launchApp()
    await dropFiles(window, '.pane-empty', [
      { name: '.gitignore', content: 'node_modules/\ndist/\n' }
    ])
    await expect(window.locator('.pane-file').filter({ hasText: '.gitignore' })).toBeVisible()
    await expect(window.getByText('node_modules/').first()).toBeVisible()
    await app.close()
  })
})

test.describe('偏好持久化（跨实例重启）', () => {
  test('重启后恢复比较选项与视图开关', async () => {
    // 第一实例 fresh 清掉历史残留，建立干净基线后再写入偏好
    const first = await launchApp({ fresh: true })
    await pasteText(first.window, 'left', 'alpha')
    await first.window.getByLabel('忽略大小写').check()
    await first.window.getByLabel('仅看差异').check()
    await expect(first.window.getByLabel('忽略大小写')).toBeChecked()
    // 等 localStorage 写回完成再关闭
    await first.window.waitForTimeout(500)
    await first.app.close()

    // 同一 userData 下重启（不清理）：偏好应恢复
    const second = await launchApp({ fresh: false })
    await pasteText(second.window, 'left', 'alpha')
    await expect(second.window.getByLabel('忽略大小写')).toBeChecked()
    await expect(second.window.getByLabel('仅看差异')).toBeChecked()
    await second.app.close()
  })
})

test.describe('关于弹框（0.10.2）', () => {
  test('点击关于按钮展示应用信息，点击邮箱复制，Esc 关闭', async () => {
    const { app, window } = await launchApp()
    await window.getByTitle('关于 DiffLens').click()
    // 版本号来自主进程 app.getVersion()（package.json 为唯一来源，0.x 形态）
    await expect(window.locator('.about-version')).toHaveText(/^版本 0\.\d+\.\d+$/)
    await expect(window.locator('.about-modal')).toContainText('DiffLens')
    await expect(window.locator('.about-modal')).toContainText('ThzxxArt')
    await expect(window.locator('.about-modal')).toContainText('stinanimz@gmail.com')
    await expect(window.locator('.about-modal')).toContainText('1440196015@qq.com')
    await expect(window.locator('.about-modal')).toContainText(
      'https://github.com/ThzxxArt/DiffLens'
    )
    await expect(window.locator('.about-modal')).toContainText('MIT License')
    // 点击邮箱复制到剪贴板（主进程剪贴板链路）+ toast 反馈
    await window.getByText('stinanimz@gmail.com').click()
    await expect(window.getByText(/邮箱已复制到剪贴板/)).toBeVisible()
    // Esc 关闭弹框
    await window.keyboard.press('Escape')
    await expect(window.locator('.about-modal')).toHaveCount(0)
    await app.close()
  })
})

test.describe('大快照加载（0.10.2 专用读取通道）', () => {
  test('超过 10MB 的快照可正常加载对照（通用文件上限不再拦截自家快照）', async () => {
    const root = await makeTmpDir('difflens-e2e-bigsnap-')
    try {
      const leftDir = join(root, 'left')
      const rightDir = join(root, 'right')
      const { mkdir, writeFile: wf } = await import('fs/promises')
      await mkdir(leftDir, { recursive: true })
      await mkdir(rightDir, { recursive: true })
      await wf(join(leftDir, 'same.txt'), 'identical')
      await wf(join(rightDir, 'same.txt'), 'identical')

      // 手工构造 11MB+ 快照（contents 塞大字符串）：旧通道 file:open 的 10MB 上限会拦截
      const snap = {
        version: 2,
        leftDir,
        rightDir,
        semantic: true,
        truncated: false,
        total: 1,
        entries: [{ rel: 'same.txt', status: 'same', leftSize: 9, rightSize: 9 }],
        savedAt: Date.now(),
        contents: { 'same.txt': { left: 'x'.repeat(11 * 1024 * 1024), right: null } }
      }
      const snapPath = join(root, 'big-snapshot.json')
      await wf(snapPath, JSON.stringify(snap), 'utf-8')

      const { app, window } = await launchApp()
      // 对话框调用序：folder:pick 左 → folder:pick 右 → snapshot:read 快照
      await stubOpenDialogSeq(app, [[leftDir], [rightDir], [snapPath]])
      await window.getByRole('button', { name: '对比文件夹' }).click()
      await expect(window.getByText('相同 1')).toBeVisible()
      await window.getByRole('button', { name: '快照' }).click()
      await window.getByText('加载快照…').click()
      // 专用通道（128MB 上限）加载成功：出现对照 toast，而非"文件超过 10MB"拦截
      await expect(window.getByText(/已加载快照/)).toBeVisible()
      await expect(window.getByText(/文件超过 10MB/)).toHaveCount(0)
      await app.close()
    } finally {
      await removeTmpDir(root)
    }
  })
})

test.describe('大文件性能基准（耗时上限断言）', () => {
  // 口径说明：万级行 diff 在 worker 后台实测为秒级；上限按慢机约 4 倍余量放宽
  // 防 CI flaky（用例超时 60s 兜底）。断言失败即性能回归，需排查引擎/IO 退化。
  test('5 万行多差异文件：后台计算完成在耗时上限内', async () => {
    const dir = await makeTmpDir('difflens-e2e-perf-diff-')
    try {
      const n = 50000
      const pad = (i: number): string => String(i).padStart(5, '0')
      const left = Array.from({ length: n }, (_, i) => `L${pad(i)}-${'x'.repeat(30)}`)
      const right = [...left]
      // 20 处分散修改（每 2500 行一处）
      for (let i = 0; i < n; i += 2500) right[i] = `R${pad(i)}-${'y'.repeat(30)}`
      const lp = await writeTextFixture(dir, 'big-left.txt', left.join('\n'))
      const rp = await writeTextFixture(dir, 'big-right.txt', right.join('\n'))

      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[lp], [rp]])
      await window.getByRole('button', { name: '打开左侧' }).click()
      await window.getByText('L00000-').first().waitFor()
      // 计时：打开右侧 → worker 重路径计算完成（有差异徽章出现）
      const t0 = Date.now()
      await window.getByRole('button', { name: '打开右侧' }).click()
      await window.getByText('有差异').first().waitFor()
      const elapsed = Date.now() - t0
      expect(elapsed).toBeLessThan(15000)
      // 完整性：双侧 5 万行均已加载
      await expect(window.locator('.status-item').filter({ hasText: '50000 行' })).toHaveCount(2)
      await app.close()
    } finally {
      await removeTmpDir(dir)
    }
  })

  test('大体积 GBK 文件：worker 后台解码渲染在耗时上限内', async () => {
    const dir = await makeTmpDir('difflens-e2e-perf-gbk-')
    try {
      // 约 300KB（≥ 解码 worker 快路径阈值 256KB），15000 行
      const bigLines = Array.from({ length: 15000 }, (_, i) => `中文大文件行${i}数据`).join('\n')
      const bigPath = await writeTextFixture(dir, 'big-gbk.txt', bigLines, 'gbk')
      const { app, window } = await launchApp()
      await stubOpenDialogSeq(app, [[bigPath]])
      const t0 = Date.now()
      await window.getByRole('button', { name: '打开左侧' }).click()
      // 完整渲染以状态栏总行数为准（末行在虚拟滚动视口外）
      await expect(window.locator('.status-item').filter({ hasText: '15000 行' })).toBeVisible()
      const elapsed = Date.now() - t0
      expect(elapsed).toBeLessThan(10000)
      await expect(window.getByText('中文大文件行0数据')).toBeVisible()
      await app.close()
    } finally {
      await removeTmpDir(dir)
    }
  })
})
