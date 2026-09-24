import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

test('request cards and list items preserve shared status and tooltip behavior', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // The UI fixture registers its own client TypeScript configuration.
  delete env.TS_NODE_PROJECT;
  delete env.TS_NODE_FILES;
  const result = spawnSync(
    process.execPath,
    ['--test', 'test/request-card-status.test.cjs'],
    {
      cwd: path.join(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 30000,
      env,
    }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pass 16/);
});
