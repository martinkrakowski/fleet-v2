// This root vitest config exists for the root coverage run CI makes (Q6b):
// one run from the repository root writes coverage/lcov.info over the twelve
// vitest workspaces. The per-workspace `test` scripts do not read this file.
//
// Vitest 4 searches upward from the process working directory for
// `vitest.config.*`, and no workspace ships one, so a workspace `test` script
// would load THIS file: the inline project `root` values would resolve against
// the workspace's cwd (paths that do not exist), and with passWithNoTests the
// run would exit 0 having collected nothing. The projects and coverage block
// therefore apply only when vitest runs from the repository root; from any
// other directory an empty config is exported so each workspace keeps its own
// CLI flags and Vitest's defaults.
import { realpathSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const runsFromRepositoryRoot = () =>
  realpathSync(process.cwd()) === realpathSync(import.meta.dirname);

export default defineConfig(
  runsFromRepositoryRoot()
    ? {
        test: {
          passWithNoTests: true,
          projects: [
            { root: 'packages/brief-knowledge', test: { name: '@fleet/brief-knowledge', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'packages/evidence-and-acceptance', test: { name: '@fleet/evidence-and-acceptance', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'packages/installation', test: { name: '@fleet/installation', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'packages/onboarding', test: { name: '@fleet/onboarding', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'packages/operator-coordination', test: { name: '@fleet/operator-coordination', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'packages/shared', test: { name: '@fleet/shared', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'packages/tooling', test: { name: '@fleet/tooling', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'packages/work-execution', test: { name: '@fleet/work-execution', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'apps/api', test: { name: '@fleet/api', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'apps/cli', test: { name: '@fleet/cli', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'apps/mcp', test: { name: '@fleet/mcp', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
            { root: 'apps/web', test: { name: '@fleet/web', exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.output/**'] } },
          ],
          coverage: {
            enabled: true,
            provider: 'v8',
            reporter: ['text-summary', 'lcov'],
            reportsDirectory: 'coverage',
            include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}', 'apps/api/server/**/*.ts'],
            exclude: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.d.ts', '**/dist/**', 'apps/api/test/**'],
          },
        },
      }
    : {},
);
