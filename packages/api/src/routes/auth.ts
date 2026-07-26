// Вход, выход, текущий пользователь.

import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';

import { createSession, deleteSession } from '../auth/sessions.js';
import { findUserByLogin, hashPassword, toPublicUser, verifyPassword } from '../auth/users.js';

const loginSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['login', 'password'],
  properties: {
    login: { type: 'string', minLength: 1, maxLength: 64 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

/**
 * Хеш от случайного значения: если логина нет, всё равно проверяем пароль, иначе по
 * времени ответа видно, какие логины существуют. Считается один раз при старте.
 */
const dummyHash = hashPassword(randomBytes(16).toString('hex'));

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, db } = fastify;

  fastify.post<{ Body: { login: string; password: string } }>(
    '/auth/login',
    {
      schema: { body: loginSchema },
      config: {
        public: true,
        // Логин открыт без аутентификации — ограничиваем подбор пароля по IP.
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { login, password } = request.body;
      const user = findUserByLogin(db.read, login);
      const ok = await verifyPassword(user?.password_hash ?? (await dummyHash), password);

      if (!user || !ok) {
        request.log.warn({ login, ip: request.ip }, 'неудачная попытка входа');
        return reply
          .status(401)
          .type('application/problem+json')
          .send({ title: 'Неверный логин или пароль', status: 401 });
      }

      const cookieValue = createSession(
        db.write,
        user.user_id,
        config.sessionSecret,
        config.sessionTtlDays,
        request.headers['user-agent'],
      );

      return reply
        .setCookie(config.cookieName, cookieValue, {
          path: '/',
          httpOnly: true,
          secure: config.cookieSecure,
          sameSite: 'lax',
          maxAge: config.sessionTtlDays * 24 * 60 * 60,
        })
        .send(toPublicUser(user));
    },
  );

  fastify.post('/auth/logout', { config: { public: true } }, async (request, reply) => {
    if (request.sessionId !== undefined) deleteSession(db.write, request.sessionId);
    return reply.clearCookie(config.cookieName, { path: '/' }).status(204).send();
  });

  fastify.get('/me', async (request) => ({
    login: request.user!.login,
    displayName: request.user!.displayName,
  }));
};

export default authRoutes;
