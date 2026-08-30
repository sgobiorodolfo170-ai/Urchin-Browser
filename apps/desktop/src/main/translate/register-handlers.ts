/**
 * M24 网页翻译 · IPC Handler 注册
 *
 * 职责：注册 translate.start / stop / getStatus / translateSelection 四个通道
 * （契约单一真源在 packages/ipc-contract ipcSchema；zod 校验 + 超时 + 异常装箱
 * 由 registerHandler 统一包装）。整页翻译进度经 translate:progress 事件推送，
 * 不在本文件处理（渲染层经 preload on() 订阅）。
 *
 * 隔离声明（对齐 summary 模块口径）：translate 域不调用 pi Agent / Orchestrator /
 * Provider 子进程，HTTP 请求为主进程自有代码直连免费翻译接口。
 */
import type { IpcMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { TranslateManager } from './translate-manager';
import type { TranslateTabManagerLike } from './translate-manager';

const log = createLogger('translate-ipc');

export interface TranslateHandlerDeps {
  readonly ipcMain: IpcMain;
  readonly translateManager: TranslateManager;
  readonly tabManager: TranslateTabManagerLike;
}

/** 注册 translate 域 IPC handler。 */
export function registerTranslateHandlers(deps: TranslateHandlerDeps): void {
  const { ipcMain, translateManager, tabManager } = deps;

  const requireTab = (tabId: number): void => {
    if (!tabManager.getTab(tabId)) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Tab not found: ${tabId}`, {
        channel: 'translate.start',
      });
    }
  };

  // translate.start：整页翻译。采集后即刻返回 started，翻译进度经事件推送
  registerHandler(ipcMain, 'translate.start', async (req) => {
    log.info('translate.start', {
      tabId: req.tabId,
      engine: req.engine,
      targetLang: req.targetLang,
    });
    requireTab(req.tabId);
    return translateManager.start(req.tabId, {
      targetLang: req.targetLang,
      engine: req.engine,
    });
  });

  // translate.stop：停止翻译并恢复原文
  registerHandler(ipcMain, 'translate.stop', async (req) => {
    log.info('translate.stop', { tabId: req.tabId });
    return translateManager.stop(req.tabId);
  });

  // translate.getStatus：地址栏翻译按钮态
  registerHandler(ipcMain, 'translate.getStatus', (req) => {
    return translateManager.getStatus(req.tabId);
  });

  // translate.translateSelection：划词翻译（右键菜单传入 selectionText）
  registerHandler(ipcMain, 'translate.translateSelection', async (req) => {
    log.info('translate.translateSelection', { tabId: req.tabId, length: req.text.length });
    requireTab(req.tabId);
    return translateManager.translateSelection(req.tabId, req.text, req.targetLang);
  });

  log.info('translate ipc handlers registered');
}
