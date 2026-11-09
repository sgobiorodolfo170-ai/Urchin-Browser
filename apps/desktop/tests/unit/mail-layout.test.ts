/**
 * M25 邮箱页 · 三区布局纯函数单测
 *
 * 覆盖：usableWidth 扣分割线、拖拽 clamp（左/中栏宽上限按右区保底收敛）、
 * restoreWidths 持久化值归一化（非法回退默认 / 窄容器收敛）、buildMailState 结构。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOLDER_WIDTH,
  DEFAULT_LIST_WIDTH,
  MIN_DETAIL_WIDTH,
  MIN_FOLDER_WIDTH,
  MIN_LIST_WIDTH,
  SPLITTER_WIDTH,
  buildMailState,
  resizeFolderWidth,
  resizeListWidth,
  restoreWidths,
  usableWidth,
} from '../../src/renderer/mail/layout';

describe('mail layout usableWidth', () => {
  it('should subtract two splitter widths from container width', () => {
    expect(usableWidth(1000)).toBe(1000 - SPLITTER_WIDTH * 2);
  });

  it('should floor at minimum total width for tiny containers', () => {
    expect(usableWidth(10)).toBe(MIN_FOLDER_WIDTH + MIN_LIST_WIDTH + MIN_DETAIL_WIDTH);
  });
});

describe('mail layout resizeFolderWidth', () => {
  it('should grow folder width by delta and keep list width', () => {
    const next = resizeFolderWidth(192, 284, 60, 1200);
    expect(next.folderWidth).toBe(252);
    expect(next.listWidth).toBe(284);
  });

  it('should clamp folder width at minimum', () => {
    const next = resizeFolderWidth(150, 284, -1000, 1200);
    expect(next.folderWidth).toBe(MIN_FOLDER_WIDTH);
  });

  it('should clamp folder width so list (kept) and detail keep their minimums', () => {
    const usable = usableWidth(1200);
    const next = resizeFolderWidth(192, 284, 100000, 1200);
    // 列表栏拖左分割线时保持原值 284，右区保底 MIN_DETAIL_WIDTH
    expect(next.folderWidth).toBe(usable - 284 - MIN_DETAIL_WIDTH);
  });
});

describe('mail layout resizeListWidth', () => {
  it('should grow list width by delta and keep folder width', () => {
    const next = resizeListWidth(192, 284, 40, 1200);
    expect(next.folderWidth).toBe(192);
    expect(next.listWidth).toBe(324);
  });

  it('should clamp list width at minimum', () => {
    const next = resizeListWidth(192, 220, -500, 1200);
    expect(next.listWidth).toBe(MIN_LIST_WIDTH);
  });

  it('should clamp list width so folder and detail keep their minimums', () => {
    const usable = usableWidth(1200);
    const next = resizeListWidth(192, 284, 100000, 1200);
    expect(next.listWidth).toBe(usable - 192 - MIN_DETAIL_WIDTH);
  });
});

describe('mail layout restoreWidths', () => {
  it('should fall back to defaults for null / invalid persisted value', () => {
    expect(restoreWidths(null, 1200)).toEqual({
      folderWidth: DEFAULT_FOLDER_WIDTH,
      listWidth: DEFAULT_LIST_WIDTH,
    });
    expect(restoreWidths({ folderWidth: 'x', listWidth: NaN }, 1200)).toEqual({
      folderWidth: DEFAULT_FOLDER_WIDTH,
      listWidth: DEFAULT_LIST_WIDTH,
    });
  });

  it('should keep valid persisted widths', () => {
    expect(restoreWidths({ folderWidth: 260, listWidth: 360 }, 1200)).toEqual({
      folderWidth: 260,
      listWidth: 360,
    });
  });

  it('should clamp persisted widths when container is narrower than when saved', () => {
    // 窗口比保存时窄：按当前容器收敛，保证右区 ≥ MIN_DETAIL_WIDTH
    const next = restoreWidths({ folderWidth: 800, listWidth: 800 }, 800);
    const usable = usableWidth(800);
    expect(next.folderWidth).toBe(usable - MIN_LIST_WIDTH - MIN_DETAIL_WIDTH);
    expect(next.folderWidth + next.listWidth + MIN_DETAIL_WIDTH).toBeLessThanOrEqual(usable);
  });
});

describe('mail layout buildMailState', () => {
  it('should build versioned state', () => {
    expect(buildMailState(200, 300)).toEqual({ v: 1, folderWidth: 200, listWidth: 300 });
  });
});
