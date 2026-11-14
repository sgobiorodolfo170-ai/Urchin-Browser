/**
 * 侧栏标签拖拽排序落点计算（reorder-utils）单元测试。
 *
 * 验证几何边界模型（2026-11-15 死区修复）：
 * - 卡片上/下半 = 前/后插入（中点分界）
 * - 卡片间隙、首卡上方、末卡下方空白均有效（旧 elementFromPoint 实现的死区）
 * - 摘除自身后的边界平移与原地判定（原地返回 null，不发无意义 reorder）
 *
 * 用规整矩形序列模拟渲染顺序（上→下，卡片高 48 间隙 2），DOM 无关。
 */
import { describe, it, expect } from 'vitest';
import { computeReorderTarget, type ReorderCard } from '../../src/renderer/tabs/reorder-utils';

/** 四张卡片：id 1..4，top = (i-1)*50，高 48（间隙 2px） */
const CARDS: ReorderCard[] = [1, 2, 3, 4].map((id, i) => ({
  id,
  top: i * 50,
  bottom: i * 50 + 48,
}));

describe('computeReorderTarget', () => {
  it('压在紧邻下方卡上半 = 原地（不发 reorder）', () => {
    // 卡 1 下方的卡 2 上半 = 边界 1 = 自身原位
    expect(computeReorderTarget(CARDS, 1, 60)).toBeNull();
  });

  it('压在紧邻下方卡下半 = 移到其后', () => {
    // 卡 2 下半 → 边界 2 → 表达为「卡 3 之前」（等价卡 2 之后）
    expect(computeReorderTarget(CARDS, 1, 80)).toEqual({ targetId: 3, position: 'before' });
  });

  it('压在上方卡上半 = 移到其前（取其位）', () => {
    expect(computeReorderTarget(CARDS, 4, 10)).toEqual({ targetId: 1, position: 'before' });
  });

  it('压在上方卡下半 = 移到其后', () => {
    expect(computeReorderTarget(CARDS, 4, 30)).toEqual({ targetId: 2, position: 'before' });
  });

  it('卡片间隙不再是死区：归入下方卡上半', () => {
    // 卡 1 与卡 2 之间 2px 间隙（y=49）：对卡 1 是原地
    expect(computeReorderTarget(CARDS, 1, 49)).toBeNull();
    // 对卡 3 是「插到卡 2 之前」
    expect(computeReorderTarget(CARDS, 3, 49)).toEqual({ targetId: 2, position: 'before' });
  });

  it('首卡上方（列表 padding / 新建标签区）= 置顶', () => {
    expect(computeReorderTarget(CARDS, 3, -10)).toEqual({ targetId: 1, position: 'before' });
  });

  it('末卡下方空白（列表空白区）= 末尾追加（after 语义）', () => {
    expect(computeReorderTarget(CARDS, 1, 500)).toEqual({ targetId: 4, position: 'after' });
  });

  it('末卡上/下半分别 = 前/后插入', () => {
    expect(computeReorderTarget(CARDS, 1, 160)).toEqual({ targetId: 4, position: 'before' });
    expect(computeReorderTarget(CARDS, 1, 190)).toEqual({ targetId: 4, position: 'after' });
  });

  it('压在自己上/下半 = 原地', () => {
    expect(computeReorderTarget(CARDS, 2, 60)).toBeNull(); // 上半
    expect(computeReorderTarget(CARDS, 2, 80)).toBeNull(); // 下半
  });

  it('已是末张再拖到末尾 = 原地', () => {
    expect(computeReorderTarget(CARDS, 4, 500)).toBeNull();
  });

  it('被拖卡不在列表中 = null（拖拽期间标签被关等）', () => {
    expect(computeReorderTarget(CARDS, 99, 100)).toBeNull();
  });

  it('只剩一张卡 = null（任何落点都是原地）', () => {
    expect(computeReorderTarget([CARDS[0]!], 1, 25)).toBeNull();
  });
});
