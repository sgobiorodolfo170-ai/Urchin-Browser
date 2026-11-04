/**
 * M15 DevTools 检视列开合/宽度状态（App 域的布局真源）
 *
 * 为什么是 App 调用的 hook，而不是状态放进 <DevToolsPanel />：
 * - devtoolsWidth 驱动主进程 BrowserView bounds（App 的 notifyLayout 家族约 10 处
 *   消费 devtoolsOpen ? devtoolsWidth : 0），真源必须在 App，进面板会被迫上提分裂；
 * - F12 toggle 订阅必须能关闭面板——面板是条件渲染（open=false 即卸载），
 *   订阅放在面板内部会随卸载失效，面板将关不掉。
 * （refactor-plan-p2 §2.3 步骤 5，代码自 App.tsx 原样迁出）
 */
import { useEffect, useState } from 'react';
import { DEVTOOLS_TOGGLE_CHANNEL } from '@urchin/ipc-contract';

export function useDevtoolsColumn() {
  /** M15 DevTools 检视列开关（F12 / 侧栏按钮触发 devtools:toggle）。 */
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  /** 检视列宽度（0 = 折叠；拖宽时同步主进程 BrowserView bounds）。 */
  const [devtoolsWidth, setDevtoolsWidth] = useState(360);

  // M15 DevTools F12 toggle 订阅（主进程 before-input-event 拦截 F12 → 推送 devtools:toggle）。
  // 渲染层为面板开合唯一状态源；列宽随开合同步主进程 BrowserView bounds。
  useEffect(() => {
    const off = window.urchin.on(DEVTOOLS_TOGGLE_CHANNEL, () => {
      setDevtoolsOpen((prev) => {
        const next = !prev;
        setDevtoolsWidth(next ? 360 : 0);
        return next;
      });
    });
    return off;
  }, []);

  return { devtoolsOpen, devtoolsWidth, setDevtoolsWidth } as const;
}
