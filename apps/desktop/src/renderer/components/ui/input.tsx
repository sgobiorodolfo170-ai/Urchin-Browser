/**
 * M19 主题系统 · Input 组件
 *
 * 依据：契约 K §4 TH4 决策
 * 支持：文本/密码/搜索类型、错误状态、前缀/后缀图标。
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  readonly error?: boolean;
  readonly prefix?: ReactNode;
  readonly suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error = false, prefix, suffix, className, ...props },
  ref,
) {
  if (prefix || suffix) {
    return (
      <div
        className={cn(
          'inline-flex h-10 w-full items-center gap-2 rounded-md border bg-surface px-3 text-sm',
          'transition-colors duration-fast',
          'focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-1',
          error ? 'border-error' : 'border-border',
          className,
        )}
      >
        {prefix && <span className="flex shrink-0 items-center text-text-secondary">{prefix}</span>}
        <input
          ref={ref}
          className={cn(
            'h-full w-full bg-transparent text-text outline-none',
            'placeholder:text-text-secondary',
          )}
          {...props}
        />
        {suffix && <span className="flex shrink-0 items-center text-text-secondary">{suffix}</span>}
      </div>
    );
  }

  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-md border bg-surface px-3 text-sm text-text',
        'transition-colors duration-fast',
        'placeholder:text-text-secondary',
        'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1',
        error ? 'border-error' : 'border-border',
        className,
      )}
      {...props}
    />
  );
});
