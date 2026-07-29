/**
 * M7 Settings · 类型定义
 *
 * 依据：契约 B §3.1 settings.* 通道 / 04-模块全景 M7
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「可序列化 / Single Source of Truth」）：
 * - key 设为 readonly，保证条目创建后键名不可变
 * - value 为 unknown，承载异构配置（字符串、布尔、数字、对象等）
 * - SettingsEvent / SettingsEventListener 提供 EventEmitter 模式的类型化事件分发
 */

/**
 * 设置条目。
 */
export interface SettingEntry {
  /** 设置键名（非空，长度上限 256） */
  readonly key: string;
  /** 设置值（异构类型） */
  value: unknown;
}

/**
 * 设置事件类型。
 */
export type SettingsEvent = 'changed';

/**
 * 设置事件监听器。
 * - 'changed'：传入被修改的键名与新值（删除时 value 为 undefined）
 */
export type SettingsEventListener = (key: string, value: unknown) => void;
