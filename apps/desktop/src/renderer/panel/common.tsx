/**
 * 收藏夹面板 · 共享小组件（P2 Session 4 迁移）
 *
 * 两个组件均复刻内联脚本的原始 DOM 结构与交互语义（类名/守卫选择器不变）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 网站图标槽：优先显示主进程缓存的网站图标（urchin://favicon/<hash>），
 * 加载失败（或无图标）时回退到 emoji，避免远程/缓存文件缺失时出现破图。
 *
 * 对应原 faviconSlot() + bindFaviconFallbacks()：原实现预渲染 <img> +
 * 隐藏的回退 span，img error 事件里切换 display；React 版以 onError 状态切换。
 */
export function FaviconSlot({ src, fallback }: { src?: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  // 图标地址变化（列表重取后 URL 更新）时重置失败态，重试加载
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return (
      <span className="favicon-slot">
        <span className="icon favicon-fallback">{fallback}</span>
      </span>
    );
  }
  return (
    <span className="favicon-slot">
      <img className="favicon" src={src} alt="" onError={() => setFailed(true)} />
      <span className="icon favicon-fallback" style={{ display: 'none' }}>
        {fallback}
      </span>
    </span>
  );
}

interface InlineRenameInputProps {
  /** 初始值（原实现取自被替换的标题文本） */
  initial: string;
  placeholder?: string;
  className: string;
  /** 结束回调：save=Enter/失焦提交，save=false=Esc 取消；value 已 trim */
  onFinish: (save: boolean, value: string) => void;
}

/**
 * 行内编辑输入框（重命名 / 新建文件夹共用）。
 *
 * 语义复刻原 startInlineRename / bindNewFolder 中的动态 input：
 * - 挂载即聚焦、光标置于末尾（setSelectionRange(len, len)）；
 * - Enter 确认 / Esc 取消 / 失焦确认；
 * - settled 守卫保证 Enter 后的卸载不会再次触发 blur 重复提交；
 * - click/pointerdown 阻止冒泡，避免误触行点击（打开 URL/进入文件夹）与拖拽。
 */
export function InlineRenameInput({
  initial,
  placeholder,
  className,
  onFinish,
}: InlineRenameInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settledRef = useRef(false);

  const finish = (save: boolean): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    onFinish(save, String(inputRef.current?.value ?? '').trim());
  };

  return (
    <input
      ref={(el) => {
        inputRef.current = el;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }}
      type="text"
      className={className}
      defaultValue={initial}
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
