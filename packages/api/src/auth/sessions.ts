// Сессии в app.db.
//
// Почему не чистый HTTP Basic для SPA: Basic шлёт пароль в каждом запросе, не имеет
// выхода и плохо живёт с клиентским роутингом. Поэтому вход один раз → httpOnly-кука.
// Для OPDS-читалок Basic остаётся — но его обслуживает C++-сервер, а не мы.
//
// В куку кладём id сессии и HMAC от него: подпись позволяет отбросить мусор и подбор
// до обращения к БД.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';

export interface SessionRow {
  session_id: string;
  user_id: number;
  expires_at: string;
}

const SEPARATOR = '.';

const sign = (sessionId: string, secret: string): string =>
  createHmac('sha256', secret).update(sessionId).digest('base64url');

export function createSession(
  db: Db,
  userId: number,
  secret: string,
  ttlDays: number,
  userAgent?: string,
): string {
  const sessionId = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO sessions (session_id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
  ).run(sessionId, userId, expiresAt, userAgent ?? null);

  return `${sessionId}${SEPARATOR}${sign(sessionId, secret)}`;
}

/** Разбирает значение куки и сверяет подпись. */
export function parseCookie(value: string, secret: string): string | null {
  const separatorIndex = value.lastIndexOf(SEPARATOR);
  if (separatorIndex <= 0) return null;

  const sessionId = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expected = sign(sessionId, secret);

  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(received, expectedBuffer)) return null;

  return sessionId;
}

export function findSession(db: Db, sessionId: string): SessionRow | undefined {
  return db
    .prepare("SELECT * FROM sessions WHERE session_id = ? AND expires_at > datetime('now')")
    .get(sessionId) as SessionRow | undefined;
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
}

export function deleteExpiredSessions(db: Db): number {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}
