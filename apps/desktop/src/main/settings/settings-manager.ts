/**
 * M7 Settings · 核心类
 *
 * 依据：契约 B §3.1 settings.* 通道 / 04-模块全景 M7
 * 职责：
 * 1. 管理设置集合（Map<string, unknown>）
 * 2. 构造时预填充默认设置（theme / searchEngine / homepage 等）
 * 3. get / set / getAll / has / delete 方法
 * 4. 事件分发（changed）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是设置状态的唯一权威源，渲染层 store 只是镜像
 * - 全部方法同步执行（内存操作），持久化由后续 wave 叠加
 * - value 为 unknown 类型，承载异构配置值
 */
import type { SettingEntry, SettingsEvent, SettingsEventListener } from './types';

/** 默认设置项：构造时预填充。 */
const DEFAULT_SETTINGS: readonly (readonly [string, unknown])[] = [
  ['theme', 'light'],
  ['searchEngine', 'google'],
  ['homepage', 'urchin://newtab'],
  ['downloadsPath', ''],
  ['blockTrackers', true],
  ['doNotTrack', true],
] as const;

export class SettingsManager {
  /** 设置集合：key → value */
  private readonly entries = new Map<string, unknown>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<SettingsEvent, SettingsEventListener[]>();

  /**
   * 构造时预填充默认设置。
   */
  constructor() {
    for (const [key, value] of DEFAULT_SETTINGS) {
      this.entries.set(key, value);
    }
  }

  /**
   * 获取指定键的值。
   *
   * @param key 设置键名
   * @returns 值；键不存在时返回 undefined
   */
  get(key: string): unknown {
    return this.entries.get(key);
  }

  /**
   * 设置指定键的值。
   *
   * 若键已存在则覆盖原值。触发 'changed' 事件，传入键名与新值。
   *
   * @param key 设置键名
   * @param value 设置值
   */
  set(key: string, value: unknown): void {
    this.entries.set(key, value);
    this.emit('changed', key, value);
  }

  /**
   * 获取全部设置条目。
   *
   * @returns SettingEntry 数组（每个条目含 { key, value }）
   */
  getAll(): SettingEntry[] {
    const result: SettingEntry[] = [];
    for (const [key, value] of this.entries) {
      result.push({ key, value });
    }
    return result;
  }

  /**
   * 判断指定键是否存在。
   *
   * @param key 设置键名
   * @returns 存在返回 true，否则 false
   */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * 删除指定键。
   *
   * 触发 'changed' 事件，传入键名与 undefined。
   *
   * @param key 设置键名
   * @returns 删除成功返回 true，键不存在返回 false
   */
  delete(key: string): boolean {
    const deleted = this.entries.delete(key);
    if (deleted) {
      this.emit('changed', key, undefined);
    }
    return deleted;
  }

  /** 注册事件监听。 */
  on(event: SettingsEvent, listener: SettingsEventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  /** 移除事件监听。 */
  off(event: SettingsEvent, listener: SettingsEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) {
      arr.splice(idx, 1);
    }
  }

  /** 分发事件。 */
  emit(event: SettingsEvent, key: string, value: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      listener(key, value);
    }
  }
}
