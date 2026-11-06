/**
 * 左侧栏模块入口 handlers（App 域 hook，
 * refactor-plan-p2 §2.3 步骤 7，代码自 App.tsx 原样迁出）
 *
 * 打开各模块标签页的统一入口集合（设置/GenOffice 主页/pi/邮箱/笔记/DeepSeek
 * Harness），只被左侧栏按钮消费。各入口的 toggle/复用语义见各 handler 注释。
 * hook 仅做代码组织：标签列表（tabs/activeTabId）与全局 toast / 服务状态
 * （actionToast / piServiceState / dshStarting）的真源仍在 App，经 options 注入。
 */
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TabSnapshot } from '../tabs/types';
import { getCurrentWindowId } from './current-window';
import { sameServiceOrigin } from '../../shared/dsh-url';

/** pi 托管服务状态（ADR-014：常驻服务，侧栏 π 按钮状态灯依据） */
export type PiServiceState = 'stopped' | 'starting' | 'running' | 'error';

export interface UseModuleOpenersOptions {
  readonly tabs: readonly TabSnapshot[];
  readonly activeTabId: number | null;
  /** 通用操作 toast（截图/翻译/DeepSeek Harness 等反馈，3 秒自动消失） */
  readonly setActionToast: Dispatch<SetStateAction<string | null>>;
  readonly setPiServiceState: Dispatch<SetStateAction<PiServiceState>>;
  /** DeepSeek Harness 启动中标记（启动完成（成功/失败）后再消失） */
  readonly setDshStarting: Dispatch<SetStateAction<boolean>>;
}

