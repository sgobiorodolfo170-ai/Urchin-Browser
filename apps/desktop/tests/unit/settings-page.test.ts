/**
 * 设置页 HTML 生成单元测试
 *
 * 验证：
 * 1. getSettingsPageHtml 返回完整 HTML 文档
 * 2. 包含关键 UI 元素：标题、设置分组、保存/重置按钮、设置项字段
 * 3. 包含与 settings-manager DEFAULT_SETTINGS 对齐的设置项 key
 */

import { describe, it, expect } from 'vitest';
import { getSettingsPageHtml } from '../../src/main/protocol/settings-page';

describe('getSettingsPageHtml', () => {
  it('should return a complete html document', () => {
    const html = getSettingsPageHtml();

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('should include page title and subtitle', () => {
    const html = getSettingsPageHtml();

    expect(html).toContain('<title>设置 · Urchin Browser</title>');
    expect(html).toContain('Urchin Browser 偏好设置');
  });

  it('should include save and reset buttons', () => {
    const html = getSettingsPageHtml();

    expect(html).toContain('id="save"');
    expect(html).toContain('id="reset"');
    expect(html).toContain('重置默认');
    expect(html).toContain('保存');
  });

  it('should include all setting groups', () => {
    const html = getSettingsPageHtml();

    expect(html).toContain('外观');
    expect(html).toContain('通用');
    expect(html).toContain('隐私与安全');
    expect(html).toContain('AI 助手');
  });

  it('should include settings keys aligned with settings-manager', () => {
    const html = getSettingsPageHtml();

    for (const key of [
      'theme',
      'language',
      'searchEngine',
      'homepage',
      'downloadsPath',
      'summary.saveDirectory',
      'blockTrackers',
      'doNotTrack',
      'summary.providerId',
      'summary.model',
      'summary.apiKey',
      'summary.baseUrl',
    ]) {
      expect(html).toContain(key);
    }
  });

  it('should include the settings page script with IPC invoke calls', () => {
    const html = getSettingsPageHtml();

    expect(html).toContain('settings.getAll');
    expect(html).toContain('settings.set');
    expect(html).toContain('provider.list');
  });
});
