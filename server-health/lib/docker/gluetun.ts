import { readFile, watch as fsWatch } from 'node:fs';
import { promisify } from 'node:util';

import { dockerLogger } from './client';

const readFileAsync = promisify(readFile);
const GLUETUN_PORT_FILE = '/tmp/gluetun/forwarded_port';
let cachedForwardedPort = '';

async function readGluetunPort() {
  try {
    const content = await readFileAsync(GLUETUN_PORT_FILE, 'utf-8');
    const port = content.trim();

    if (/^\d+$/.test(port)) {
      cachedForwardedPort = port;
      dockerLogger.info({ port }, 'Gluetun forwarded port updated');
    } else {
      cachedForwardedPort = '';
      dockerLogger.warn('Gluetun forwarded port file contains invalid data');
    }
  } catch {
    cachedForwardedPort = '';
  }
}

export async function watchGluetunPort() {
  dockerLogger.info('Setting up Gluetun forwarded port watcher');
  await readGluetunPort();

  try {
    const watcher = fsWatch(GLUETUN_PORT_FILE, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        void readGluetunPort();
      }
    });

    watcher.on('error', (error) => {
      dockerLogger.error({ err: error, file: GLUETUN_PORT_FILE }, 'Error watching file');
    });
  } catch (error) {
    dockerLogger.error({ err: error, file: GLUETUN_PORT_FILE }, 'Failed to watch file');
  }
}

export function getCachedGluetunPort() {
  return cachedForwardedPort;
}
