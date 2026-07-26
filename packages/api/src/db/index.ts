// Доступ к БД.
//
// Два соединения:
//   write — app.db на запись (миграции, сессии, пользовательские данные);
//   read  — app.db открыт READONLY, коллекция подключена через ATTACH.
//
// Почему так: SQLITE_OPEN_READONLY действует на всё соединение, включая присоединённые
// файлы, поэтому коллекцию физически невозможно испортить (проверено: любая запись в
// coll.* падает с "attempt to write a readonly database"). При этом JOIN между нашими
// таблицами и коллекционными остаётся одним SQL-запросом.
//
// URI-имена (`file:...?mode=ro`) в better-sqlite3 не включены, так что per-attach
// read-only через них не получить — отсюда и разделение соединений.

import Database, { type Database as Db } from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Config } from '../config.js';
import { runMigrations } from './migrations.js';

/** Префикс присоединённой коллекции в SQL. */
export const COLLECTION = 'coll';

/** Версия схемы коллекции, на которую рассчитан код (FlibraryDatabaseVersionNumber). */
export const SUPPORTED_COLLECTION_VERSION = 13;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export interface DbHandle {
  /** Только чтение: коллекция + наши таблицы. Здесь живут поиск и выдача. */
  read: Db;
  /** Только запись в app.db: сессии, пользователи, пользовательские данные. */
  write: Db;
  collectionVersion: number;
  close(): void;
}

export function openDatabase(config: Config, log: Logger): DbHandle {
  if (!existsSync(config.collectionDb)) {
    throw new Error(
      `Коллекция не найдена: ${config.collectionDb}. Для разработки сгенерируйте фикстуры: pnpm fixtures`,
    );
  }

  mkdirSync(dirname(config.appDb), { recursive: true });

  const write = new Database(config.appDb);
  write.pragma('journal_mode = WAL');
  write.pragma('foreign_keys = ON');
  write.pragma('busy_timeout = 5000');

  const applied = runMigrations(write);
  if (applied.length > 0) log.info(`app.db: применены миграции ${applied.join(', ')}`);

  const read = new Database(config.appDb, { readonly: true });
  read.pragma('busy_timeout = 5000');
  read.prepare(`ATTACH DATABASE ? AS ${COLLECTION}`).run(config.collectionDb);
  tuneReadConnection(read);

  const collectionVersion = readCollectionVersion(read);
  if (collectionVersion !== SUPPORTED_COLLECTION_VERSION) {
    log.warn(
      `Версия схемы коллекции ${collectionVersion}, код рассчитан на ${SUPPORTED_COLLECTION_VERSION}. ` +
        'Проверьте выдачу: FLibrary мог изменить схему.',
    );
  }

  log.info(`Коллекция: ${config.collectionDb} (версия схемы ${collectionVersion})`);

  return {
    read,
    write,
    collectionVersion,
    close: () => {
      read.close();
      write.close();
    },
  };
}

/**
 * Настройка соединения, на котором живёт поиск.
 *
 * Дефолтные 2 МБ страничного кэша рассчитаны на маленькую базу; у нас на этом
 * соединении лежит коллекция в гигабайты, и каждый джойн со справочниками (авторы,
 * серии, жанры) начинается с промаха. 64 МиБ — размен памяти на CPU в нужную сторону:
 * при argon2, которому на каждый вход отдаётся 19 МиБ, это не та статья расхода.
 *
 * cache_size задаётся отдельно для каждой схемы: у присоединённой коллекции свой
 * пейджер и свой кэш, и без явной строки для неё правка не даёт ничего.
 *
 * temp_store — ради фасетов: они материализуют совпавшее множество во временную
 * таблицу (см. search/runFacets.ts), а по умолчанию SQLite кладёт её на диск.
 *
 * mmap_size сознательно не трогаем: выигрыш он даёт на локальном томе, а коллекция
 * в проде обычно лежит на SMB-шаре, где случайные чтения и так больное место
 * (см. docs/deploy.md).
 */
function tuneReadConnection(read: Db): void {
  const CACHE_KIB = 64 * 1024;
  read.pragma(`cache_size = -${CACHE_KIB}`);
  read.pragma(`${COLLECTION}.cache_size = -${CACHE_KIB}`);
  read.pragma('temp_store = MEMORY');
}

/** Версия схемы лежит в Settings под SettingID = 0 (IDatabaseUser::Key::DatabaseVersion). */
function readCollectionVersion(db: Db): number {
  try {
    const row = db
      .prepare(`SELECT SettingValue AS value FROM ${COLLECTION}.Settings WHERE SettingID = 0`)
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : -1;
  } catch {
    return -1;
  }
}
