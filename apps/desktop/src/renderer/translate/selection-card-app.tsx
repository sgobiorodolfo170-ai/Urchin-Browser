/**
 * 划词翻译结果卡渲染入口（独立透明子窗口加载 ?view=translate-card）。
 *
 * 窗口位置与尺寸自适应（2026-11-10）：主进程按选区锚点定位；本页面在结果渲染后
 * 用隐藏测量元素实测文本自然宽度（max-content + max-width 截断）与定宽折行高度，
 * 经 translate.cardResize 回报主进程重设窗口 bounds——卡片随文字长短伸缩，不再
 * 固定 448px 宽。仅显示译文（result/error），原文不回显；关闭由主进程在卡片失焦
 * （点击卡片外任意位置）时处理。zod 校验跨进程边界，防主进程 payload 漂移时
 * 渲染层渲染出脏数据。
 */
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  translateSelectionResultEventSchema,
  type TranslateSelectionResultEvent,
} from '@urchin/ipc-contract';
import { createLogger } from '../lib/logger';

const log = createLogger('selection-card');

/** 卡片四周透明阴影边距（px），与主进程 SHADOW_PAD 一致 */
const SHADOW_PAD = 8;
/** 文本测量上限（px），与主进程 CARD_WIDTH - CARD_PAD（448-16）一致 */
const MAX_TEXT_WIDTH = 432;

export function SelectionCardRoot() {
  const [data, setData] = useState<TranslateSelectionResultEvent | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);

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

  // 尺寸实测回报（布局期同步执行，避免首帧闪现错误尺寸）：先量不折行自然宽度，
  // 再按该宽度定宽量折行高度。seq 原样带回供主进程关联结果、丢弃过期测量。
  useLayoutEffect(() => {
    if (!data) return;
    const m = measureRef.current;
    if (!m) return;
    m.textContent = data.error ?? data.result ?? '';
    m.style.width = 'max-content';
    const width = Math.ceil(m.getBoundingClientRect().width);
    m.style.width = `${width}px`;
    const height = Math.ceil(m.getBoundingClientRect().height);
    void window.urchin
      .invoke('translate.cardResize', { seq: data.seq ?? 0, width, height })
      .catch((e) => {
        log.warn('selection card: report size failed', { error: String(e) });
      });
  }, [data]);

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
    /* 外层占满窗口：四周 SHADOW_PAD 透明边距（窗口坐标补偿沿用，当前无阴影可透出） */
    <div className="h-screen w-screen overflow-hidden" style={{ padding: SHADOW_PAD }}>
      {/* 2026-11-11 用户目测方案 B（轻量样式）：无描边、无投影、无 backdrop-blur，
          只用「半透明面板 + 圆角」，让网页内容透出来但压低对比，避免硬边矩形与文本区
          形状不一致的观感。
          注意：跨窗口的 backdrop-filter 在独立透明 BrowserWindow 上**不生效**（无法
          采样本窗口之外的内容），因此这里不用 backdrop-blur，只做 alpha 混色。
          内边距 p-2（= CARD_PAD / 2 = 8px）与主进程 CARD_PAD 成对维护：用户目测反馈
          「底板边界与文字之间距离过大」，故由 12px 收紧到 8px；圆角同步放大到
          rounded-2xl（16px），接近聊天气泡的观感（小卡片近乎胶囊，排版区不被切角）。 */}
      <div
        className="flex h-full flex-col rounded-2xl p-2"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--color-surface) 80%, transparent)',
        }}
      >
        {/* 结果区：仅显示译文（翻译失败时显示错误信息）；窗口已按实测尺寸设定，
            超高度上限时由主进程夹边、此处内部滚动兜底 */}
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-text">
          {data.error ?? data.result}
        </div>
      </div>
      {/* 隐藏测量元素：与结果区同排版参数（pre-wrap + 14px/leading-relaxed），
          max-width 即测量上限，不参与视觉与交互 */}
      <div
        ref={measureRef}
        aria-hidden
        className="absolute left-0 top-0 whitespace-pre-wrap text-sm leading-relaxed"
        style={{ visibility: 'hidden', pointerEvents: 'none', maxWidth: MAX_TEXT_WIDTH }}
      />
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
