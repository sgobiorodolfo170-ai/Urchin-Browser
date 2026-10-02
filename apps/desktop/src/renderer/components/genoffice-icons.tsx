/**
 * GenOffice 文档类型图标组件（从 genoffice shell 首页卡片中提取）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「跨进程边界」）：
 * - genoffice shell 运行于独立 WebContentsView，其 SVG 资源（file-*.svg）无法被
 *   Urchin 渲染层直接引用；此处以 inline SVG 复刻与 shell TabBar 完全一致的图标路径，
 *   保证右侧边栏标签图标与 genoffice 首页卡片视觉统一。
 * - 图标 SVG 路径来源于 genoffice shell 的 TabBar.tsx（DocIcon/SheetIcon/…）与
 *   Home.tsx（FolderIcon），是「提取该行所有卡片里的图标」的可复用沉淀。
 * - kind → icon 映射与 genoffice shell TabBar KIND_ICON 对齐，避免两端漂移。
 */

import type { ComponentType, ReactElement } from 'react';

interface IconProps {
  className?: string;
}

/* ── 文档类型图标（与 genoffice shell TabBar SVG 路径完全一致）── */

function DocIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <rect width="240" height="240" rx="48" fill="#3276CD" />
      <path
        d="M183.373 72H172.927C168.749 72 165.267 74.4 164.57 78C149.946 136.8 150.642 135 149.946 139.8C149.946 139.2 149.946 138.6 149.249 137.4C148.553 134.4 149.946 137.4 133.232 78C131.839 74.4 129.053 72 124.875 72H115.822C111.643 72 108.161 74.4 107.465 78C90.7509 137.4 90.7509 135.6 90.0544 139.8V137.4C89.358 134.4 80.3047 93.6 76.8227 78C75.4299 74.4 72.6442 72 68.4658 72H56.6268C51.0556 72 46.8771 76.8 48.2699 81C53.8412 100.8 67.073 147 71.2514 162.6C72.6442 166.2 76.1263 168 79.6083 168H97.0185C101.197 168 104.679 166.2 105.375 162.6L117.911 120L120 114L122.089 120C122.089 120 130.446 150 134.625 162.6C135.321 165.6 138.803 168 142.285 168H159.695C163.177 168 166.659 166.2 168.052 162.6C181.98 113.4 188.944 91.2 191.73 81C193.123 76.8 188.944 72 183.373 72Z"
        fill="#fff"
      />
    </svg>
  );
}

function SheetIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <rect width="240" height="240" rx="48" fill="#4FA16B" />
      <path
        d="M96.3863 61.8047C98.5543 61.8052 100.377 63.1591 101.332 65.1562L101.367 65.2148C114.487 90.1591 110.279 82.597 118.664 100.758L120.445 104.637L121.98 100.641C125.532 91.3552 127.882 85.7897 138.621 65.2031L137.031 64.373L138.632 65.2031L138.656 65.1562C139.61 63.1599 141.434 61.8064 143.601 61.8047H160.933C164.595 61.8047 167.33 65.8991 165.75 69.5977L165.375 70.3242L165.339 70.3828C160.568 79.1142 153.7 91.1365 148.019 101.062C145.182 106.02 142.633 110.459 140.8 113.695C139.885 115.311 139.148 116.643 138.632 117.586C138.378 118.052 138.169 118.436 138.023 118.723C137.951 118.864 137.877 119.002 137.824 119.121C137.799 119.178 137.772 119.259 137.742 119.344C137.727 119.386 137.704 119.452 137.683 119.531C137.669 119.588 137.625 119.77 137.625 120V120.469L137.859 120.879L165.351 169.629L165.375 169.676C167.682 173.542 164.837 178.195 160.933 178.195H143.601C141.455 178.194 139.917 177.443 139.007 176.086L138.656 175.477L138.621 175.418L131.425 161.473C126.778 152.195 128.26 153.91 121.945 139.289L120.316 135.504L118.652 139.277C115.953 145.392 114.95 148.635 109.089 160.395L101.367 175.406L101.332 175.477C100.498 177.217 98.8376 178.195 96.3863 178.195H79.6519C75.0237 178.195 72.3782 173.434 74.6246 169.676L74.6363 169.629L102.14 120.879L102.632 120L102.14 119.121L74.6832 70.4648C73.747 68.4964 73.8839 66.2974 74.8003 64.6172C75.6999 62.9712 77.3618 61.8048 79.6519 61.8047H96.3863Z"
        fill="#fff"
      />
    </svg>
  );
}

function SlideIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <rect width="240" height="240" rx="48" fill="#D33922" />
      <path
        d="M130.5 72C152.5 72 167 87.75 167 109.898C167 154.195 122.5 147.797 111 147.797V175.852C111 179.297 108.5 181.758 105 181.758H90C86.5 181.758 84 179.297 84 175.852V77.9062C84 74.4609 86.5 72 90 72H130.5ZM111 124.664H124.5C129 124.664 132.5 123.188 135 120.727C140 114.82 140 104.484 135.5 99.0703C133 96.1172 129.5 95.1328 125 95.1328H111V124.664Z"
        fill="#fff"
      />
    </svg>
  );
}

function PdfIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <rect width="240" height="240" rx="48" fill="#EF4444" />
      <path
        d="M102.719 63.0153C105.738 52.1477 126.265 50.9398 128.68 66.6374C131.699 75.6938 127.472 90.7878 125.661 100.448C130.491 113.127 137.133 122.183 147.397 128.22C158.264 127.013 179.395 125.202 186.641 132.447C192.678 138.485 191.471 155.389 175.774 155.389C166.717 155.389 153.434 151.767 141.963 145.126C129.284 147.541 114.19 152.974 100.907 157.804C70.7196 209.727 53.2104 186.181 55.0216 176.521C57.4366 164.446 73.7385 154.786 85.8136 148.749C91.8511 137.277 100.907 117.957 106.944 103.466C102.718 86.5617 100.304 72.6754 102.719 63.0153ZM85.2149 158.437C81.5921 161.456 70.1214 171.117 67.1026 179.569C67.1026 179.569 73.7436 176.55 85.2149 158.437ZM116.605 113.718C112.378 124.586 107.548 136.662 101.511 146.925C111.171 142.699 122.039 137.869 134.718 134.85C127.473 130.02 121.435 122.775 116.605 113.718ZM180.613 143.932C183.028 142.121 179.406 137.291 158.275 139.102C177.595 147.555 180.613 143.932 180.613 143.932ZM116.013 64.2419C114.805 64.2436 114.806 80.5436 117.221 88.9958C120.239 83.5616 120.843 64.2421 116.013 64.2419Z"
        fill="#fff"
      />
    </svg>
  );
}

function MarkdownIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <rect width="240" height="240" rx="48" fill="#8B5CF6" />
      <path
        d="M36.4103 164L44.1723 164C47.2768 164 49.8641 161.8 50.382 158.5C61.2484 104.6 60.7313 106.25 61.2484 101.85C61.2484 102.4 62 98.9167 63.5 101.85C64.5 105.792 61.2484 92.1333 73.6679 146.583C74.7029 149.883 76.7731 152.083 79.8776 152.083L86.6045 152.083C89.7097 152.083 92.297 149.883 92.8142 146.583C103.693 98.8889 103.329 99.9343 104.415 100.62C104.569 100.717 104.752 100.807 105 100.75L105.752 104.05C106.269 106.8 112.996 144.2 115.583 158.5C116.618 161.8 118.688 164 121.793 164L130.59 164C134.729 164 137.834 159.6 136.799 155.75C132.66 137.6 122.828 95.25 119.723 80.95C118.688 77.65 116.101 76 113.513 76L100.576 76C97.4717 76 94.8843 77.65 94.3672 80.95L85.0522 120L83.5 125.5L81.9477 120C81.9477 120 75.738 92.5 72.6328 80.95C72.1156 78.2 69.5283 76 66.941 76L54.0044 76C51.4171 76 48.8298 77.65 47.7947 80.95C37.4454 126.05 32.2708 146.4 30.2006 155.75C29.1655 159.6 32.2708 164 36.4103 164Z"
        fill="#fff"
      />
      <path d="M168 82C168 78.6863 170.686 76 174 76H184C187.314 76 190 78.6863 190 82V142H168V82Z" fill="#fff" />
      <path
        d="M175.248 162.741C177.239 165.001 180.761 165.001 182.752 162.741L208.684 133.305C211.528 130.076 209.236 125 204.932 125H153.068C148.765 125 146.472 130.076 149.316 133.305L175.248 162.741Z"
        fill="#fff"
      />
    </svg>
  );
}

function HtmlIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 240 240" fill="none" aria-hidden="true">
      <rect width="240" height="240" rx="48" fill="#0FA3A3" />
      <path
        d="M92 72L44 120L92 168M148 72L196 120L148 168"
        stroke="#fff"
        strokeWidth="20"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ── 文件夹图标（对应「打开本地文件」卡片，Windows 系统默认金黄色风格）── */

function FolderIcon({ className }: IconProps) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M2 8C2 6.9 2.9 6 4 6h7.5c.6 0 1.1.2 1.5.6L15 8.5h12c1.1 0 2 .9 2 2v1.5H2V8z" fill="#D4A017" />
      <path d="M2 11h27v13c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V11z" fill="#FFD83B" />
      <path d="M2 11h27v1.5H2V11z" fill="#E8B923" fillOpacity="0.5" />
    </svg>
  );
}

/* ── kind → 图标组件映射（与 genoffice shell TabBar KIND_ICON 对齐）── */

const GENOFFICE_KIND_ICONS: Record<string, ComponentType<IconProps>> = {
  docs: DocIcon,
  sheets: SheetIcon,
  slides: SlideIcon,
  pdf: PdfIcon,
  markdown: MarkdownIcon,
  html: HtmlIcon,
  shell: FolderIcon,
};

/** genoffice 伪地址前缀（与主进程 genoffice/url.ts GENOFFICE_URL_PREFIX 一致）。 */
const GENOFFICE_URL_PREFIX = 'urchin://genoffice';

/**
 * 根据 tab URL 解析 genoffice kind 并返回对应图标元素。
 *
 * - `urchin://genoffice/?kind=docs&path=…` → DocIcon
 * - `urchin://genoffice-home` → FolderIcon（对应「打开本地文件」卡片图标）
 * - 其他 genoffice 地址（缺 kind 参数）→ FolderIcon 保底
 * - 非 genoffice 地址 → null（调用方自行处理）
 */
export function getGenOfficeTabIcon(
  url: string | undefined,
  className?: string,
): ReactElement | null {
  if (!url) return null;

  // genoffice 首页（urchin://genoffice-home）→ 文件夹图标
  if (url === 'urchin://genoffice-home') return <FolderIcon className={className} />;

  // genoffice 编辑器标签（urchin://genoffice/?kind=<app>&path=…）
  if (url.startsWith(GENOFFICE_URL_PREFIX)) {
    try {
      const parsed = new URL(url);
      const kind = parsed.searchParams.get('kind');
      const IconComp = kind ? GENOFFICE_KIND_ICONS[kind] : undefined;
      if (IconComp) return <IconComp className={className} />;
    } catch {
      // URL 解析失败 → 保底文件夹图标
    }
    return <FolderIcon className={className} />;
  }

  return null;
}
