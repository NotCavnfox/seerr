import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

for (const fails of [false, true]) {
  test(`runner exits ${fails ? 'nonzero for failure' : 'zero for success'}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-runner-exit-'));
    const fixture = path.join(directory, 'probe.ts');
    try {
      writeFileSync(
        fixture,
        `import { test } from 'node:test';
test('probe', () => { ${fails ? "throw new Error('deliberate failure');" : ''} });`
      );
      // The child is a new runner, not another test within this runner.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      // Do not overwrite the parent suite's JUnit report from a probe.
      delete env.CI;
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, 'index.mts'), fixture],
        { encoding: 'utf8', timeout: 30000, env }
      );
      assert.ifError(result.error);
      assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
      assert.match(result.stdout, fails ? /fail 1/ : /pass 1/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
