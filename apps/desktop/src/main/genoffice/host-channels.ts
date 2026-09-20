/**
 * GenOffice 编辑器宿主通道（阶段 2）
 *
 * 背景：GenOffice 编辑器渲染层启动时调用一组「应用级」通道，这些通道原本由
 * GenOffice 自家 shell 注册（apps/shell/src/main/index.ts），嵌入外部宿主后
 * 必须由宿主补齐，否则编辑器启动日志出现 "No handler registered"（功能不受
 * 影响但不符合生产级标准）：
 * - app:get-theme / app:theme-changed：主题跟随（宿主主题系统为真源）
 * - app:get-auto-save-default：自动保存默认开关（宿主无此设置 → 恒定关闭，由
 *   编辑器工具条手动保存；后续如需开放再接入 Urchin 设置）
 * - app:get-ai-panel-prefs / app:set-ai-panel-prefs：AI 面板布局偏好（阶段 2
 *   仅内存回显，不持久化——阶段 3 移植 SettingsModal 时统一定义存储）
 *
 * 语言通道（app:get-language）由各编辑器 main 模块自注册（markdown-main 内），
 * 宿主不重复注册（重复注册会抛 "second handler"）。
 */
import type { IpcMain } from 'electron';

/** AI 面板偏好（与 packages/ui/src/ai-panel-prefs.ts 形状一致）。 */
export interface GenOfficeAiPanelPrefs {
  side: 'left' | 'right';
  fontSize: 'default' | 'large' | 'xlarge' | 'custom';
  customFontSize: number;
  spellcheck: boolean;
}

export const DEFAULT_AI_PANEL_PREFS: GenOfficeAiPanelPrefs = {
  side: 'left',
  fontSize: 'default',
  customFontSize: 14,
  spellcheck: true,
};
export interface GenOfficeHostChannelDeps {
  /** 宿主当前主题（'light' | 'dark' | 'system'）。 */
  readonly getTheme: () => string;
  /** 共享的 AI 面板偏好存储（缺省内部新建；GenOffice Home 与编辑器共用同一份）。 */
  readonly aiPanelPrefs?: GenOfficeAiPanelPrefsStore;
}

/** AI 面板偏好存储（内存；Home 设置与编辑器侧切按钮共用）。 */
export interface GenOfficeAiPanelPrefsStore {
  get(): GenOfficeAiPanelPrefs;
  set(patch: unknown): GenOfficeAiPanelPrefs;
}

/** 创建 AI 面板偏好存储（带补丁合并与数值夹取，未知字段回落旧值）。 */
export function createAiPanelPrefsStore(): GenOfficeAiPanelPrefsStore {
  let prefs: GenOfficeAiPanelPrefs = { ...DEFAULT_AI_PANEL_PREFS };
  return {
    get: () => prefs,
    set(patch: unknown) {
      const raw =
        patch !== null && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
      prefs = {
        side: raw.side === 'left' || raw.side === 'right' ? raw.side : prefs.side,
        fontSize:
          raw.fontSize === 'default' ||
          raw.fontSize === 'large' ||
          raw.fontSize === 'xlarge' ||
          raw.fontSize === 'custom'
            ? raw.fontSize
            : prefs.fontSize,
        customFontSize:
          typeof raw.customFontSize === 'number' && Number.isFinite(raw.customFontSize)
            ? Math.min(32, Math.max(10, Math.round(raw.customFontSize)))
            : prefs.customFontSize,
        spellcheck: typeof raw.spellcheck === 'boolean' ? raw.spellcheck : prefs.spellcheck,
      };
      return prefs;
    },
  };
}

/**
 * 注册 GenOffice 宿主通道（幂等由调用方保证：整个应用生命周期只调用一次）。
 */
export function registerGenOfficeHostChannels(
  ipcMain: IpcMain,
  deps: GenOfficeHostChannelDeps,
): void {
  const prefs = deps.aiPanelPrefs ?? createAiPanelPrefsStore();
  ipcMain.handle('app:get-theme', () => deps.getTheme());
  ipcMain.handle('app:get-auto-save-default', () => ({ on: false, updatedAt: 0 }));
  ipcMain.handle('app:get-ai-panel-prefs', () => prefs.get());
  ipcMain.handle('app:set-ai-panel-prefs', (_event, patch: unknown) => prefs.set(patch));
}
