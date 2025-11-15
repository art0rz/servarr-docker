import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_ROOT = join(__dirname, '..', '..', '..', 'config');
export const CONFIG_ROOT = process.env.CONFIG_ROOT || DEFAULT_CONFIG_ROOT;

const API_FILES: Record<string, string> = {
  sonarr: 'sonarr/config.xml',
  radarr: 'radarr/config.xml',
  prowlarr: 'prowlarr/config.xml'
};

const CACHE_TTL_MS = 60 * 1000;
let apiKeyCache: Record<string, string | null> | null = null;
let cacheExpiresAt = 0;

async function readXmlValue(relPath: string, tag: string): Promise<string | null> {
  const filePath = join(CONFIG_ROOT, relPath);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i');
    const match = raw.match(regex);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export async function loadArrApiKeys(): Promise<Record<string, string | null>> {
  const now = Date.now();
  if (apiKeyCache && now < cacheExpiresAt) {
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
  username?: string;
  password?: string;
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
    try {
      const url = new URL(target);
      const username = url.username ? decodeURIComponent(url.username) : '';
      const password = url.password ? decodeURIComponent(url.password) : '';
      if (!username || !password) continue;
      return { username, password };
    } catch {
      continue;
    }
  }

  return null;
}

const QBIT_WEBUI_REGEX = /qBtApiUrl\s*:\s*["'`](.+?)["'`]/i;

export interface QbitDashboardContext extends QbitCredentials {
  url?: string;
}

export async function loadQbitDashboardContext(): Promise<QbitDashboardContext> {
  const cred = await loadQbitCredentials();
  const configPath = join(CONFIG_ROOT, 'cross-seed/config.js');
  let raw = '';
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch {
    return { username: cred?.username, password: cred?.password };
  }
  const match = QBIT_WEBUI_REGEX.exec(raw);
  if (match && match[1]) {
    return { url: match[1], username: cred?.username, password: cred?.password };
  }
  return { username: cred?.username, password: cred?.password };
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

  const lines = raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (!lines.length) return null;

  let lastTimestamp: string | null = null;
  let added = 0;
  for (const line of lines) {
    const tsMatch = /\[(.*?)\]/.exec(line);
    if (tsMatch) {
      lastTimestamp = tsMatch[1];
    }
    if (/added/i.test(line) || /linked/i.test(line)) {
      added += 1;
    }
  }

  return {
    lastTimestamp,
    added
  };
}

export function resolveGitRef(): string {
  if (process.env.GIT_REF) return process.env.GIT_REF;
  try {
    const raw = readFileSync('/app/.gitref', 'utf-8');
    const match = /GIT_REF=(.+)/.exec(raw);
    return match ? match[1].trim() : raw.trim();
  } catch {
    return '';
  }
}
