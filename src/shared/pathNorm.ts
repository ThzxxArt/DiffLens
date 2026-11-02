/**
 * 路径归一化纯逻辑（无进程 API 依赖，两进程共用同一源文件）。
 * 主进程 scanCacheStore 的目录对键与渲染端 snapshotDiff 的目录对匹配、
 * App 的同目录防呆共用同一实现——Windows 大小写不敏感文件系统下
 * C:\Foo 与 c:/Foo 为同一目录，逐字符比较会误判不一致。
 */
export function normDir(p: string): string {
  let s = p.replace(/\\/g, '/')
  // Windows 盘符根（C:/、C:\、C://）保留根斜杠：C:/ 是根目录，C: 是驱动器相对路径，
  // 二者不是同一个位置；统一成 c:/ 后也不会与 C: 撞键
  if (/^[A-Za-z]:\/+$/.test(s)) return s[0].toLowerCase() + ':/'
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  if (s.length >= 2 && s[1] === ':') s = s[0].toLowerCase() + s.slice(1)
  return s
}
