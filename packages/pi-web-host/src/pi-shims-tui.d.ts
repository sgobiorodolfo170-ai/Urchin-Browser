/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-indexed-object-style -- vendored pi 边界的 ambient shim：`any` 与索引签名是刻意的宽松锚点 */
/**
 * `@earendil-works/pi-tui` 的 ambient 类型 shim（`src` 侧正式版）。
 *
 * 背景同 `pi-shims-coding-agent.d.ts`：该包是 vendored 依赖，`node_modules` 里没有实体，
 * 构建期由 esbuild 别名指向 `vendor/pi/packages/tui/src`，`tsc` 找不到 `.d.ts`。
 *
 * 本项目只在 `webui-context.ts` / `virtual-tui.ts` 里用到少量类型，且都当作不透明值传递：
 * - `Component`：扩展自定义 UI 组件（`render(width)` + 可选 `dispose()`）
 * - `OverlayOptions` / `OverlayHandle`：浮层配置与句柄，由 `VirtualTuiBridge` 转译
 * - `Terminal`：`VirtualTerminal` 实现的终端接口
 * - `CURSOR_MARKER` / `visibleWidth` / `KeybindingsManager` / `TUI_KEYBINDINGS`：虚拟 TUI 的渲染与键位
 *
 * 真实定义见 `vendor/pi/packages/tui/src/{tui,keys,utils,keybindings}.ts`（1.4.0，与
 * `node_modules/@earendil-works/pi-tui/dist/*.d.ts` 同版核对）。这里不逐一建模上百个成员，
 * 用索引签名保持「可访问但不误伤」。
 *
 * 只声明类型，不改变任何运行时行为。
 */
declare module '@earendil-works/pi-tui' {
  /** `tui.ts` 的 `Component`：能渲染成若干行 ANSI 文本，可选释放资源。 */
  export interface Component {
    render(width: number): string[];
    dispose?(): void;
    [key: string]: any;
  }

  /** `tui.ts` 的 `OverlayOptions`：浮层定位/尺寸等选项。 */
  export interface OverlayOptions {
    [key: string]: any;
  }

  /** `tui.ts` 的 `OverlayHandle`：浮层句柄（hide / focus / getBounds …）。 */
  export interface OverlayHandle {
    [key: string]: any;
  }

  /** 可聚焦组件（扩展自定义 UI 用）。 */
  export interface Focusable {
    [key: string]: any;
  }

  /** `tui.ts` 的 `Terminal`：虚拟终端需要实现的接口（`virtual-tui.ts` 用到）。 */
  export interface Terminal {
    [key: string]: any;
  }

  /** `keys.ts`：标记光标位置的隐藏字符（渲染后用 `visibleWidth` 反算列号）。 */
  export const CURSOR_MARKER: string;

  /** `utils.ts`：按终端可见宽度计算字符串列数（忽略 ANSI 与零宽字符）。 */
  export function visibleWidth(text: string): number;

  /** `keybindings.ts` 的 `TUI_KEYBINDINGS`（默认键位表）。 */
  export const TUI_KEYBINDINGS: Record<string, unknown>;

  /** `keybindings.ts` 的 `KeybindingsManager`。 */
  export class KeybindingsManager {
    constructor(keybindings?: Record<string, unknown>);
    [key: string]: any;
  }
}
