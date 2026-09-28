// Negative and positive cases for scripts/check-webview-lockstep.mjs. Run: node --test scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = readFileSync(join(repo, 'src-tauri', 'Cargo.lock'), 'utf8');

function fixture({ capabilities = { 'default.json': { identifier: 'x', webviews: ['main'], permissions: [] } }, lockText = lock } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lockstep-'));
  mkdirSync(join(root, 'src-tauri', 'capabilities'), { recursive: true });
  writeFileSync(join(root, 'src-tauri', 'Cargo.lock'), lockText);
  cpSync(join(repo, 'src-tauri', 'tauri.conf.json'), join(root, 'src-tauri', 'tauri.conf.json'));
  for (const [name, value] of Object.entries(capabilities)) {
    mkdirSync(dirname(join(root, 'src-tauri', 'capabilities', name)), { recursive: true });
    writeFileSync(join(root, 'src-tauri', 'capabilities', name), JSON.stringify(value));
  }
  return spawnSync(process.execPath, [join(repo, 'scripts', 'check-webview-lockstep.mjs')], { env: { ...process.env, VISLEX_LOCKSTEP_ROOT: root }, encoding: 'utf8' });
}

test('passes for the checked-in lock and a main-only capability', () => {
  assert.equal(fixture().status, 0);
});

test('fails when the app uses a different windows version than tauri-runtime-wry', () => {
  const start = lock.indexOf('name = "local-evidence-desk"');
  const end = lock.indexOf('[[package]]', start);
  const edited = lock.slice(0, start) + lock.slice(start, end).replace(' "windows",', ' "windows 0.61.3",') + lock.slice(end);
  const result = fixture({ lockText: edited });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /windows: tauri-runtime-wry uses/);
});

test('fails for window-scoped, other-webview and remote capabilities, including nested files', () => {
  const result = fixture({ capabilities: { 'nested/bad.json': { identifier: 'y', windows: ['main'], webviews: ['research'], remote: { urls: ['https://*'] }, permissions: [] } } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scoped with "webviews", not "windows"/);
  assert.match(result.stderr, /only the "main" webview/);
  assert.match(result.stderr, /remote capabilities are not allowed/);
});
