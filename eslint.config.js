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
      'build/**',
      'out/**',
      'release/**',
      'coverage/**',
      '**/coverage/**',
      'node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.cjs',
      '**/*.config.mjs',
      '.lintstagedrc.js',
      'docs/**',
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
