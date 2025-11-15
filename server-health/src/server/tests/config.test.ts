import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function loadModule() {
  const url = new URL('../config.js', import.meta.url);
  url.searchParams.set('reload', Date.now().toString());
  return import(url.href);
}

function withTempConfig(name: string, fn: (ctx: { tempDir: string, }) => Promise<void>) {
  test(name, async () => {
    const originalRoot = process.env.CONFIG_ROOT;
    const tempDir = mkdtempSync(path.join(tmpdir(), 'health-config-'));
    process.env.CONFIG_ROOT = tempDir;
    mkdirSync(path.join(tempDir, 'cross-seed'), { recursive: true });
    try {
      await fn({ tempDir });
    } finally {
      process.env.CONFIG_ROOT = originalRoot;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

withTempConfig('reads qBittorrent dashboard context when qBtApiUrl exists', async ({ tempDir }) => {
  const configPath = path.join(tempDir, 'cross-seed', 'config.js');
  writeFileSync(
    configPath,
    'module.exports = { qBtApiUrl: "http://gluetun:8080", torrentClients: ["qbittorrent:http://user:pass@host:1234"] };'
  );
  const { loadQbitDashboardContext } = await loadModule();
  const ctx = await loadQbitDashboardContext();
  assert.strictEqual(ctx.url, 'http://gluetun:8080');
  assert.strictEqual(ctx.username, 'user');
  assert.strictEqual(ctx.password, 'pass');
});

withTempConfig('falls back to credentials when qBtApiUrl is missing', async ({ tempDir }) => {
  const configPath = path.join(tempDir, 'cross-seed', 'config.js');
  writeFileSync(configPath, 'module.exports = { torrentClients: ["qbittorrent:http://readonly:only@host:1111"] };');
  const { loadQbitDashboardContext } = await loadModule();
  const ctx = await loadQbitDashboardContext();
  assert.strictEqual(ctx.url, undefined);
  assert.strictEqual(ctx.username, 'readonly');
  assert.strictEqual(ctx.password, 'only');
});

withTempConfig('parses cross-seed stats from logs', async ({ tempDir }) => {
  const logDir = path.join(tempDir, 'cross-seed', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'latest.log');
  writeFileSync(
    logPath,
    '[2025-01-01 10:00:00] info added torrent A\n'
    + '[2025-01-01 10:05:00] info linked torrent B\n'
    + '[2025-01-01 10:06:00] info waiting\n'
  );
  const { loadCrossSeedStats } = await loadModule();
  const stats = await loadCrossSeedStats();
  assert.ok(stats?.lastTimestamp?.includes('10:06:00'));
  assert.strictEqual(stats?.added, 2);
});
