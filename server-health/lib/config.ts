import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import chokidar from 'chokidar';
import { logger } from './logger';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_ROOT = join(__dirname, '..', '..', 'config');
const DEFAULT_MEDIA_DIR = '/data/media';
export const CONFIG_ROOT = process.env['CONFIG_ROOT'] ?? DEFAULT_CONFIG_ROOT;
export const MEDIA_DIR = process.env['MEDIA_DIR'] ?? DEFAULT_MEDIA_DIR;

const API_FILES = {
  sonarr: 'sonarr/config.xml',
  radarr: 'radarr/config.xml',
  prowlarr: 'prowlarr/config.xml',
  bazarr: 'bazarr/config/config.yaml',
} as const;

let apiKeyCache: Record<string, string | null> | null = null;

async function readXmlValue(relPath: string, tag: string) {
  const filePath = join(CONFIG_ROOT, relPath);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i');
    const match = regex.exec(raw);
    return match?.[1] !== undefined ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function readYamlValue(relPath: string, path: string) {
  const filePath = join(CONFIG_ROOT, relPath);
  try {
    const raw = await readFile(filePath, 'utf-8');

    // Simple YAML parser for nested keys (e.g., "auth.apikey")
    const lines = raw.split(/\r?\n/);
    const stack: Array<string> = [];

    for (const line of lines) {
      if (line.trim().startsWith('#') || line.trim().length === 0) continue;

      // Calculate indentation depth
      const indentMatch = /^( *)/.exec(line);
      const indent = indentMatch?.[1]?.length ?? 0;
      const depth = Math.floor(indent / 2);

      // Parse key: value
      const kvMatch = /^(\s*)([^:]+):\s*(.*)$/.exec(line);
      if (kvMatch?.[2] !== undefined) {
        const key = kvMatch[2].trim();
        const value = kvMatch[3]?.trim() ?? '';

        // Update stack based on depth
        stack.splice(depth);
        stack[depth] = key;

        // Check if this matches our path
        const currentPath = stack.slice(0, depth + 1).join('.');
        if (currentPath === path && value.length > 0) {
          return value;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export type ArrApiKeys = Record<string, string | null>;

async function reloadApiKeys() {
  const entries = await Promise.all(
    Object.entries(API_FILES).map(async ([name, relPath]) => {
      let apiKey: string | null;
      if (name === 'bazarr') {
        apiKey = await readYamlValue(relPath, 'auth.apikey');
      } else {
        apiKey = await readXmlValue(relPath, 'ApiKey');
      }
      return [name, apiKey] as const;
    })
  );

  apiKeyCache = Object.fromEntries(entries);
  logger.info({ services: Object.keys(apiKeyCache) }, 'Loaded API keys');
  return apiKeyCache;
}

export async function loadArrApiKeys() {
  if (apiKeyCache !== null) {
    return apiKeyCache;
  }
  return await reloadApiKeys();
}

export function watchConfigFiles() {
  logger.info('Setting up file watchers for API key configs');

  const filePaths = Object.entries(API_FILES).map(([, relPath]) => join(CONFIG_ROOT, relPath));

  const watcher = chokidar.watch(filePaths, {
    persistent: false,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100,
    },
  });

  watcher.on('change', (path) => {
    const name = Object.entries(API_FILES).find(([, relPath]) =>
      join(CONFIG_ROOT, relPath) === path
    )?.[0];
    logger.info({ service: name, path }, 'Config file changed, reloading API keys');
    void reloadApiKeys();
  });

  watcher.on('error', (error) => {
    logger.error({ err: error }, 'Error watching config files');
  });
}

const QBIT_CLIENT_REGEX = /"qbittorrent:(?:readonly:)?([^"]+)"/gi;

export interface QbitCredentials {
  username: string;
  password: string;
}

export async function loadQbitCredentials() {
  const filePath = join(CONFIG_ROOT, 'cross-seed/config.js');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let match: RegExpExecArray | null;
  while ((match = QBIT_CLIENT_REGEX.exec(raw)) !== null) {
    const target = match[1];
    if (target === undefined) continue;
    try {
      const url = new URL(target);
      const username = url.username.length > 0 ? decodeURIComponent(url.username) : '';
      const password = url.password.length > 0 ? decodeURIComponent(url.password) : '';
      if (username.length === 0 || password.length === 0) continue;
      return { username, password };
    } catch {
      continue;
    }
  }

  return null;
}

export interface CrossSeedStats {
  lastTimestamp: string | null;
  added: number;
}

// Cross-Seed stats cache
let crossSeedStatsCache: CrossSeedStats | null = null;
const CROSS_SEED_LOG = join(CONFIG_ROOT, 'cross-seed/logs/info.current.log');

/**
 * Parse Cross-Seed log file and update cache
 */
async function reloadCrossSeedStats() {
  let raw: string;
  try {
    raw = await readFile(CROSS_SEED_LOG, 'utf-8');
  } catch {
    crossSeedStatsCache = null;
    return;
  }

  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    crossSeedStatsCache = null;
    return;
  }

  let lastTimestamp: string | null = null;
  let added = 0;

  // Parse structured log format: YYYY-MM-DD HH:MM:SS.mmm level: [component] message
  for (const line of lines) {
    // Extract timestamp from beginning of line
    const tsMatch = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
    if (tsMatch?.[1] !== undefined) {
      lastTimestamp = tsMatch[1];
    }

    // Count successful injections: "Injected X/Y torrents" where X > 0
    const injectMatch = /\[inject\] Injected (\d+)\/\d+ torrents/.exec(line);
    if (injectMatch !== null) {
      const injected = parseInt(injectMatch[1] ?? '0', 10);
      if (injected > 0) {
        added += injected;
      }
    }

    // Also count saved torrents from search
    if (line.includes('saved to') || line.includes('SAVED')) {
      added += 1;
    }
  }

  crossSeedStatsCache = {
    lastTimestamp,
    added,
  };
  logger.info({ torrentsAdded: added, lastRun: lastTimestamp }, 'Cross-Seed stats updated');
}

/**
 * Watch Cross-Seed log file
 */
export function watchCrossSeedLog() {
  logger.info('Setting up Cross-Seed log watcher');

  // Initial load
  void reloadCrossSeedStats();

  const watcher = chokidar.watch(CROSS_SEED_LOG, {
    persistent: false,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100,
    },
  });

  watcher.on('change', () => {
    void reloadCrossSeedStats();
  });

  watcher.on('error', (error) => {
    logger.error({ err: error, file: CROSS_SEED_LOG }, 'Error watching Cross-Seed log');
  });
}

/**
 * Get cached Cross-Seed stats
 */
export function loadCrossSeedStats() {
  return crossSeedStatsCache;
}
