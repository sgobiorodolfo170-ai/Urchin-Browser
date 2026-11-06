/**
 * 「关于」选项卡（refactor-plan-p2 §3.3 步骤 7：自 SettingsPage.tsx 原样
 * 提升为独立文件，逻辑不变）
 *
 * 组成：品牌名（locale 探测）、版本号 / Electron / Chromium / Node 版本、
 * 便携 Node 运行时状态（runtime.portableNode 探测）、开源仓库入口。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RuntimePortableNodeRes } from '@urchin/ipc-contract';
import { getCurrentWindowId } from '../../lib/current-window';
import { displayNameForLocale } from '../../../shared/brand';
import { UpdateSection, type UpdateStateView } from './OpsTab';
import { REPO_URL } from './FeedbackTab';

export function AboutTab() {
  // 应用版本经 update.getState 取主进程 app.getVersion()（打包时由
  // package-win.mjs 从 CHANGELOG 盖章 0.1.0-dev.NNN；开发态为 package.json 的 0.1.0）
  const [appVersion, setAppVersion] = useState<string>('—');
  useEffect(() => {
    let alive = true;
    void window.urchin
      .invoke('update.getState', {})
      .then((s) => {
        if (alive) setAppVersion((s as UpdateStateView).currentVersion);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 便携 Node（X4）：dsh 打包态的独立纯 Node 运行时（Electron 内置 Node 会被
  // dsh 指纹校验拒绝）。经主进程探测「是否随包装上 + 能否运行」，用户可在此
  // 自助确认；探测含一次 --version spawn（5s 超时），失败静默显示为待定态。
  const [portableNode, setPortableNode] = useState<RuntimePortableNodeRes | null>(null);
  useEffect(() => {
    let alive = true;
    void window.urchin
      .invoke('runtime.portableNode', {})
      .then((r) => {
        if (alive) setPortableNode(r as RuntimePortableNodeRes);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const versions = useMemo(() => {
    if (typeof window !== 'undefined' && window.urchin?.versions) {
      return {
        electron: window.urchin.versions.electron,
        chrome: window.urchin.versions.chrome,
        node: window.urchin.versions.node,
        platform: window.urchin.platform,
      };
    }
    return { electron: '-', chrome: '-', node: '-', platform: '-' };
  }, []);

  // title 提示放完整路径与失败原因，便于支持诊断（可运行时仅路径）
  const portableNodeTitle = useMemo(() => {
    if (!portableNode) return undefined;
    if (!portableNode.installed) {
      return `${portableNode.path}\n未随安装包装上；开发态可运行 node scripts/fetch-node.mjs 生成`;
    }
    return portableNode.error ? `${portableNode.path}\n${portableNode.error}` : portableNode.path;
  }, [portableNode]);

  const handleOpenRepo = useCallback(async () => {
    try {
      const windowId = await getCurrentWindowId();
      await window.urchin.invoke('tab.create', { windowId, url: REPO_URL, active: true });
    } catch {
      // 标签创建失败不中断设置页交互：静默忽略
    }
  }, []);

  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">关于</h1>
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-surface-secondary px-4 py-4">
          <div className="text-lg font-semibold">{displayNameForLocale(navigator.language)}</div>
          <div className="mt-1 text-sm text-text-secondary">版本 {appVersion}</div>
          <div className="mt-3 text-xs text-text-secondary">
            一款基于 Electron + Chromium 的 AI 浏览器，集成多 Provider AI 助手与隐私保护。
          </div>
        </div>

        {/* 更新检查（原「更新」选项卡内容移入此处） */}
        <UpdateSection />

        <div className="rounded-md border border-border px-4 py-3">
          <div className="mb-2 text-sm font-medium">运行时信息</div>
          <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-text-secondary">Electron</dt>
            <dd>{versions.electron}</dd>
            <dt className="text-text-secondary">Chromium</dt>
            <dd>{versions.chrome}</dd>
            <dt className="text-text-secondary">Node.js</dt>
            <dd>{versions.node}</dd>
            <dt className="text-text-secondary">便携 Node</dt>
            <dd title={portableNodeTitle}>
              {portableNode === null
                ? '…'
                : portableNode.runnable
                  ? `${portableNode.version}（可运行）`
                  : portableNode.installed
                    ? '已安装，但无法运行'
                    : '未安装'}
            </dd>
            <dt className="text-text-secondary">平台</dt>
            <dd>{versions.platform}</dd>
          </dl>
        </div>

        <div className="rounded-md border border-border px-4 py-3">
          <div className="mb-2 text-sm font-medium">作者</div>
          <button
            type="button"
            className="break-all text-left text-xs text-primary hover:underline"
            onClick={() => void handleOpenRepo()}
          >
            {REPO_URL}
          </button>
          <div className="mt-2 text-xs text-text-secondary">
            Copyright © 2026 Urchin Browser Contributors
          </div>
        </div>
      </div>
    </section>
  );
}
