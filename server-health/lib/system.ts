import { readFile } from 'node:fs/promises';

export interface LoadAverage {
  load1: number;
  load5: number;
  load15: number;
}

/**
 * Read host load average from /proc/loadavg
 * Returns the 1, 5, and 15 minute load averages
 */
export async function getLoadAverage(): Promise<LoadAverage> {
  try {
    const content = await readFile('/proc/loadavg', 'utf-8');
    const parts = content.trim().split(/\s+/);

    return {
      load1: parseFloat(parts[0] ?? '0'),
      load5: parseFloat(parts[1] ?? '0'),
      load15: parseFloat(parts[2] ?? '0'),
    };
  } catch {
    return { load1: 0, load5: 0, load15: 0 };
  }
}
