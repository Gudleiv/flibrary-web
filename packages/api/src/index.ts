// Точка входа.

import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const fastify = await buildServer(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    fastify.log.info(`${signal}: завершаюсь`);
    void fastify.close().then(() => process.exit(0));
  });
}

try {
  await fastify.listen({ host: config.host, port: config.port });
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
