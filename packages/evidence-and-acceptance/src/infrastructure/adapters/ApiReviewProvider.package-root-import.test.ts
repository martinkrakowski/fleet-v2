import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Tests that importing the package root does not load the provider SDK.
 *
 * The provider SDK (`ai` and `@ai-sdk/openai-compatible`) must only be loaded
 * when the function returned by `createSdkApiReviewGenerate` is actually called,
 * not when the package root (`@fleet/evidence-and-acceptance`) is imported.
 *
 * This test runs in a fresh child process to avoid module cache contamination
 * from other tests.
 */

describe('Package root import: lazy SDK import', () => {
  it('importing @fleet/evidence-and-acceptance does not load the ai module', async () => {
    const packageRoot = resolve(__dirname, '../../../../..');
    const testScript = `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import '@fleet/evidence-and-acceptance';

// Check if 'ai' module is in the require cache
const aiLoaded = Object.keys(require.cache).some(
  (key) => key.includes('node_modules/ai') && !key.includes('@fleet')
);

if (aiLoaded) {
  console.error('FAIL: ai module was loaded by package root import');
  process.exit(1);
} else {
  console.log('PASS: ai module not loaded by package root import');
  process.exit(0);
}
`;

    const result = await runNodeScript(testScript, packageRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('importing @fleet/evidence-and-acceptance does not load @ai-sdk/openai-compatible', async () => {
    const packageRoot = resolve(__dirname, '../../../../..');
    const testScript = `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import '@fleet/evidence-and-acceptance';

// Check if '@ai-sdk/openai-compatible' module is in the require cache
const openaiCompatLoaded = Object.keys(require.cache).some(
  (key) => key.includes('@ai-sdk/openai-compatible')
);

if (openaiCompatLoaded) {
  console.error('FAIL: @ai-sdk/openai-compatible module was loaded by package root import');
  process.exit(1);
} else {
  console.log('PASS: @ai-sdk/openai-compatible module not loaded by package root import');
  process.exit(0);
}
`;

    const result = await runNodeScript(testScript, packageRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS');
  });
});

function runNodeScript(script: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--input-type=module', '-e', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: '--experimental-vm-modules',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}