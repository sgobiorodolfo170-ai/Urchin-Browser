/**
 * M15 DevTools · 泛型环形缓冲（FIFO 容量上限 + dropped 计数）
 *
 * 依据：契约 G §9 DT7 性能策略 / 实施规划 §8。
 * 职责：固定容量、超出 FIFO 淘汰最旧、累计 dropped 计数。
 * 设计理由：Console 条目按插入序存储，超出 1000 条淘汰最旧避免爆内存；
 * Network 条目用会话内的 requestId 索引 + 顺序数组（见 devtools-manager），
 * 不直接用此泛型（需要按 key 去重合并，非纯 FIFO）。
 */

/** 固定容量 FIFO 环形缓冲，带淘汰计数。 */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private head = 0;
  private droppedCount = 0;

  constructor(private readonly capacity = 1000) {}

  /** 追加一条；容量满时淘汰最旧并计入 dropped。 */
  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.droppedCount += 1;
    }
  }

  /** 当前条目数。 */
  size(): number {
    return this.items.length;
  }

  /** 累计被淘汰的条目数（会话内单调递增，clear 后归零）。 */
  dropped(): number {
    return this.droppedCount;
  }

  /** 按插入序返回快照（最旧 → 最新）。 */
  toArray(): T[] {
    if (this.items.length < this.capacity) {
      return [...this.items];
    }
    return [...this.items.slice(this.head), ...this.items.slice(0, this.head)];
  }

  /** 清空条目与 dropped 计数。 */
  clear(): void {
    this.items.length = 0;
    this.head = 0;
    this.droppedCount = 0;
  }
}
