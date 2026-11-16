import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OAuthLogin } from '../../src/renderer/mail/OAuthLogin';
describe('mail OAuth login UI', () => {
  it('loads app metadata and authorizes without receiving tokens in the renderer', async () => {
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'mail.oauth.config.get'
          ? { clientId: 'own-client', hasClientSecret: false }
          : { ok: true },
      ),
    );
    Object.defineProperty(window, 'urchin', { configurable: true, value: { invoke } });
    const saved = vi.fn();
    const busy = vi.fn();
    render(
      <OAuthLogin
        provider="outlook"
        email="me@hotmail.com"
        name="Me"
        onSaved={saved}
        onBusy={busy}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('OAuth Client ID')).toHaveValue('own-client'));
    fireEvent.click(screen.getByRole('button', { name: '使用 Microsoft 授权登录' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith('mail.oauth.login', {
      provider: 'outlook',
      email: 'me@hotmail.com',
      name: 'Me',
      accountId: undefined,
    });
    expect(busy).toHaveBeenLastCalledWith(false);
  });
});
