import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_ROOT = join(__dirname, "..", "..", "config");
export const CONFIG_ROOT = process.env.CONFIG_ROOT || DEFAULT_CONFIG_ROOT;

const API_FILES = {
  sonarr: "sonarr/config.xml",
  radarr: "radarr/config.xml",
  prowlarr: "prowlarr/config.xml",
};

const CACHE_TTL_MS = 60 * 1000;
let apiKeyCache = null;
let cacheExpiresAt = 0;

async function readXmlValue(relPath, tag) {
  const filePath = join(CONFIG_ROOT, relPath);
  try {
    const raw = await readFile(filePath, "utf-8");
    const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, "i");
    const match = raw.match(regex);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export async function loadArrApiKeys() {
  const now = Date.now();
  if (apiKeyCache && now < cacheExpiresAt) {
    return apiKeyCache;
  }

  const entries = await Promise.all(
    Object.entries(API_FILES).map(async ([name, relPath]) => {
      const apiKey = await readXmlValue(relPath, "ApiKey");
      return [name, apiKey];
    })
  );

  apiKeyCache = Object.fromEntries(entries);
  cacheExpiresAt = now + CACHE_TTL_MS;
  return apiKeyCache;
}

const QBIT_CLIENT_REGEX = /"qbittorrent:(?:readonly:)?([^"]+)"/gi;

export async function loadQbitCredentials() {
  const filePath = join(CONFIG_ROOT, "cross-seed/config.js");
  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  let match;
  while ((match = QBIT_CLIENT_REGEX.exec(raw)) !== null) {
    const target = match[1];
    try {
      const url = new URL(target);
      const username = url.username ? decodeURIComponent(url.username) : "";
      const password = url.password ? decodeURIComponent(url.password) : "";
      if (!username || !password) continue;
      return { username, password };
    } catch {
      continue;
    }
  }

  return null;
}
