import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/dashboard-web/**',
      'dashboard-api/**',
      'ingestion-api/dist/**',
    ],
  },
  {
    files: [
      'src/**/*.ts',
      'ingestion-api/src/**/*.ts',
      'packages/core/src/**/*.ts',
      'packages/infrastructure/src/**/*.ts',
      'packages/alerting/src/**/*.ts',
      'packages/workers/src/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
