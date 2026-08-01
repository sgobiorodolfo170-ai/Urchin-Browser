/**
 * 类名合并工具（与浏览器核心 utils.ts 同实现，保持 ai-extension 自包含）
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
