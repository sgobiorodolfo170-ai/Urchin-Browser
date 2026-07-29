/**
 * @urchin/chrome-types · chrome.* API 类型定义占位
 *
 * 依据：契约 C（M9 Chrome 扩展兼容层）
 * v0.1 仅占位，W2 实现 M9 时填充 chrome.tabs/runtime/storage.local/windows/scripting 类型。
 */

// 占位类型，v0.1 W2 在 M9 实现时填充
export interface ChromeRuntimePlaceholder {
  readonly id: string;
}
