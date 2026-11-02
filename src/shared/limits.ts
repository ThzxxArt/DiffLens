/**
 * 跨进程共享的容量上限（主进程与渲染端打包各自引用同一源文件，避免双端漂移）。
 * 这些值同时影响文件读取、语义判等、快照保存与加载，修改时必须同步评估两侧行为。
 */

/** 单侧文本文件大小上限（10MB）：超限直接拦截，避免超大文件卡死界面 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 文件夹语义判等的单文件大小上限（2MB）：覆盖绝大多数源码/配置，超大文件维持字节级判定 */
export const SEMANTIC_MAX_BYTES = 2 * 1024 * 1024

/** 快照内容保存的单文件字节上限（对齐语义判等上限） */
export const SNAPSHOT_FILE_MAX_BYTES = SEMANTIC_MAX_BYTES

/** 快照文件读取上限（128MB）：快照为应用自有 JSON，可大于通用文件的 10MB */
export const SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024

/** 快照内容总量上限（字符数）：差异条目内容合计超出时整体降级为纯状态快照 */
export const SNAPSHOT_CONTENTS_MAX_CHARS = 32 * 1024 * 1024
