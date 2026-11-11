/**
 * 原生模块缺失兜底提示单元测试
 *
 * 验证：
 * 1. showMissingNativeModuleError 用 showErrorBox 弹出可操作提示（含模块名/错误详情）
 * 2. abortOnSqliteLoadFailure 捕获 Error 与任意值两种形态，并以退出码 1 结束
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const guardRuntime = vi.hoisted(() => ({
  showErrorBox: vi.fn(),
  exit: vi.fn(),
  getVersion: vi.fn(() => '0.3.0-dev.185'),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: guardRuntime.getVersion,
    exit: guardRuntime.exit,
  },
  dialog: {
    showErrorBox: guardRuntime.showErrorBox,
  },
}));

import {
  MISSING_NATIVE_MODULE_TITLE,
  showMissingNativeModuleError,
  abortOnSqliteLoadFailure,
} from '../../src/main/bootstrap/native-module-guard';

describe('native-module-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show an actionable dialog with module name and detail', () => {
    showMissingNativeModuleError('better-sqlite3', "Cannot find module 'better-sqlite3'");

    expect(guardRuntime.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, body] = guardRuntime.showErrorBox.mock.calls[0] as [string, string];
    expect(title).toBe(MISSING_NATIVE_MODULE_TITLE);
    expect(body).toContain('better-sqlite3');
    expect(body).toContain("Cannot find module 'better-sqlite3'");
    // 必须给出「重新运行安装包」的修复路径，否则用户只能反复双击图标
    expect(body).toContain('重新运行最新安装包');
    expect(body).toContain('0.3.0-dev.185');
  });

  it('should abort with exit code 1 on Error instance', () => {
    abortOnSqliteLoadFailure(new Error('NODE_MODULE_VERSION mismatch'));

    const [title, body] = guardRuntime.showErrorBox.mock.calls[0] as [string, string];
    expect(title).toBe(MISSING_NATIVE_MODULE_TITLE);
    expect(body).toContain('NODE_MODULE_VERSION mismatch');
    expect(guardRuntime.exit).toHaveBeenCalledWith(1);
  });

  it('should stringify non-Error rejections', () => {
    abortOnSqliteLoadFailure('boom');

    const [, body] = guardRuntime.showErrorBox.mock.calls[0] as [string, string];
    expect(body).toContain('boom');
    expect(guardRuntime.exit).toHaveBeenCalledWith(1);
  });
});
