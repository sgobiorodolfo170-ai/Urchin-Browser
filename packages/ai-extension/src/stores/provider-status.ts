/**
 * Provider 状态管理（Zustand store）
 *
 * 从 apps/desktop 迁移至 ai-extension，逻辑保持一致。
 * 依据：契约 I §2 OR7 决策
 */
import { create } from 'zustand';

export type ProviderStatus = 'initializing' | 'ready' | 'crashed' | 'disposed';

export interface ProviderStatusEntry {
  readonly providerId: string;
  readonly status: ProviderStatus;
  readonly crashReason?: string;
  readonly updatedAt: number;
}

interface ProviderEventPayload {
  readonly type: 'state-changed' | 'crashed';
  readonly providerId: string;
  readonly state?: ProviderStatus;
  readonly reason?: string;
}

interface ProviderStatusStore {
  statuses: Map<string, ProviderStatusEntry>;
  handleEvent(event: ProviderEventPayload): void;
  isProviderCrashed(providerId: string): boolean;
  getProviderStatus(providerId: string): ProviderStatusEntry | undefined;
  clearCrash(providerId: string): void;
}

export const useProviderStatusStore = create<ProviderStatusStore>((set, get) => ({
  statuses: new Map(),

  handleEvent(event) {
    set((state) => {
      const statuses = new Map(state.statuses);
      const now = Date.now();

      if (event.type === 'crashed') {
        statuses.set(event.providerId, {
          providerId: event.providerId,
          status: 'crashed',
          crashReason: event.reason,
          updatedAt: now,
        });
      } else if (event.type === 'state-changed' && event.state) {
        const existing = statuses.get(event.providerId);
        const crashReason = event.state === 'ready' ? undefined : existing?.crashReason;
        statuses.set(event.providerId, {
          providerId: event.providerId,
          status: event.state,
          crashReason,
          updatedAt: now,
        });
      }

      return { statuses };
    });
  },

  isProviderCrashed(providerId) {
    const entry = get().statuses.get(providerId);
    return entry?.status === 'crashed';
  },

  getProviderStatus(providerId) {
    return get().statuses.get(providerId);
  },

  clearCrash(providerId) {
    set((state) => {
      const statuses = new Map(state.statuses);
      statuses.delete(providerId);
      return { statuses };
    });
  },
}));
