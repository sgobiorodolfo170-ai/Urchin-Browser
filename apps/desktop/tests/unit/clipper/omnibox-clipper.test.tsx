/**
 * Omnibox 剪藏按钮：点击回调、禁用状态与提示文案。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Omnibox } from '../../../src/renderer/omnibox/omnibox';

const baseProps = {
  currentUrl: 'https://example.com',
  loading: false,
  securityState: 'secure' as const,
  suggestions: [],
  onNavigate: vi.fn(),
  onSuggestionQuery: vi.fn(),
};

describe('Omnibox clipper', () => {
  it('should render clip button and invoke callback', () => {
    const onClip = vi.fn();
    render(<Omnibox {...baseProps} onClip={onClip} />);
    const button = screen.getByRole('button', { name: '剪藏' });
    expect(button).toHaveAttribute('title', '剪藏（Clipper）');
    fireEvent.click(button);
    expect(onClip).toHaveBeenCalledTimes(1);
  });

  it('should disable clip button when clipDisabled', () => {
    render(<Omnibox {...baseProps} onClip={() => undefined} clipDisabled />);
    expect(screen.getByRole('button', { name: '剪藏' })).toBeDisabled();
  });
});
