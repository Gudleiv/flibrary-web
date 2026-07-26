// Health-проба: без аутентификации, но и без чувствительных подробностей.

import type { FastifyPluginAsync } from 'fastify';

import { COLLECTION, SUPPORTED_COLLECTION_VERSION } from '../db/index.js';

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', { config: { public: true } }, async () => {
    const row = fastify.db.read
      .prepare(`SELECT count(*) AS books FROM ${COLLECTION}.Books`)
      .get() as { books: number };

    return {
      status: 'ok',
      collection: {
        books: row.books,
        schemaVersion: fastify.db.collectionVersion,
        supportedSchemaVersion: SUPPORTED_COLLECTION_VERSION,
      },
    };
  });
};

export default healthRoutes;
