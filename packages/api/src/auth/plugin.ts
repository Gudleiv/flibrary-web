// Плагин аутентификации: раскладывает пользователя в request.user и закрывает всё,
// что не помечено `config.public`.
//
// Закрыто по умолчанию — сознательно. В текущем C++-сервере FLibrary авторизация висит
// только на части путей, а JSON-API и скачивание книг открыты; повторять это не будем.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { findUserById, toPublicUser, type PublicUser } from './users.js';
import { findSession, parseCookie } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { userId: number; login: string; displayName: string };
    sessionId?: string;
  }
  interface FastifyContextConfig {
    /** Маршрут доступен без аутентификации. */
    public?: boolean;
  }
}

export interface AuthPluginOptions {
  cookieName: string;
  sessionSecret: string;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  fastify.decorateRequest('user', undefined);
  fastify.decorateRequest('sessionId', undefined);

  fastify.addHook('onRequest', async (request, reply) => {
    resolveUser(request, options);

    if (request.routeOptions.config?.public === true) return;
    if (request.user === undefined) {
      return reply.status(401).type('application/problem+json').send({
        title: 'Требуется аутентификация',
        status: 401,
      });
    }
  });
};

function resolveUser(request: FastifyRequest, options: AuthPluginOptions): void {
  const raw = request.cookies[options.cookieName];
  if (raw === undefined) return;

  const sessionId = parseCookie(raw, options.sessionSecret);
  if (sessionId === null) return;

  const session = findSession(request.server.db.read, sessionId);
  if (session === undefined) return;

  const user = findUserById(request.server.db.read, session.user_id);
  if (user === undefined) return;

  request.sessionId = sessionId;
  const publicUser: PublicUser = toPublicUser(user);
  request.user = {
    userId: user.user_id,
    login: publicUser.login,
    displayName: publicUser.displayName,
  };
}

export default fp(authPlugin, { name: 'auth', dependencies: ['@fastify/cookie'] });
