/**
 * HTTP utilities for health probes
 */

interface HttpOptions {
  headers?: Array<string>;
  timeout?: number;
}

/**
 * Generate headers for *arr services (Sonarr, Radarr, Prowlarr)
 */
export function arrHeaders(apiKey: string | null) {
  return apiKey !== null ? [`X-Api-Key: ${apiKey}`] : [];
}

/**
 * Generate headers for qBittorrent
 */
export function qbitHeaders(baseUrl: string, extras: Array<string> = []) {
  return [`Referer: ${baseUrl}/`, `Origin: ${baseUrl}`, ...extras];
}

/**
 * Convert header array to Headers object
 */
export function buildHeaders(headerList: Array<string> = []) {
  const headers = new Headers();
  for (const header of headerList) {
    const separatorIndex = header.indexOf(':');
    if (separatorIndex > 0) {
      const key = header.slice(0, separatorIndex).trim();
      const value = header.slice(separatorIndex + 1).trim();
      headers.set(key, value);
    }
  }
  return headers;
}

/**
 * Core HTTP request function shared by GET and POST
 */
async function httpRequest(
  url: string,
  method: 'GET' | 'POST',
  options: HttpOptions = {},
  body?: string
) {
  const timeout = (options.timeout ?? (method === 'GET' ? 3 : 4)) * 1000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, timeout);

  try {
    const headers = buildHeaders(options.headers);

    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });

    const text = await response.text();

    if (response.ok) {
      return { ok: true, out: text };
    } else {
      return { ok: false, out: '', err: text };
    }
  } catch (error) {
    return {
      ok: false,
      out: '',
      err: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make a GET request using native fetch
 */
export async function httpGet(url: string, options: HttpOptions = {}) {
  return httpRequest(url, 'GET', options);
}

/**
 * Make a POST request using native fetch
 */
export async function httpPost(url: string, body: unknown, options: HttpOptions = {}) {
  const headers = ['Content-Type: application/json', ...(options.headers ?? [])];
  return httpRequest(url, 'POST', { ...options, headers }, JSON.stringify(body));
}

/**
 * Safely parse JSON and extract a typed value
 */
export function parseJson<T>(json: string, extractor: (data: unknown) => T | null): T | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    return extractor(parsed);
  } catch {
    return null;
  }
}
