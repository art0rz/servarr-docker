import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_ROOT = join(__dirname, '..', '..', 'config');
const DEFAULT_MEDIA_DIR = '/data/media';
export const CONFIG_ROOT = process.env['CONFIG_ROOT'] ?? DEFAULT_CONFIG_ROOT;
export const MEDIA_DIR = process.env['MEDIA_DIR'] ?? DEFAULT_MEDIA_DIR;

const API_FILES = {
  sonarr: 'sonarr/config.xml',
  radarr: 'radarr/config.xml',
  prowlarr: 'prowlarr/config.xml',
  bazarr: 'bazarr/config/config.ini',
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

async function readIniValue(relPath: string, section: string, key: string) {
  const filePath = join(CONFIG_ROOT, relPath);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    let inSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === `[${section}]`) {
        inSection = true;
        continue;
      }
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSection = false;
        continue;
      }
      if (inSection && trimmed.startsWith(key)) {
        const parts = trimmed.split('=', 2);
        if (parts.length === 2 && parts[1] !== undefined) {
          return parts[1].trim();
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
        apiKey = await readIniValue(relPath, 'auth', 'apikey');
      } else {
        apiKey = await readXmlValue(relPath, 'ApiKey');
      }
      return [name, apiKey] as const;
    })
  );

  apiKeyCache = Object.fromEntries(entries);
  console.log('[config] Loaded API keys:', Object.keys(apiKeyCache).join(', '));
  return apiKeyCache;
}

export async function loadArrApiKeys() {
  if (apiKeyCache !== null) {
    return apiKeyCache;
  }
  return await reloadApiKeys();
}

export function watchConfigFiles() {
  console.log('[config] Setting up file watchers for API key configs');

  for (const [name, relPath] of Object.entries(API_FILES)) {
    const filePath = join(CONFIG_ROOT, relPath);

    try {
      const watcher = watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          console.log(`[config] ${name} config changed, reloading API keys...`);
          void reloadApiKeys();
        }
      });

      watcher.on('error', (error) => {
        console.error(`[config] Error watching ${filePath}:`, error);
      });
    } catch (error) {
      console.error(`[config] Failed to watch ${filePath}:`, error);
    }
  }
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
const CROSS_SEED_LOG = join(CONFIG_ROOT, 'cross-seed/logs/latest.log');

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
  for (const line of lines) {
    const tsMatch = /\[(.*?)\]/.exec(line);
    if (tsMatch?.[1] !== undefined) {
      lastTimestamp = tsMatch[1];
    }
    if (/added/i.test(line) || /linked/i.test(line)) {
      added += 1;
    }
  }

  crossSeedStatsCache = {
    lastTimestamp,
    added,
  };
  console.log(`[config] Cross-Seed stats updated: ${added} torrents added, last run: ${lastTimestamp ?? 'never'}`);
}

/**
 * Watch Cross-Seed log file
 */
export function watchCrossSeedLog() {
  console.log('[config] Setting up Cross-Seed log watcher');

  // Initial load
  void reloadCrossSeedStats();

  try {
    const watcher = watch(CROSS_SEED_LOG, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        void reloadCrossSeedStats();
      }
    });

    watcher.on('error', (error) => {
      console.error(`[config] Error watching ${CROSS_SEED_LOG}:`, error);
    });
  } catch (error) {
    console.error(`[config] Failed to watch ${CROSS_SEED_LOG}:`, error);
  }
}

/**
 * Get cached Cross-Seed stats
 */
export async function loadCrossSeedStats() {
  return crossSeedStatsCache;
}
