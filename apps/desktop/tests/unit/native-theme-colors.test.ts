/**
 * 进程侧主题背景色单元测试（dev.50 深色白缝修复）
 *
 * 验证：themeBackgroundFor 纯函数亮/暗取值 + currentThemeBackground
 * 跟随 nativeTheme.shouldUseDarkColors（含「跟随系统」的解析结果）。
 * 数值单一真源：与渲染层 tokens.css --color-surface 对齐。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

/** nativeTheme 暗色标志（可变，供 currentThemeBackground 断言） */
const state = vi.hoisted(() => ({ dark: false }));

vi.mock('electron', () => ({
  nativeTheme: {
    get shouldUseDarkColors() {
      return state.dark;
    },
  },
}));

import {
  THEME_BACKGROUNDS,
  themeBackgroundFor,
  currentThemeBackground,
} from '../../src/main/theme';

describe('themeBackgroundFor', () => {
  it('should return light surface color for light theme', () => {
    expect(themeBackgroundFor(false)).toBe('#ffffff');
  });

  it('should return dark surface color (#0f172a) for dark theme', () => {
    expect(themeBackgroundFor(true)).toBe('#0f172a');
  });
});

describe('currentThemeBackground', () => {
  afterEach(() => {
    state.dark = false;
  });

  it('should follow nativeTheme.shouldUseDarkColors', () => {
    state.dark = false;
    expect(currentThemeBackground()).toBe(THEME_BACKGROUNDS.light);
    state.dark = true;
    expect(currentThemeBackground()).toBe(THEME_BACKGROUNDS.dark);
  });
});
