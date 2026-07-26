// Пользователи. Регистрации нет: аккаунты создаёт администратор командой
//   pnpm --filter @flibrary/api users add <логин> <пароль> [имя]
// Пароли — argon2id (не bcrypt: длина пароля не ограничена 72 байтами и параметры
// стойкости настраиваются явно).

import { hash, verify } from '@node-rs/argon2';
import type { Database as Db } from 'better-sqlite3';

export interface UserRow {
  user_id: number;
  login: string;
  display_name: string;
  password_hash: string;
  is_active: number;
}

export interface PublicUser {
  login: string;
  displayName: string;
}

const ARGON2_OPTIONS = {
  // Ориентир OWASP: 19 МиБ памяти, 2 итерации, параллелизм 1.
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Битый или чужого формата хеш — это неуспешная проверка, а не 500.
    return false;
  }
}

export const toPublicUser = (row: UserRow): PublicUser => ({
  login: row.login,
  displayName: row.display_name,
});

export function findUserByLogin(db: Db, login: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE login = ? AND is_active = 1').get(login) as
    UserRow | undefined;
}

export function findUserById(db: Db, userId: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE user_id = ? AND is_active = 1').get(userId) as
    UserRow | undefined;
}

export async function createUser(
  db: Db,
  login: string,
  password: string,
  displayName?: string,
): Promise<number> {
  const passwordHash = await hashPassword(password);
  const result = db
    .prepare('INSERT INTO users (login, display_name, password_hash) VALUES (?, ?, ?)')
    .run(login, displayName ?? login, passwordHash);
  return Number(result.lastInsertRowid);
}

export async function setPassword(db: Db, login: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  const result = db
    .prepare('UPDATE users SET password_hash = ? WHERE login = ?')
    .run(passwordHash, login);
  return result.changes > 0;
}

export function listUsers(db: Db): Array<Pick<UserRow, 'login' | 'display_name' | 'is_active'>> {
  return db
    .prepare('SELECT login, display_name, is_active FROM users ORDER BY login')
    .all() as Array<Pick<UserRow, 'login' | 'display_name' | 'is_active'>>;
}

export function setActive(db: Db, login: string, active: boolean): boolean {
  const result = db
    .prepare('UPDATE users SET is_active = ? WHERE login = ?')
    .run(active ? 1 : 0, login);
  return result.changes > 0;
}
