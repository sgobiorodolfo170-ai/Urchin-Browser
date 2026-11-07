/**
 * 划词翻译结果卡渲染入口（独立透明子窗口加载 ?view=translate-card）。
 *
 * 窗口的位置与尺寸由主进程（main/translate/selection-card-overlay.ts）按选区
 * 锚点计算；本页面只负责在窗口内绘制卡片（四周 8px 透明阴影边距透出网页）
 * 并订阅主进程的 translate:selection-result 结果事件。zod 校验跨进程边界，
 * 防主进程 payload 漂移时渲染层渲染出脏数据。
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  translateSelectionResultEventSchema,
  type TranslateSelectionResultEvent,
} from '@urchin/ipc-contract';
import { createLogger } from '../lib/logger';

const log = createLogger('selection-card');

/** 卡片四周透明阴影边距（px），与主进程 SHADOW_PAD 一致 */
const SHADOW_PAD = 8;

export function SelectionCardRoot() {
  const [data, setData] = useState<TranslateSelectionResultEvent | null>(null);

  // 订阅主进程结果事件（同一事件通道，消费方由主窗口渲染层迁到本子窗口）
  useEffect(() => {
    const off = window.urchin.on('translate:selection-result', (payload) => {
      const parsed = translateSelectionResultEventSchema.safeParse(payload);
      if (!parsed.success) {
        log.error('selection card: invalid payload', { issue: parsed.error.message });
        return;
      }
      setData(parsed.data);
    });
    return () => {
      off();
    };
  }, []);

  // 主题：直接设置 <html data-theme>，使 globals/tokens 变量生效（状态栏同模式）
  useEffect(() => {
    if (data) document.documentElement.setAttribute('data-theme', data.theme);
  }, [data]);

  // 窗口标题（便于 E2E / a11y 识别悬浮层）
  useEffect(() => {
    document.title = 'Urchin Translate Card';
    document.documentElement.dataset.window = 'selection-card';
  }, []);

  if (!data) return null;

  return (
    /* 外层占满窗口：四周 SHADOW_PAD 透明边距供 3D 阴影/圆角透出网页 */
    <div className="h-screen w-screen overflow-hidden" style={{ padding: SHADOW_PAD }}>
      <div className="flex h-full flex-col rounded-lg border border-border bg-surface p-3 shadow-dropdown">
        <div className="mb-1.5 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={data.source}>
            {data.source}
          </div>
          <button
            type="button"
            className="shrink-0 text-text-secondary hover:text-text"
            onClick={() => window.close()}
            aria-label="关闭划词翻译"
          >
            ✕
          </button>
        </div>
        {/* 结果区：内部滚动承接主进程估算高度偏差（估算按 CJK 折行，长英文段落可能低估） */}
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-text">
          {data.error ?? data.result}
        </div>
      </div>
    </div>
  );
}

/** 子窗口自挂载（main.tsx 动态导入副作用，与 status-bar-ball 同模式） */
const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <SelectionCardRoot />
    </StrictMode>,
  );
}
