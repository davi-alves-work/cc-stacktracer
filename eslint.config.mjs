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
  {
    // Telemetria nunca pode derrubar a app: uma promise sem dono vira unhandledRejection, que derruba o
    // processo no Node >= 15. `runDetached` (src/core/safe-run.ts) é o jeito permitido de soltar uma.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
);
