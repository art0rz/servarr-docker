import Docker from 'dockerode';

import { logger } from '../logger';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });
export const dockerLogger = logger.child({ component: 'docker' });
