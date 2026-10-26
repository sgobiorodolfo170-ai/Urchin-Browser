/**
 * RingBuffer 单元测试（M15 DevTools 环形缓冲）。
 *
 * 验证：容量边界、FIFO 淘汰顺序、dropped 计数、clear。
 */
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/main/devtools/ring-buffer';

describe('RingBuffer', () => {
  it('should append below capacity without dropping', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.size()).toBe(3);
    expect(buf.dropped()).toBe(0);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it('should FIFO-evict oldest and count dropped when over capacity', () => {
    const buf = new RingBuffer<string>(2);
    buf.push('a');
    buf.push('b');
    buf.push('c'); // evicts 'a'
    expect(buf.size()).toBe(2);
    expect(buf.dropped()).toBe(1);
    expect(buf.toArray()).toEqual(['b', 'c']);
  });

  it('should wrap around correctly after multiple evictions', () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) buf.push(i); // evicts 1,2,3,4
    expect(buf.size()).toBe(3);
    expect(buf.dropped()).toBe(4);
    expect(buf.toArray()).toEqual([5, 6, 7]);
  });

  it('should reset dropped count on clear', () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.dropped()).toBe(1);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.dropped()).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it('should handle capacity 1', () => {
    const buf = new RingBuffer<number>(1);
    buf.push(1);
    expect(buf.toArray()).toEqual([1]);
    buf.push(2); // evicts 1
    expect(buf.toArray()).toEqual([2]);
    expect(buf.dropped()).toBe(1);
  });

  it('should preserve insertion order after wrap (oldest -> newest)', () => {
    const buf = new RingBuffer<number>(4);
    for (let i = 1; i <= 6; i++) buf.push(i); // evicts 1,2
    // head now at index 2; items = [3,4,5,6] but head=2 means order = [5,6,3,4]? No:
    // capacity 4: push 1,2,3,4 fill; push 5 -> items[0]=5,head=1; push 6 -> items[1]=6,head=2
    // toArray = items.slice(2) ++ items.slice(0,2) = [3,4] ++ [5,6] = [3,4,5,6]
    expect(buf.toArray()).toEqual([3, 4, 5, 6]);
    expect(buf.dropped()).toBe(2);
  });
});
