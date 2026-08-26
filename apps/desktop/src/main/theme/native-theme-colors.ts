/**
 * 进程侧主题背景色（dev.50 深色白缝修复）
 *
 * 背景：网页区是叠在 React UI 之上的 Electron BrowserView，与四周 React
 * 预留区域之间存在 DPI 取整级缝隙；缝隙透出的下层背景若为硬编码白色，
 * 深色模式下即表现为「网页四边白色分割线」。此前的白源：
 * - 主窗口 backgroundColor '#ffffff'（create-window）
 * - BrowserView 加载背景 '#ffffff'（create-browser-view）
 * - 渲染层网页区容器 bg-white（App.tsx，已同步改用 bg-surface 令牌）
 *
 * 单一真源：亮/暗两值与渲染层 tokens.css 的 --color-surface 对齐
 * （light #ffffff / dark #0f172a），主题切换时由 ui.theme.set 处理统一
 * 刷新窗口与已存在 BrowserView 的背景色。
 *
 * 约束：仅改背景「颜色」，绝不引入透明合成——透明 BrowserView 是
 * Windows DWM 压力导致 TDR 桌面卡死的根源（create-browser-view 教训）。
 */
import { nativeTheme } from 'electron';

/** 窗口 / BrowserView 加载背景色（与渲染层 --color-surface 令牌一致） */
export const THEME_BACKGROUNDS = {
  light: '#ffffff',
  dark: '#0f172a',
} as const;

/** 纯函数：按是否暗色取背景色（可单测） */
export function themeBackgroundFor(dark: boolean): string {
  return dark ? THEME_BACKGROUNDS.dark : THEME_BACKGROUNDS.light;
}

/** 当前生效主题对应的背景色（nativeTheme 实际解析值，含跟随系统的结果） */
export function currentThemeBackground(): string {
  return themeBackgroundFor(nativeTheme.shouldUseDarkColors);
}
