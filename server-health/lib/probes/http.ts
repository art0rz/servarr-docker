/**
 * HTTP utilities for health probes
 */
import got from 'got';
import CircuitBreaker from 'opossum';

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
 * Convert header array to Headers object (for native fetch compatibility)
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
 * Convert header array to plain object for got
 */
function headersToObject(headerList: Array<string> = []) {
  const headers: Record<string, string> = {};
  for (const header of headerList) {
    const separatorIndex = header.indexOf(':');
    if (separatorIndex > 0) {
      const key = header.slice(0, separatorIndex).trim();
      const value = header.slice(separatorIndex + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}

// Circuit breaker configuration
const circuitBreakerOptions = {
  timeout: 5000, // If request takes longer than 5s, trigger a failure
  errorThresholdPercentage: 50, // Open circuit if 50% of requests fail
  resetTimeout: 30000, // Try again after 30s
};

// Create circuit breaker for HTTP requests
const makeRequest = async (url: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: string) => {
  const timeout = method === 'GET' ? 3000 : 4000;

  const response = await got(url, {
    method,
    headers,
    body,
    timeout: {
      request: timeout,
    },
    retry: {
      limit: 2,
      methods: ['GET', 'POST'],
      statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
    },
    throwHttpErrors: false,
  });

  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    statusCode: response.statusCode,
    body: response.body,
  };
};

const breaker = new CircuitBreaker(makeRequest, circuitBreakerOptions);

/**
 * Core HTTP request function with circuit breaker and retries
 */
async function httpRequest(
  url: string,
  method: 'GET' | 'POST',
  options: HttpOptions = {},
  body?: string
) {
  try {
    const headers = headersToObject(options.headers);
    const result = await breaker.fire(url, method, headers, body);

    if (result.ok) {
      return { ok: true, out: result.body };
    } else {
      return { ok: false, out: '', err: `HTTP ${String(result.statusCode)}` };
    }
  } catch (error) {
    return {
      ok: false,
      out: '',
      err: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Make a GET request with automatic retries and circuit breaker
 */
export async function httpGet(url: string, options: HttpOptions = {}) {
  return httpRequest(url, 'GET', options);
}

/**
 * Make a POST request with automatic retries and circuit breaker
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
