/**
 * tool-approval.ts 单元测试（移植自上游 pi-web-ui tests/unit/tool-approval.test.ts）
 *
 * 覆盖：高危命令/敏感文件识别、规则档位（category）稳定性、三档放行判定、
 * 宽范围操作不被「记住同类」放行、以及命中清单 hits[] 透传。
 */
import { describe, expect, it } from 'vitest';
import {
  approvalSuppressionReason,
  checkDangerousToolCall,
  isApprovalPolicyEmpty,
  isWideScopeOrRootOperation,
  pluginApprovalCategory,
  type ApprovalPolicy,
} from '../../src/pi-server/tool-approval.js';
import type { ApprovalRule } from '../../src/pi-server/approval-rules.js';

function policy(allowAll: boolean, ids: string[] = []): ApprovalPolicy {
  return {
    allowAll,
    categories: new Map(ids.map((id) => [id, { id, label: id, labelEn: id }])),
  };
}

describe('dangerous tool call detection', () => {
  const cwd = '/workspace/project';

  describe('bash high-risk commands', () => {
    it('should detect rm -rf style destructive deletes', () => {
      const res = checkDangerousToolCall('bash', { command: 'rm -rf /' }, cwd);
      expect(res.dangerous).toBe(true);
      expect(res.reason).toContain('rm -rf');

      const resStar = checkDangerousToolCall('bash', { command: 'rm -rf *' }, cwd);
      expect(resStar.dangerous).toBe(true);

      const resTilde = checkDangerousToolCall('bash', { command: 'rm -r ~' }, cwd);
      expect(resTilde.dangerous).toBe(true);
    });

    it('should detect destructive git commands', () => {
      const resPush = checkDangerousToolCall(
        'bash',
        { command: 'git push origin main --force' },
        cwd,
      );
      expect(resPush.dangerous).toBe(true);
      expect(resPush.reason).toContain('Git');

      const resReset = checkDangerousToolCall('bash', { command: 'git reset --hard HEAD~1' }, cwd);
      expect(resReset.dangerous).toBe(true);

      const resClean = checkDangerousToolCall('bash', { command: 'git clean -fd' }, cwd);
      expect(resClean.dangerous).toBe(true);
    });

    it('should detect disk formatting and system destruction commands', () => {
      const resFormat = checkDangerousToolCall('bash', { command: 'format C:' }, cwd);
      expect(resFormat.dangerous).toBe(true);

      const resMkfs = checkDangerousToolCall('bash', { command: 'mkfs.ext4 /dev/sda1' }, cwd);
      expect(resMkfs.dangerous).toBe(true);

      const resChmod = checkDangerousToolCall('bash', { command: 'chmod 777 -R /' }, cwd);
      expect(resChmod.dangerous).toBe(true);
    });

    it('should not flag safe commands', () => {
      const safe1 = checkDangerousToolCall('bash', { command: 'git status' }, cwd);
      expect(safe1.dangerous).toBe(false);

      const safe2 = checkDangerousToolCall('bash', { command: 'ls -la' }, cwd);
      expect(safe2.dangerous).toBe(false);

      const safe3 = checkDangerousToolCall('bash', { command: 'npm test' }, cwd);
      expect(safe3.dangerous).toBe(false);
    });
  });

  describe('file modification of sensitive targets', () => {
    it('should detect edits to secrets, ssh keys and shell profiles', () => {
      const resEnv = checkDangerousToolCall('write', { path: '.env' }, cwd);
      expect(resEnv.dangerous).toBe(true);
      expect(resEnv.reason).toContain('.env');

      const resEnvProd = checkDangerousToolCall('edit', { path: 'config/.env.production' }, cwd);
      expect(resEnvProd.dangerous).toBe(true);

      const resSsh = checkDangerousToolCall('write', { path: '/home/user/.ssh/id_rsa' }, cwd);
      expect(resSsh.dangerous).toBe(true);

      const resBashrc = checkDangerousToolCall('edit_soft', { path: '/home/user/.bashrc' }, cwd);
      expect(resBashrc.dangerous).toBe(true);
    });

    it('should detect writes outside the workspace', () => {
      const resOutside = checkDangerousToolCall('write', { path: '../../external.txt' }, cwd);
      expect(resOutside.dangerous).toBe(true);
      expect(resOutside.reason).toContain('工作区外部');
    });

    it('should allow ordinary source file edits inside the workspace', () => {
      const resCode = checkDangerousToolCall('write', { path: 'src/index.ts' }, cwd);
      expect(resCode.dangerous).toBe(false);

      const resDoc = checkDangerousToolCall('edit', { path: 'docs/readme.md' }, cwd);
      expect(resDoc.dangerous).toBe(false);
    });
  });

  describe('rule categories', () => {
    it('should expose a stable category id for every builtin rule', () => {
      const cases: [string, unknown, string][] = [
        ['bash', { command: 'rm -rf /' }, 'bash.rm-rf'],
        ['bash', { command: 'git reset --hard HEAD~1' }, 'bash.git-destructive'],
        ['bash', { command: 'mkfs.ext4 /dev/sda1' }, 'bash.disk'],
        ['write', { path: '.env' }, 'file.sensitive.env'],
        ['write', { path: '/home/u/.ssh/id_rsa' }, 'file.sensitive.ssh'],
        ['edit_soft', { path: '/home/u/.bashrc' }, 'file.sensitive.shell'],
        ['write', { path: '../../outside.txt' }, 'file.outside-workspace'],
      ];
      for (const [tool, params, id] of cases) {
        const res = checkDangerousToolCall(tool, params, cwd);
        expect(res.dangerous, `${tool} ${id}`).toBe(true);
        expect(res.category?.id, `${tool} ${id}`).toBe(id);
        expect(res.category?.label).toBeTruthy();
        expect(res.category?.labelEn).toBeTruthy();
      }
    });

    it('should reuse the same category id across similar out-of-workspace rules', () => {
      const a = checkDangerousToolCall('write', { path: '../a.txt' }, cwd);
      const b = checkDangerousToolCall('edit', { path: '/tmp/b.txt' }, cwd);
      expect(a.category?.id).toBe(b.category?.id);
    });

    it('should namespace plugin confirmations per plugin', () => {
      const cat = pluginApprovalCategory('demo-plugin');
      expect(cat.id).toBe('plugin:demo-plugin');
      expect(cat.label).toContain('demo-plugin');
      expect(pluginApprovalCategory('other').id).not.toBe(cat.id);
    });
  });

  describe('approval suppression', () => {
    it('should suppress everything when the global switch is off', () => {
      expect(approvalSuppressionReason(undefined, false)).toBe('disabled');
      expect(
        approvalSuppressionReason(policy(false, ['bash.rm-rf']), false, 'bash.git-destructive'),
      ).toBe('disabled');
    });

    it('should suppress everything when this conversation allowed all', () => {
      expect(approvalSuppressionReason(policy(true), true)).toBe('allow-all');
      expect(approvalSuppressionReason(policy(true), true, 'bash.rm-rf')).toBe('allow-all');
    });

    it('should only suppress the remembered category', () => {
      const p = policy(false, ['bash.rm-rf']);
      expect(approvalSuppressionReason(p, true, 'bash.rm-rf')).toBe('category');
      expect(approvalSuppressionReason(p, true, 'bash.git-destructive')).toBeNull();
      expect(approvalSuppressionReason(p, true, undefined)).toBeNull();
    });

    it('should keep asking with an empty policy and report emptiness correctly', () => {
      expect(approvalSuppressionReason(undefined, true, 'bash.rm-rf')).toBeNull();
      expect(approvalSuppressionReason(policy(false), true, 'bash.rm-rf')).toBeNull();
      expect(isApprovalPolicyEmpty(undefined)).toBe(true);
      expect(isApprovalPolicyEmpty(policy(false))).toBe(true);
      expect(isApprovalPolicyEmpty(policy(true))).toBe(false);
      expect(isApprovalPolicyEmpty(policy(false, ['bash.rm-rf']))).toBe(false);
    });

    it('should never suppress a remembered category for wide-scope or root operations', () => {
      const p = policy(false, ['bash.rm-rf']);
      expect(
        approvalSuppressionReason(p, true, 'bash.rm-rf', 'bash', { command: 'rm -rf /' }),
      ).toBeNull();
      expect(
        approvalSuppressionReason(p, true, 'bash.rm-rf', 'bash', { command: 'rm -rf ./dist' }),
      ).toBe('category');
    });
  });

  describe('hit details', () => {
    it('should return a detailed hits[] list for dangerous bash calls', () => {
      const cmd = 'cd /project && rm -rf ./data && git reset --hard';
      const res = checkDangerousToolCall('bash', { command: cmd }, cwd);
      expect(res.dangerous).toBe(true);
      expect(res.hits).toBeDefined();
      expect(res.hits!.length).toBeGreaterThanOrEqual(2);
      expect(res.hits![0].field).toBe('command');
      expect(res.hits![0].text).toBeTruthy();
      expect(res.hits![0].index).toBeGreaterThanOrEqual(0);
      expect(res.hits![0].length).toBeGreaterThan(0);
    });

    it('should return undefined hits for safe commands', () => {
      const res = checkDangerousToolCall('bash', { command: 'ls -la' }, cwd);
      expect(res.dangerous).toBe(false);
      expect(res.hits).toBeUndefined();
    });
  });

  describe('isWideScopeOrRootOperation', () => {
    it('should treat non-object params as not wide-scope', () => {
      expect(isWideScopeOrRootOperation('bash', null)).toBe(false);
      expect(isWideScopeOrRootOperation('bash', 'rm -rf /')).toBe(false);
    });

    it('should flag recursive deletes of root, home, wildcard and drive roots', () => {
      expect(isWideScopeOrRootOperation('bash', { command: 'rm -rf /' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'rm -rf ~' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'rm -rf *' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'rm -r ..' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'rm -rf C:\\' })).toBe(true);
    });

    it('should flag windows force deletes, disk tools, system redirects and chmod', () => {
      expect(isWideScopeOrRootOperation('bash', { command: 'del /s /q C:\\' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'mkfs.ext4 /dev/sda' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'format C:' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'dd if=/dev/zero of=/dev/sda' })).toBe(
        true,
      );
      expect(isWideScopeOrRootOperation('bash', { command: 'echo x > /etc/passwd' })).toBe(true);
      expect(isWideScopeOrRootOperation('bash', { command: 'chmod -R 777 /' })).toBe(true);
    });

    it('should flag writes to system or credential paths', () => {
      expect(isWideScopeOrRootOperation('write', { path: '/etc/hosts' })).toBe(true);
      expect(isWideScopeOrRootOperation('edit', { path: '/boot/grub.cfg' })).toBe(true);
      expect(isWideScopeOrRootOperation('patch', { path: 'C:\\Windows\\system.ini' })).toBe(true);
      expect(isWideScopeOrRootOperation('edit_soft', { path: '/home/u/.ssh/config' })).toBe(true);
      expect(isWideScopeOrRootOperation('write', { path: 'src/index.ts' })).toBe(false);
    });

    it('should ignore unrelated tools', () => {
      expect(isWideScopeOrRootOperation('read', { path: '/etc/hosts' })).toBe(false);
      expect(isWideScopeOrRootOperation('bash', { command: 'ls' })).toBe(false);
    });
  });
});

