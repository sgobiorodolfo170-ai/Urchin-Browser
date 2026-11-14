/**
 * 标签页图标（展开态与折叠态共用）
 *
 * 加载中 → spinner；崩溃 → 红叉；urchin://settings → 齿轮；
 * 普通网页 → 主进程访问时采集并持久缓存的 favicon；
 * 图标加载失败逐级回退，皆不可用 → 灰点占位。
 */
import { useEffect, useState } from 'react';
import {
  X,
  Settings as SettingsIcon,
  Home,
  FileText,
  Mail as MailIcon,
  PenLine,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { getGenOfficeTabIcon } from '../components/genoffice-icons';
import type { TabSnapshot } from './types';

export function TabFavicon({
  tab,
  className,
}: {
  tab: TabSnapshot;
  className?: string;
}): React.JSX.Element {
  if (tab.loading) {
    return (
      <div
        className={cn(
          'shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent',
          className ?? 'h-3 w-3',
        )}
      />
    );
  }
  if (tab.crashed) {
    return <X className={cn('shrink-0 text-error', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://settings')) {
    return <SettingsIcon className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  // 内部页标签图标与左侧栏入口按钮对齐（settings/ai 已上方处理）
  if (tab.url?.startsWith('urchin://newtab')) {
    return <Home className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://mail')) {
    return <MailIcon className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://notebook')) {
    return <PenLine className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://genoffice')) {
    const iconClass = cn('shrink-0', className ?? 'h-3 w-3');
    const genofficeIcon = getGenOfficeTabIcon(tab.url, iconClass);
    if (genofficeIcon) return genofficeIcon;
    return <FileText className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  return <TabSiteIcon src={tab.favicon} className={className} />;
}

/** 标签页网站图标 <img>：加载失败逐级回退（网页缓存图标 → 浏览器图标半透明占位）。
 *  src 变化（同一标签页导航到新站点）时重置回退状态，重新从最新源尝试。 */
function TabSiteIcon({
  src,
  fallbackSrc,
  className,
}: {
  src?: string;
  fallbackSrc?: string;
  className?: string;
}): React.JSX.Element {
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
  }, [src, fallbackSrc]);
  // 过滤空源并去重：首个加载失败后严格推进到下一候选，两个都失败才显示占位。
  // 旧实现 step>0 时始终取 fallbackSrc，fallback 也失败会反复渲染破图。
  const sourceList = [src, fallbackSrc].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const sources = sourceList.filter((value, index) => sourceList.indexOf(value) === index);
  const current = sources[step];
  if (!current) {
    // 完全无法识别（网页无 favicon 或加载失败）：
    // 用浏览器图标半透明占位，淡化显示避免与真实站点图标混淆
    // 相对路径：生产页面从 file:// 加载，绝对路径会解析到磁盘根导致 404
    return (
      <img
        src="./browser-icon.png"
        alt=""
        draggable={false}
        className={cn('shrink-0 object-contain opacity-40', className ?? 'h-3 w-3')}
      />
    );
  }
  return (
    <img
      src={current}
      alt=""
      draggable={false}
      className={cn('shrink-0 object-contain', className ?? 'h-3 w-3')}
      onError={() => setStep((s) => s + 1)}
    />
  );
}
