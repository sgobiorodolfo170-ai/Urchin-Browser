/**
 * 「AI 助手」选项卡（refactor-plan-p2 §3.3 步骤 4，JSX 自 SettingsPage.tsx
 * 原样迁出）
 *
 * 当前为开发中占位（原计划的 AI 提供商配置 UI 已移除，provider-* 字段
 * 机件保留在 settings-form.tsx 待复用）。
 */
export function AiSection() {
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">AI 助手</h1>
      <div className="rounded-md border border-border bg-surface-secondary px-6 py-12 text-center">
        <p className="text-sm text-text-secondary">AI 助手功能正在开发中，敬请期待。</p>
      </div>
    </section>
  );
}
