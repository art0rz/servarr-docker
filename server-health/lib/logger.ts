import pino from 'pino';

const isProduction = process.env['NODE_ENV'] === 'production';

export const logger = isProduction
  ? pino({
      level: process.env['LOG_LEVEL'] ?? 'info',
    })
  : pino({
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