export function useModuleOpeners({
  tabs,
  activeTabId,
  setActionToast,
  setPiServiceState,
  setDshStarting,
}: UseModuleOpenersOptions) {
  // 打开设置标签页：如果已有设置标签页则激活它，不重复创建
  const handleOpenSettings = useCallback(async () => {
    // Toggle 行为：当前已激活设置页则关闭它；否则激活或创建
    // 注意：URL 规范化会加末尾斜杠（urchin://settings/），用 startsWith 兼容两种形式
    const existing = tabs.find((t) => t.url?.startsWith('urchin://settings'));
    if (existing) {
      if (existing.id === activeTabId) {
        // 当前设置页已激活：关闭它
        try {
          await window.urchin.invoke('tab.close', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to close settings tab:', e);
        }
      } else {
        // 设置页存在但未激活：激活它
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate settings tab:', e);
        }
      }
      return;
    }
    // 没有设置标签页，创建新的
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://settings',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open settings tab:', e);
    }
  }, [tabs, activeTabId]);

  // 打开 GenOffice 文档主页（阶段 4.5，用户指令：左侧栏入口改为嵌入的
  // GenOffice 前端入口）：已有主页标签则激活，否则新建
  const handleOpenGenOfficeHome = useCallback(async () => {
    const existing = tabs.find((t) => t.url?.startsWith('urchin://genoffice-home'));
    if (existing) {
      try {
        await window.urchin.invoke('tab.setActive', { tabId: existing.id });
      } catch (e) {
        console.error('Failed to activate GenOffice home tab:', e);
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://genoffice-home',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open GenOffice home tab:', e);
    }
  }, [tabs]);

  // 打开 pi 模块（ADR-014）：确保服务运行 → 直接打开/聚焦 pi 聊天页（http 标签）。
  // 服务常驻——关 pi 标签不停服务；无启动器中间页；无 toggle 关闭语义。
  // origin 匹配复用标签（兼容页面导航后 token 丢失、URL 变化）。
  const handleOpenPi = useCallback(async () => {
    let piUrl: string | null = null;
    let piState: string | undefined;
    try {
      const s = (await window.urchin.invoke('pihost.status', {})) as {
        state?: string;
        url?: string;
      };
      piState = s.state;
      if (s.state === 'running' && typeof s.url === 'string') piUrl = s.url;
    } catch {
      // IPC 未就绪：提示错误
      setActionToast('pi 服务状态查询失败');
      setPiServiceState('error');
      return;
    }

    // starting：服务正在启动，提示等待
    if (piState === 'starting') {
      setActionToast('正在启动 pi…');
      return;
    }

    // stopped / error：启动服务（launch 幂等，error 态会重启）
    if (!piUrl) {
      setPiServiceState('starting');
      setActionToast('正在启动 pi…');
      try {
        const res = (await window.urchin.invoke('pihost.launch', {})) as {
          url?: string;
        };
        if (typeof res.url === 'string') {
          piUrl = res.url;
        } else {
          throw new Error('launch returned no url');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setActionToast(`pi 启动失败：${msg}`);
        setPiServiceState('error');
        return;
      }
    }

    // 服务就绪：按 origin 复用/新建 pi 标签
    const targetOrigin = (() => {
      try {
        return piUrl ? new URL(piUrl).origin : null;
      } catch {
        return null;
      }
    })();
    const existing = targetOrigin
      ? tabs.find((t) => {
          try {
            return t.url && new URL(t.url).origin === targetOrigin;
          } catch {
            return false;
          }
        })
      : undefined;
    if (existing) {
      try {
        await window.urchin.invoke('tab.setActive', { tabId: existing.id });
      } catch (e) {
        console.error('Failed to activate pi tab:', e);
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: piUrl,
        active: true,
      });
    } catch (e) {
      console.error('Failed to open pi tab:', e);
    }
  }, [tabs]);

  /**
   * 打开邮箱标签页（M25）：toggle 模式——已存在则激活，否则创建。
   * 与 handleOpenAi 同模式：urchin://mail 内部页由 React MailView 渲染。
   */
  const handleOpenMail = useCallback(async () => {
    const existing = tabs.find((t) => t.url?.startsWith('urchin://mail'));
    if (existing) {
      if (existing.id !== activeTabId) {
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate mail tab:', e);
        }
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://mail',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open mail tab:', e);
    }
  }, [tabs, activeTabId]);

  /**
   * 打开笔记 / 便利贴页（M27）：toggle 模式——已存在则激活，否则创建。
   * 与邮箱一致：urchin://notebook 内部页由 React NotebookView 渲染。
   */
  const handleOpenNotebook = useCallback(async () => {
    const existing = tabs.find((t) => t.url?.startsWith('urchin://notebook'));
    if (existing) {
      if (existing.id !== activeTabId) {
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate notebook tab:', e);
        }
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://notebook',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open notebook tab:', e);
    }
  }, [tabs, activeTabId]);

  /**
   * 打开 DeepSeek Harness 标签页：启动 dsh web 子进程 → 在浏览器标签页打开前端。
   * 与 piWeb 不同：关闭该标签页后自动停止后端（主进程 tab-lifecycle 绑定）。
   * toggle 语义：已激活则关闭标签（触发后端停止）；未激活则激活；未运行则启动。
   */
  const handleOpenDeepSeekHarness = useCallback(async () => {
    // 查 dsh 服务状态：running 则复用/激活标签
    let dshUrl: string | null = null;
    try {
      const s = (await window.urchin.invoke('dsh.status', {})) as {
        state?: string;
        url?: string;
      };
      if (s.state === 'running' && typeof s.url === 'string') dshUrl = s.url;
    } catch {
      // 状态查询失败：回落到启动流程
    }
    if (dshUrl) {
      // §7.1 修复（2026-11-06）：认证 URL 在 303 重定向后 tab.url 是干净 URL，
      // 旧 startsWith(dshUrl) 必然落空 → 已开标签找不到 → 重复开。改为 origin
      // 匹配（与主进程 tab-lifecycle、pinner 同型），toggle 语义恢复正常。
      const dshTab = tabs.find(
        (t) => typeof t.url === 'string' && sameServiceOrigin(t.url, dshUrl),
      );
      if (dshTab) {
        if (dshTab.id === activeTabId) {
          // 已激活 → 关闭标签（触发后端停止）
          try {
            await window.urchin.invoke('tab.close', { tabId: dshTab.id });
          } catch (e) {
            console.error('Failed to close dsh tab:', e);
          }
        } else {
          try {
            await window.urchin.invoke('tab.setActive', { tabId: dshTab.id });
          } catch (e) {
            console.error('Failed to activate dsh tab:', e);
          }
        }
        return;
      }
      // 服务运行但标签已关闭 → 新开标签
      try {
        await window.urchin.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url: dshUrl,
          active: true,
        });
      } catch (e) {
        console.error('Failed to open dsh tab:', e);
      }
      return;
    }
    // 未运行 → launch → 打开标签
    setDshStarting(true);
    try {
      const res = (await window.urchin.invoke('dsh.launch', {})) as {
        url: string;
        port: number;
      };
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: res.url,
        active: true,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setActionToast(`DeepSeek Harness 启动失败：${message}`);
      console.error('Failed to launch dsh:', e);
    } finally {
      setDshStarting(false);
    }
  }, [tabs, activeTabId]);

  return {
    handleOpenSettings,
    handleOpenGenOfficeHome,
    handleOpenPi,
    handleOpenMail,
    handleOpenNotebook,
    handleOpenDeepSeekHarness,
  } as const;
}
