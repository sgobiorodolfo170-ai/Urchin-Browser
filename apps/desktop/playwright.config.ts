/**
 * Playwright 配置
 * 依据：03-技术栈 §7.3 / 07-立项准备 §1.6
 * 用 _electron.launch 启动真实 Electron 实例，不 mock 任何东西
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: {},
    },
  ],
});