describe('custom rule actions', () => {
  const cwd = '/workspace/project';

  function rule(partial: Partial<ApprovalRule>): ApprovalRule {
    return {
      id: 'custom',
      enabled: true,
      tools: ['bash'],
      field: 'command',
      match: 'contains',
      value: 'x',
      action: 'ask',
      label: 'custom',
      labelEn: 'custom',
      ...partial,
    };
  }

  it('should report denied=true when a deny rule matches', () => {
    const deny = rule({
      action: 'deny',
      value: 'kubectl delete',
      reason: '封禁',
      reasonEn: 'blocked',
    });
    const res = checkDangerousToolCall(
      'bash',
      { command: 'kubectl delete pod x' },
      cwd,
      [],
      [deny],
    );
    expect(res.dangerous).toBe(true);
    expect(res.denied).toBe(true);
    expect(res.reason).toBe('封禁');
    expect(res.reasonEn).toBe('blocked');
    expect(res.category?.id).toBe('custom');
  });

  it('should report allowed=true when an allow rule matches', () => {
    const allow = rule({ action: 'allow', match: 'prefix', value: 'ls' });
    const res = checkDangerousToolCall('bash', { command: 'ls -la' }, cwd, [], [allow]);
    expect(res.dangerous).toBe(false);
    expect(res.allowed).toBe(true);
  });

  it('should return a plain not-dangerous result for non-object params', () => {
    expect(checkDangerousToolCall('bash', null, cwd)).toEqual({ dangerous: false });
    expect(checkDangerousToolCall('bash', 'rm -rf /', cwd)).toEqual({ dangerous: false });
  });

  it('should ignore disabled rules', () => {
    const deny = rule({ action: 'deny', value: 'rm', enabled: false });
    const res = checkDangerousToolCall('bash', { command: 'rm -rf ./dist' }, cwd, [], [deny]);
    expect(res.dangerous).toBe(false);
    expect(res.denied).toBeUndefined();
  });
});
