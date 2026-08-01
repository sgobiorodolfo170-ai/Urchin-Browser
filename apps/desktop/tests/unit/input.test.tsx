/**
 * Input 组件单元测试
 *
 * 验证：
 * 1. 无 prefix/suffix 时渲染原生 input
 * 2. 有 prefix/suffix 时渲染包裹容器
 * 3. error 状态应用 error 边框类
 * 4. props 透传到原生 input
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from '../../src/renderer/components/ui/input';

describe('Input', () => {
  it('should render a plain input without prefix/suffix', () => {
    render(<Input placeholder="搜索" />);

    const input = screen.getByPlaceholderText('搜索');
    expect(input.tagName).toBe('INPUT');
  });

  it('should render wrapped container when prefix provided', () => {
    render(<Input prefix={<span>@</span>} placeholder="用户名" />);

    expect(screen.getByText('@')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('用户名')).toBeInTheDocument();
  });

  it('should render suffix element', () => {
    render(<Input suffix={<span>🔍</span>} placeholder="查询" />);

    expect(screen.getByText('🔍')).toBeInTheDocument();
  });

  it('should apply error border class when error is true', () => {
    const { container } = render(<Input error placeholder="测试" />);

    expect(container.querySelector('input')?.className).toContain('border-error');
  });

  it('should forward value and onChange to native input', () => {
    const onChange = (): void => undefined;
    render(<Input value="hello" onChange={onChange} placeholder="测试" />);

    const input = screen.getByPlaceholderText('测试') as unknown as HTMLInputElement;
    expect(input.value).toBe('hello');
  });

  it('should forward onChange event', () => {
    let value = '';
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
      value = e.target.value;
    };
    render(<Input onChange={handleChange} placeholder="测试" />);

    fireEvent.change(screen.getByPlaceholderText('测试'), { target: { value: 'abc' } });
    expect(value).toBe('abc');
  });

  it('should merge className onto native input', () => {
    const { container } = render(<Input className="custom-cls" placeholder="测试" />);

    expect(container.querySelector('input')?.className).toContain('custom-cls');
  });
});
