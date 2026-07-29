/**
 * M19 主题系统 · 类名合并工具
 *
 * 结合 clsx 和 tailwind-merge，处理 Tailwind 类名冲突。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并类名，智能处理 Tailwind 冲突。
 *
 * @param inputs 类名输入
 * @returns 合并后的类名字符串
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
