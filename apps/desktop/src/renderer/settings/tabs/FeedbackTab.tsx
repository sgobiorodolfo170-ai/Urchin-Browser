/**
 * 「建议与反馈」选项卡（refactor-plan-p2 §3.3 步骤 7：自 SettingsPage.tsx
 * 原样提升为独立文件，逻辑不变）
 *
 * 组成：GitHub 仓库入口（issues / discussions 外链打开）。
 */
import { useCallback, useState } from 'react';
import { Button } from '../../components/ui/button';
import { getCurrentWindowId } from '../../lib/current-window';

/** 远程仓库地址（Issues / Discussions 链接以此拼接）。 */
export const REPO_URL = 'https://github.com/sgobiorodolfo170-ai/Urchin-Browser';

/**
 * 「建议与反馈」选项卡：聚合 GitHub Issues 与 Discussions 入口。
 *
 * 点击后在 Urchin 内新开标签页打开对应 GitHub 页面（复用 tab.create，
 * active:true 让新标签立即获得焦点，自然离开设置面板）。
 */
export function FeedbackTab() {
  const [opening, setOpening] = useState<string | null>(null);

  const handleOpen = useCallback(async (url: string) => {
    setOpening(url);
    try {
      const windowId = await getCurrentWindowId();
      await window.urchin.invoke('tab.create', { windowId, url, active: true });
    } catch {
      // 标签创建失败不应中断设置页交互：静默忽略，用户可重试或复制链接手动打开
    } finally {
      setOpening(null);
    }
  }, []);

  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">建议与反馈</h1>
      <p className="mb-6 text-sm text-text-secondary">
        欢迎通过 GitHub 提交问题、分享想法或参与讨论。点击下方入口会在本浏览器新标签页打开对应页面。
      </p>
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-surface-secondary px-4 py-4">
          <div className="text-lg font-semibold">问题反馈（Issues）</div>
          <div className="mt-1 text-sm text-text-secondary">
            报告 Bug、提出功能请求或查看已知问题。
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={opening === `${REPO_URL}/issues`}
            onClick={() => void handleOpen(`${REPO_URL}/issues`)}
          >
            {opening === `${REPO_URL}/issues` ? '打开中…' : '前往 Issues'}
          </Button>
        </div>

        <div className="rounded-md border border-border bg-surface-secondary px-4 py-4">
          <div className="text-lg font-semibold">讨论区（Discussions）</div>
          <div className="mt-1 text-sm text-text-secondary">
            想法交流、使用问答、Show &amp; Tell 与经验分享。
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={opening === `${REPO_URL}/discussions`}
            onClick={() => void handleOpen(`${REPO_URL}/discussions`)}
          >
            {opening === `${REPO_URL}/discussions` ? '打开中…' : '前往 Discussions'}
          </Button>
        </div>
      </div>
    </section>
  );
}
