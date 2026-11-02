/**
 * 允许打开/拖拽/语义判等的文本类扩展名清单（小写，不含点）。
 * 位于 src/shared：主进程（打开文件对话框筛选与文件夹语义判等的文本判定）
 * 与渲染端（拖拽入口的文本校验）打包各自引用同一源文件——两进程无法共享
 * 运行时模块但可共享源码（与 ignoreRules 同款模式），文本判定收敛为
 * `isTextFileName` 单一实现，消除双端口径漂移。
 */
/** 常见无扩展名文本文件（大小写不敏感，按完整文件名匹配） */
const TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'jenkinsfile',
  'procfile',
  'vagrantfile',
  'rakefile',
  'gemfile',
  'brewfile'
])

export const TEXT_EXTENSIONS: string[] = [
  'txt',
  'text',
  'md',
  'markdown',
  'json',
  'js',
  'mjs',
  'cjs',
  'ts',
  'mts',
  'cts',
  'tsx',
  'jsx',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'xml',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'properties',
  'env',
  'py',
  'java',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'swift',
  'kt',
  'rb',
  'php',
  'pl',
  'sh',
  'zsh',
  'bash',
  'fish',
  'bat',
  'cmd',
  'ps1',
  'log',
  'csv',
  'tsv',
  'sql',
  'vue',
  'svelte',
  'graphql',
  'gql',
  'gradle',
  'lock'
]

/**
 * 判断文件名是否为允许的文本文件（两进程共用单一实现）。
 * - 以 `.` 开头的 dotfile（.gitignore / .env.local / .editorconfig）按文本放行；
 * - 常见无扩展名文件名（Dockerfile / Makefile）按文本放行；
 * - 无扩展名文件按文本尝试放行；
 * - 有扩展名时按白名单判断（大小写不敏感）。
 * 入参可以是纯文件名或含目录的相对/绝对路径，内部只取最后一段文件名。
 */
export function isTextFileName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? ''
  if (base === '') return false
  if (base.startsWith('.')) return true
  const lower = base.toLowerCase()
  if (TEXT_FILENAMES.has(lower)) return true
  // Dockerfile.dev / Dockerfile.prod 等变体
  if (lower.startsWith('dockerfile.')) return true
  const dot = base.lastIndexOf('.')
  if (dot < 0) return true
  return TEXT_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase())
}
