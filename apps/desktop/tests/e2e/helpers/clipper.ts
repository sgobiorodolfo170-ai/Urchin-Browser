/**
 * 剪藏 E2E 辅助：面板就绪、面板关闭、文件内容落盘（替代固定等待）
 *
 * 背景（2026-11-10 实测）：clipper.spec 的 flake 不是「面板内容没等到」，
 * 而是**文件存在 ≠ 内容写完**——`webContents.savePage(target, 'MHTML')` 会先创建
 * 目标文件再写入，测试的 `existsSync` 轮询一旦命中就 `readFileSync`，读到的是
 * 0 字节（连续 `--repeat-each=5` 复现 1 次：`Expected substring "MIME-Version"，
 * Received ""`）。同理 PDF/PNG 也可能读到未写完的短文件。
 *
 * 判据因此从「文件存在」改为「内容达到可判定状态」，且不引入新的固定等待：
 * - 面板就绪：`#root` 已挂载 + 标题可见 + 保存按钮可用（React 已提交、抽取完成）
 * - 面板收起：窗口消失或出现「已保存」提示（保存 IPC 已结算）
 * - 文件落盘：轮询到内容满足格式断言（MHTML 含 MIME-Version / PDF、PNG 达到最小字节数）
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 判定是否为剪藏面板窗口（`?view=clipper`；不能用 includes，避免命中其它 view） */
export function isClipperPanelUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get('view') === 'clipper';
  } catch {
    return false;
  }
}

function findPanel(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => isClipperPanelUrl(page.url()));
}

/** 等面板窗口出现且 DOM 壳已挂载（不判断抽取是否完成） */
export async function waitForClipperPanel(
  app: ElectronApplication,
  timeout = 15_000,
): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const panel = findPanel(app);
    if (panel) {
      await panel.waitForLoadState('domcontentloaded');
      await panel.locator('#root > *').first().waitFor({ state: 'attached', timeout: 10_000 });
      return panel;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `clipper panel window not found in ${timeout}ms（windows: ${app
      .windows()
      .map((page) => page.url())
      .join(', ')}）`,
  );
}

/**
 * 等面板内容首次渲染完成。
 *
 * 面板在 `loading` 期间只渲染「正在提取页面正文…」占位，标题与保存按钮都在
 * 抽取结束后才出现——因此「标题可见 + 保存可用」就是内容就绪的真实信号，
 * 比固定等待 20s 更早、也更可靠。
 */
export async function waitForClipperPanelReady(
  app: ElectronApplication,
  timeout = 15_000,
): Promise<Page> {
  const panel = await waitForClipperPanel(app, timeout);
  await expect(panel.getByRole('heading', { name: '剪藏（Clipper）' })).toBeVisible({ timeout });
  await expect(panel.getByRole('button', { name: '保存' })).toBeEnabled({ timeout });
  return panel;
}

/**
 * 等一次保存结算：面板已关闭，或出现了「已保存 / 已复制」提示。
 *
 * 用于替代原来的「保存后固定等 1.5s」——面板在无警告时 1s 后自动关闭，
 * 有警告时保持打开并显示提示，两种都是可观察的就绪信号。
 */
export async function waitForClipperSaveSettled(
  app: ElectronApplication,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const panel = findPanel(app);
    if (!panel) return;
    const saved = panel.getByText(/^(已保存：|已复制到剪贴板)/);
    if (
      await saved
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      // 保存提示出现后旧面板仍可能有自动关闭定时器。先关闭并等到窗口销毁，
      // 再允许调用者重新打开，避免旧定时器关闭下一轮剪藏面板。
      await panel
        .getByRole('button', { name: '关闭剪藏面板' })
        .click()
        .catch((error: unknown) => {
          if (!panel.isClosed()) throw error;
        });
      await expect.poll(() => panel.isClosed(), { timeout }).toBe(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`clipper panel did not settle (close or saved notice) in ${timeout}ms`);
}

/**
 * 轮询剪藏目录，返回第一个内容满足 `accept` 的文件路径。
 *
 * 只读文件头即可满足断言；`accept` 返回 false 表示「文件已出现但内容还没写完」，
 * 继续轮询而不是立刻失败。
 */
export async function waitForClipFile(
  dir: string,
  ext: string,
  accept: (path: string) => boolean,
  timeout = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  let lastSize = -1;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      const names = readdirSync(dir).filter((name) => name.endsWith(ext));
      for (const name of names) {
        const path = join(dir, name);
        try {
          lastSize = statSync(path).size;
          if (lastSize > 0 && accept(path)) return path;
        } catch {
          // 文件正在被替换 / 尚未可读，继续等
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `clip file ${ext} not ready in ${dir} within ${timeout}ms（last size=${lastSize}）`,
  );
}

/** 读取文本并断言包含关键内容（MHTML 必须等到完整 MIME 头） */
export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** 读取二进制长度（PDF / PNG 用最小字节数判定已写完） */
export function readBytes(path: string): number {
  return readFileSync(path).byteLength;
}
