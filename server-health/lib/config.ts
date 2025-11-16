import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_ROOT = join(__dirname, '..', '..', 'config');
export const CONFIG_ROOT = process.env['CONFIG_ROOT'] ?? DEFAULT_CONFIG_ROOT;

const API_FILES = {
  sonarr: 'sonarr/config.xml',
  radarr: 'radarr/config.xml',
  prowlarr: 'prowlarr/config.xml',
} as const;

const CACHE_TTL_MS = 60 * 1000;
let apiKeyCache: Record<string, string | null> | null = null;
let cacheExpiresAt = 0;

async function readXmlValue(relPath: string, tag: string): Promise<string | null> {
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

export type ArrApiKeys = Record<string, string | null>;

export async function loadArrApiKeys(): Promise<ArrApiKeys> {
  const now = Date.now();
  if (apiKeyCache !== null && now < cacheExpiresAt) {
    return apiKeyCache;
  }

  const entries = await Promise.all(
    Object.entries(API_FILES).map(async ([name, relPath]) => {
      const apiKey = await readXmlValue(relPath, 'ApiKey');
      return [name, apiKey] as const;
    })
  );

  apiKeyCache = Object.fromEntries(entries);
  cacheExpiresAt = now + CACHE_TTL_MS;
  return apiKeyCache;
}

const QBIT_CLIENT_REGEX = /"qbittorrent:(?:readonly:)?([^"]+)"/gi;

export interface QbitCredentials {
  username: string;
  password: string;
}

export async function loadQbitCredentials(): Promise<QbitCredentials | null> {
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

export async function loadCrossSeedStats(): Promise<CrossSeedStats | null> {
  const logPath = join(CONFIG_ROOT, 'cross-seed/logs/latest.log');
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;

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

  return {
    lastTimestamp,
    added,
  };
}
