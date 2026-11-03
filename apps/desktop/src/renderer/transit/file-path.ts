/**
 * 中转区 / 拖放 · OS 文件路径解析
 *
 * Electron 32+ 移除了 `File.path`（本项目 Electron 43），拖入的 File 对象
 * 不再携带磁盘路径，必须经 preload 暴露的 `webUtils.getPathForFile` 获取。
 * 这里统一收口路径解析，避免各投放区重复实现时漏掉新版 API。
 *
 * 旧版 `file.path` 仅作回退：兼容未升级 Electron 的运行环境与历史测试替身。
 */

interface PathBridge {
  readonly pathForFile?: (file: File) => string;
}

/** 解析 OS 拖入文件的磁盘路径；取不到时返回 ''（调用方据此跳过该文件） */
export function resolveDroppedFilePath(file: File): string {
  const bridge = (window as unknown as { urchin?: PathBridge }).urchin;
  try {
    const viaBridge = bridge?.pathForFile?.(file);
    if (viaBridge) return viaBridge;
  } catch {
    // preload 已内部兜底，这里再防一次跨上下文传递异常
  }

  const legacy = (file as File & { path?: string }).path;
  return typeof legacy === 'string' ? legacy : '';
}
