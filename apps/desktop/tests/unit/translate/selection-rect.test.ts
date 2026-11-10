/**
 * 选区几何采集单元测试（划词翻译结果卡的尺寸基准）
 *
 * 覆盖：
 * 1. normalizeSelectionRect：结构校验 / 尺寸非正拒绝 / 行数下限 / 异常值夹边
 * 2. readSelectionRect：无 executeJavaScript 接口 / 正常返回 / 求值失败
 */
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSelectionRect,
  readSelectionRect,
  READ_SELECTION_RECT_SCRIPT,
} from '../../../src/main/translate/selection-rect';

describe('normalizeSelectionRect', () => {
  it('should accept a well-formed rect', () => {
    expect(normalizeSelectionRect({ x: 10, y: 20, width: 300, height: 69, lines: 3 })).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 69,
      lines: 3,
    });
  });

  it('should reject non-object payloads', () => {
    expect(normalizeSelectionRect(null)).toBeNull();
    expect(normalizeSelectionRect(undefined)).toBeNull();
    expect(normalizeSelectionRect('rect')).toBeNull();
    expect(normalizeSelectionRect(42)).toBeNull();
  });

  it('should reject missing or non-numeric fields', () => {
    expect(normalizeSelectionRect({ x: 0, y: 0, width: 10, height: 10 })).toBeNull();
    expect(normalizeSelectionRect({ x: 0, y: 0, width: '10', height: 10, lines: 1 })).toBeNull();
    expect(
      normalizeSelectionRect({ x: 0, y: Number.NaN, width: 10, height: 10, lines: 1 }),
    ).toBeNull();
  });

  it('should reject non-positive dimensions (collapsed selection)', () => {
    expect(normalizeSelectionRect({ x: 0, y: 0, width: 0, height: 10, lines: 1 })).toBeNull();
    expect(normalizeSelectionRect({ x: 0, y: 0, width: 10, height: -1, lines: 1 })).toBeNull();
  });

  it('should floor line count at one', () => {
    expect(normalizeSelectionRect({ x: 0, y: 0, width: 10, height: 10, lines: 0 })?.lines).toBe(1);
    expect(normalizeSelectionRect({ x: 0, y: 0, width: 10, height: 10, lines: 2.6 })?.lines).toBe(
      3,
    );
  });

  it('should clamp absurd geometry returned by hostile pages', () => {
    const rect = normalizeSelectionRect({
      x: 99999,
      y: -5,
      width: 999999,
      height: 1e9,
      lines: 1e6,
    });
    expect(rect).toEqual({ x: 10000, y: -5, width: 10000, height: 10000, lines: 10000 });
  });
});

describe('readSelectionRect', () => {
  it('should return null when the webContents cannot evaluate scripts', async () => {
    await expect(readSelectionRect({})).resolves.toBeNull();
  });

  it('should evaluate the script with a user gesture and normalize the result', async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValue({ x: 5, y: 6, width: 200, height: 46, lines: 2 });
    await expect(readSelectionRect({ executeJavaScript })).resolves.toEqual({
      x: 5,
      y: 6,
      width: 200,
      height: 46,
      lines: 2,
    });
    expect(executeJavaScript).toHaveBeenCalledWith(READ_SELECTION_RECT_SCRIPT, true);
  });

  it('should swallow evaluation errors and fall back to null', async () => {
    const executeJavaScript = vi.fn().mockRejectedValue(new Error('render frame gone'));
    await expect(readSelectionRect({ executeJavaScript })).resolves.toBeNull();
  });
});
