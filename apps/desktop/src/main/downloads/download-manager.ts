/**
 * M23 Download Manager · 核心类
 *
 * 依据：契约 B §3.1 download.* 通道 / 04-模块全景 M23
 * 职责：
 * 1. 管理下载项集合（Map<id, DownloadItem>）
 * 2. create / update / get / list / cancel / pause / resume / clear / getCount 方法
 * 3. 事件分发（created / updated / completed / cancelled / removed）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是下载状态的唯一权威源，渲染层 store 只是镜像
 * - 全部方法同步执行（内存操作），持久化由后续 wave 叠加
 * - id / startTime 为 readonly，创建后不可变；其余字段可变
 */
import { randomUUID } from 'node:crypto';
import type {
  DownloadCreateOptions,
  DownloadEvent,
  DownloadItem,
  DownloadState,
  DownloadEventListener,
} from './types';

/** 可被 update 修改的字段集合（排除 readonly 的 id / startTime）。 */
export type DownloadPatch = Partial<
  Pick<
    DownloadItem,
    | 'filename'
    | 'url'
    | 'state'
    | 'receivedBytes'
    | 'totalBytes'
    | 'savePath'
    | 'endTime'
    | 'mimeType'
  >
>;

/** 已结束（可清理）的下载状态。 */
const TERMINAL_STATES: ReadonlySet<DownloadState> = new Set([
  'completed',
  'cancelled',
  'interrupted',
]);

export class DownloadManager {
  /** 下载项集合：id → DownloadItem */
  private readonly entries = new Map<string, DownloadItem>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<DownloadEvent, DownloadEventListener[]>();

  /**
   * 创建新的下载项。
   *
   * - state 默认 'progressing'
   * - receivedBytes 默认 0
   * - startTime 为当前时间戳
   * - 触发 'created' 事件
   *
   * @param opts 创建选项
   * @returns 新建的 DownloadItem
   */
  create(opts: DownloadCreateOptions): DownloadItem {
    const download: DownloadItem = {
      id: randomUUID(),
      filename: opts.filename,
      url: opts.url,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: opts.totalBytes,
      savePath: opts.savePath,
      startTime: Date.now(),
      mimeType: opts.mimeType,
    };

    this.entries.set(download.id, download);
    this.emit('created', download);
    return download;
  }

  /**
   * 部分更新下载项（仅可变字段）。
   *
   * - 触发 'updated' 事件
   * - 若 state 变更为 'completed'，自动填充 endTime（未提供时取当前时间），并触发 'completed' 事件
   * - 若 state 变更为 'cancelled'，触发 'cancelled' 事件
   *
   * @param id 下载项 ID
   * @param patch 待更新的字段
   * @returns 更新后的 DownloadItem
   * @throws 若下载项不存在
   */
  update(id: string, patch: DownloadPatch): DownloadItem {
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Download not found: ${id}`);
    }

    const prevState = existing.state;
    const updated: DownloadItem = {
      ...existing,
      ...patch,
      id: existing.id,
      startTime: existing.startTime,
    };

    // 状态变为 completed 时填充 endTime
    if (patch.state === 'completed' && prevState !== 'completed' && updated.endTime === undefined) {
      updated.endTime = Date.now();
    }

    this.entries.set(id, updated);
    this.emit('updated', updated);

    if (patch.state === 'completed' && prevState !== 'completed') {
      this.emit('completed', updated);
    } else if (patch.state === 'cancelled' && prevState !== 'cancelled') {
      this.emit('cancelled', updated);
    }

    return updated;
  }

  /**
   * 按 id 获取下载项。
   *
   * @param id 下载项 ID
   * @returns 下载项；不存在时返回 undefined
   */
  get(id: string): DownloadItem | undefined {
    return this.entries.get(id);
  }

  /**
   * 列出全部下载项，按 startTime 降序排序（最新在前）。
   *
   * @returns 排序后的 DownloadItem 数组
   */
  list(): DownloadItem[] {
    const all = Array.from(this.entries.values());
    all.sort((a, b) => b.startTime - a.startTime);
    return all;
  }

  /**
   * 取消下载项。
   *
   * - 设置 state='cancelled'、endTime=当前时间
   * - 触发 'cancelled' 事件
   *
   * @param id 下载项 ID
   * @returns 更新后的 DownloadItem
   * @throws 若下载项不存在
   */
  cancel(id: string): DownloadItem {
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Download not found: ${id}`);
    }

    const updated: DownloadItem = {
      ...existing,
      state: 'cancelled',
      endTime: Date.now(),
    };

    this.entries.set(id, updated);
    this.emit('cancelled', updated);
    return updated;
  }

  /**
   * 暂停下载项。
   *
   * - 设置 state='paused'
   * - 触发 'updated' 事件
   *
   * @param id 下载项 ID
   * @returns 更新后的 DownloadItem
   * @throws 若下载项不存在
   */
  pause(id: string): DownloadItem {
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Download not found: ${id}`);
    }

    const updated: DownloadItem = {
      ...existing,
      state: 'paused',
    };

    this.entries.set(id, updated);
    this.emit('updated', updated);
    return updated;
  }

  /**
   * 恢复下载项。
   *
   * - 设置 state='progressing'
   * - 触发 'updated' 事件
   *
   * @param id 下载项 ID
   * @returns 更新后的 DownloadItem
   * @throws 若下载项不存在
   */
  resume(id: string): DownloadItem {
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Download not found: ${id}`);
    }

    const updated: DownloadItem = {
      ...existing,
      state: 'progressing',
    };

    this.entries.set(id, updated);
    this.emit('updated', updated);
    return updated;
  }

  /**
   * 清理下载项。
   *
   * - 提供 id：删除指定下载项（无论状态）
   * - 不提供 id：删除所有已结束（completed / cancelled / interrupted）的下载项
   *
   * 每个被删除的下载项各触发一次 'removed' 事件。
   *
   * @param id 下载项 ID（可选）
   * @returns 被删除的下载项数量
   */
  clear(id?: string): number {
    if (id !== undefined) {
      const existing = this.entries.get(id);
      if (!existing) {
        return 0;
      }
      this.entries.delete(id);
      this.emit('removed', existing);
      return 1;
    }

    let count = 0;
    for (const [currentId, download] of this.entries) {
      if (TERMINAL_STATES.has(download.state)) {
        this.entries.delete(currentId);
        this.emit('removed', download);
        count++;
      }
    }
    return count;
  }

  /** 获取下载项总数。 */
  getCount(): number {
    return this.entries.size;
  }

  /** 注册事件监听。 */
  on(event: DownloadEvent, listener: DownloadEventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  /** 移除事件监听。 */
  off(event: DownloadEvent, listener: DownloadEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) {
      arr.splice(idx, 1);
    }
  }

  /** 分发事件。 */
  private emit(event: DownloadEvent, download: DownloadItem): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      listener(download);
    }
  }
}
