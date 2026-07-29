/**
 * E2E 测试：启动 → 创建窗口 → IPC 链路验证
 * 依据：07-立项准备 §2.6 D5 / 05-路线图 v0.1 验收
 * v0.1 W1 关键路径：启动 / 开标签 / 导航 / AI 摘要 / 关标签
 *
 * W1-D1 最小占位：验证 Electron 能启动并显示主窗口。
 * D5 起补充完整路径。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';

test('should launch Electron and show main window', async () => {
  const appPath = resolve(__dirname, '..');
  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  });

  const window = await electronApp.firstWindow();

  // 验证窗口标题
  await expect(window).toHaveTitle(/Urchin Browser/i);

  // 验证根容器渲染
  await expect(window.locator('#root')).toBeVisible();

  // 验证 IPC 链路（App 组件会调用 tab.create 并显示结果）
  await expect(window.getByText('IPC 链路验证')).toBeVisible({ timeout: 15_000 });

  await electronApp.close();
});
