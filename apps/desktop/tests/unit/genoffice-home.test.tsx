/**
 * GenOffice 文档主页组件（renderer/home/GenOfficeHome.tsx）单元测试（阶段 4.5）
 *
 * 覆盖：品牌/格式卡片渲染、主按钮与格式卡片触发打开动作。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GenOfficeHome } from '../../src/renderer/home/GenOfficeHome';

describe('GenOfficeHome', () => {
  it('should render title, format cards and actions', () => {
    render(<GenOfficeHome onOpenFile={vi.fn()} />);

    expect(screen.getByText('GenOffice 文档')).toBeInTheDocument();
    for (const name of ['Word 文档', 'PDF', 'Markdown', 'HTML']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /打开文件/ })).toBeInTheDocument();
    // AI 配置入口已移至文档首页（shell Home）左下角设置弹窗；本页仅展示说明
    expect(screen.getByText(/配置在文档首页左下角/)).toBeInTheDocument();
  });

  it('should call onOpenFile from the primary button and from a format card', () => {
    const onOpenFile = vi.fn();
    render(<GenOfficeHome onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByRole('button', { name: /打开文件/ }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Word 文档'));
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });
});
