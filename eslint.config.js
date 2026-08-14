// ESLint 9 Flat Config
// 依据：agents.md §九 质量护栏 / 03-技术栈 §2 (SC7)
// 工具：ESLint 9 + typescript-eslint + eslint-plugin-react(-hooks) + eslint-config-prettier
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // 全局忽略
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      'build/**',
      '**/build/**',
      'out/**',
      'release/**',
      '**/release/**',
      'coverage/**',
      '**/coverage/**',
      'node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.cjs',
      '**/*.config.mjs',
      '.lintstagedrc.js',
      'docs/**',
      'apps/desktop/tests/fixtures/**',
      // vendor：内置第三方 pi monorepo，自带 biome/lint 工具链，不纳入本项目 eslint
      'vendor/**',
      // 本地运行数据与调试残留（已被 .gitignore 排除，eslint 亦不扫描）
      '*.cjs',
      '*.mjs',
      '_*.{js,cjs,mjs}',
      'brc.js',
      'generator.cjs',
      'apps/desktop/cdp-inspect.cjs',
      'apps/desktop/cdp-test-actions.cjs',
      // 纯 JS 构建/开发脚本（不属于 TS 工程，不参与类型感知 lint）
      'scripts/**',
      'apps/desktop/ico/**',
    ],
  },

  // 基础规则
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // TypeScript 项目通用配置
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React 渲染进程代码
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    ...react.configs.flat['jsx-runtime'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // 主进程 / preload / utility（Node 环境）
  {
    files: [
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
      'packages/ai-orchestrator/src/**/*.ts',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },

  // 测试文件放宽
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.integration.test.ts', '**/*.e2e.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Prettier 兼容（关闭与 prettier 冲突的规则）
  prettier,
);
