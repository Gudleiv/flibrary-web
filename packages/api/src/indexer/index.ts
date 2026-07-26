// Сборка собственного поискового индекса.
//
// Читает коллекцию батчами и складывает в app.db одну FTS-таблицу со всеми текстовыми
// полями (по основам слов + исходным формам) плюс триграммную для подстрочного поиска.
//
// Индекс собирается во временные таблицы и переключается атомарно через RENAME —
// поиск во время переиндексации продолжает работать на старом индексе.
//
// Источник и приёмник — РАЗНЫЕ соединения: читаем коллекцию через read-only соединение
// (иначе, подключив её к пишущему, мы бы сделали коллекцию изменяемой и потеряли главную
// гарантию), пишем индекс в app.db через пишущее.

import type { Database as Db } from 'better-sqlite3';
import { statSync } from 'node:fs';

import { COLLECTION as C } from '../db/index.js';
import { indexText, tokenize } from '../search/stemmer.js';

export interface IndexState {
  collection_mtime: string | null;
  collection_size: number | null;
  books_count: number | null;
  max_update_id: number | null;
  indexed_at: string | null;
}

export interface BuildOptions {
  /** Размер батча при чтении коллекции. */
  batchSize?: number;
  /** Собрать индекс заново целиком, даже если хватило бы доиндексации. */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface BuildResult {
  built: boolean;
  /** Сколько книг проиндексировано за этот заход. */
  books: number;
  tookMs: number;
  reason: string;
  /**
   * `full` — индекс собран заново, `incremental` — доиндексированы только новые книги,
   * `skipped` — коллекция не менялась.
   */
  mode: 'full' | 'incremental' | 'skipped';
}

interface SourceRow {
  bookId: number;
  title: string | null;
  authors: string | null;
  series: string | null;
  keywords: string | null;
  annotation: string | null;
}

/**
 * Текущее состояние коллекции: по нему понимаем, надо ли переиндексировать.
 * max(UpdateID) ловит доставку новых книг, число записей — удаление, mtime и размер
 * файла — пересоздание коллекции целиком.
 */
export function readCollectionFingerprint(
  read: Db,
  collectionPath: string,
): Omit<IndexState, 'indexed_at'> {
  const stats = statSync(collectionPath);
  const row = read
    .prepare(`SELECT count(*) AS books, coalesce(max(UpdateID), 0) AS maxUpdateId FROM ${C}.Books`)
    .get() as { books: number; maxUpdateId: number };

  return {
    collection_mtime: stats.mtime.toISOString(),
    collection_size: stats.size,
    books_count: row.books,
    max_update_id: row.maxUpdateId,
  };
}

export function readIndexState(db: Db): IndexState | undefined {
  return db.prepare('SELECT * FROM index_state WHERE id = 1').get() as IndexState | undefined;
}

/** Индекс собран и пригоден к использованию. */
export function isIndexReady(db: Db): boolean {
  const state = readIndexState(db);
  if (state?.indexed_at == null) return false;

  const row = db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'books_fts'")
    .get() as { n: number };
  return row.n > 0;
}

/**
 * Готовность индекса с коротким кэшем.
 *
 * Индексатор — отдельный процесс, поэтому проверять один раз на старте нельзя: после
 * первой сборки API продолжал бы искать по FTS коллекции до перезапуска. Проверять на
 * каждый запрос тоже незачем — состояние меняется раз в сутки. Отсюда TTL.
 */
export class IndexStatus {
  private cached = false;
  private checkedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  isReady(): boolean {
    const now = this.now();
    if (now - this.checkedAt < this.ttlMs) return this.cached;

    this.cached = isIndexReady(this.db);
    this.checkedAt = now;
    return this.cached;
  }

  /** Сбросить кэш — например, сразу после сборки индекса в том же процессе. */
  invalidate(): void {
    this.checkedAt = 0;
  }
}

/**
 * Источник строк индекса. `since` добавляет отсечку по UpdateID — так читается только
 * то, что приехало новой поставкой inpx (см. доиндексацию ниже).
 */
const sourceQuery = (since: boolean): string => `
  SELECT
    b.BookID AS bookId,
    b.Title  AS title,
    (SELECT group_concat(a.LastName || ' ' || coalesce(a.FirstName, '') || ' ' || coalesce(a.MiddleName, ''), ' ')
       FROM ${C}.Author_List al JOIN ${C}.Authors a ON a.AuthorID = al.AuthorID
      WHERE al.BookID = b.BookID) AS authors,
    (SELECT group_concat(s.SeriesTitle, ' ')
       FROM ${C}.Series_List sl JOIN ${C}.Series s ON s.SeriesID = sl.SeriesID
      WHERE sl.BookID = b.BookID) AS series,
    (SELECT group_concat(k.KeywordTitle, ' ')
       FROM ${C}.Keyword_List kl JOIN ${C}.Keywords k ON k.KeywordID = kl.KeywordID
      WHERE kl.BookID = b.BookID) AS keywords,
    (SELECT a.Text FROM ${C}.Annotations a WHERE a.BookID = b.BookID) AS annotation
  FROM ${C}.Books_View b
  WHERE b.BookID > ? ${since ? 'AND b.UpdateID > :since' : ''}
  ORDER BY b.BookID
  LIMIT ?
`;

const SOURCE_QUERY = sourceQuery(false);
const SOURCE_QUERY_SINCE = sourceQuery(true);

export function buildIndex(
  source: { read: Db; write: Db },
  collectionPath: string,
  options: BuildOptions = {},
): BuildResult {
  const { read, write } = source;
  const started = Date.now();
  const batchSize = options.batchSize ?? 2000;

  const fingerprint = readCollectionFingerprint(read, collectionPath);
  const previous = readIndexState(read);

  if (!options.force && previous?.indexed_at != null && isIndexReady(read)) {
    const unchanged =
      previous.books_count === fingerprint.books_count &&
      previous.max_update_id === fingerprint.max_update_id &&
      previous.collection_size === fingerprint.collection_size &&
      previous.collection_mtime === fingerprint.collection_mtime;

    if (unchanged) {
      return {
        built: false,
        books: fingerprint.books_count ?? 0,
        tookMs: Date.now() - started,
        reason: 'коллекция не менялась',
        mode: 'skipped',
      };
    }

    const since = incrementalSince(read, previous, fingerprint);
    if (since !== null) {
      return appendToIndex(source, {
        since,
        fingerprint,
        alreadyIndexed: previous.books_count ?? 0,
        batchSize,
        started,
        options,
      });
    }
  }

  // Строим во временные таблицы: старый индекс продолжает обслуживать поиск.
  write.exec('DROP TABLE IF EXISTS books_fts_new');
  write.exec('DROP TABLE IF EXISTS books_trgm_new');
  write.exec(`
    CREATE VIRTUAL TABLE books_fts_new USING fts5(
      title, authors, series, keywords, annotation,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `);
  write.exec(
    `CREATE VIRTUAL TABLE books_trgm_new USING fts5(title, authors, series, keywords, tokenize = 'trigram')`,
  );

  const insertFts = write.prepare(
    'INSERT INTO books_fts_new (rowid, title, authors, series, keywords, annotation) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertTrgm = write.prepare(
    'INSERT INTO books_trgm_new (rowid, title, authors, series, keywords) VALUES (?, ?, ?, ?, ?)',
  );
  const select = read.prepare(SOURCE_QUERY);

  const total = fingerprint.books_count ?? 0;
  let done = 0;
  let lastId = 0;

  for (;;) {
    const rows = select.all(lastId, batchSize) as SourceRow[];
    if (rows.length === 0) break;

    write.transaction((batch: SourceRow[]) => {
      for (const row of batch) insertRow(insertFts, insertTrgm, row);
    })(rows);

    done += rows.length;
    lastId = rows[rows.length - 1]?.bookId ?? lastId;
    options.onProgress?.(done, total);
  }

  write.exec("INSERT INTO books_fts_new(books_fts_new) VALUES ('optimize')");

  // Атомарное переключение.
  write.transaction(() => {
    write.exec('DROP TABLE IF EXISTS books_fts');
    write.exec('DROP TABLE IF EXISTS books_trgm');
    write.exec('ALTER TABLE books_fts_new RENAME TO books_fts');
    write.exec('ALTER TABLE books_trgm_new RENAME TO books_trgm');
    saveIndexState(write, fingerprint);
  })();

  return {
    built: true,
    books: done,
    tookMs: Date.now() - started,
    reason: previous?.indexed_at == null ? 'индекса не было' : 'коллекция изменилась',
    mode: 'full',
  };
}

/**
 * Можно ли обойтись доиндексацией — и с какого UpdateID.
 *
 * Условий два, и второе важнее первого. Новые книги приезжают поставкой inpx, у которой
 * свой UpdateID, поэтому «что добавилось» — это `UpdateID > прошлого максимума`. Но того,
 * что максимум вырос, мало: в старой части коллекции могли пропасть книги (пересоздание,
 * чистка), а их строки остались бы в индексе навсегда. Поэтому пересчитываем число книг
 * до прежней границы: совпало с тем, что было при сборке, — старая часть цела, и трогать
 * её незачем. Не совпало — собираем заново.
 *
 * Правки уже существующих книг UpdateID не меняют (его ставит импорт, а не редактирование),
 * так что доиндексация их не увидит. Это осознанная цена: инструмент от неё — `--force`.
 */
function incrementalSince(
  read: Db,
  previous: IndexState,
  fingerprint: Omit<IndexState, 'indexed_at'>,
): number | null {
  const since = previous.max_update_id;
  if (since === null || fingerprint.max_update_id === null) return null;
  if (fingerprint.max_update_id <= since) return null;

  const { books } = read
    .prepare(`SELECT count(*) AS books FROM ${C}.Books WHERE UpdateID <= ?`)
    .get(since) as { books: number };

  return books === previous.books_count ? since : null;
}

/**
 * Доиндексация: в существующий индекс дописываются только новые книги.
 *
 * Пишем прямо в рабочие таблицы, а не в `*_new`: полная сборка держит на диске два
 * индекса разом (на миллионной коллекции это гигабайты), а здесь добавляются строки —
 * поиск в это время работает и видит уже дописанное. Строки нового пакета сначала
 * удаляются: тогда прерванный на середине запуск можно просто повторить.
 */
function appendToIndex(
  source: { read: Db; write: Db },
  context: {
    since: number;
    fingerprint: Omit<IndexState, 'indexed_at'>;
    /** Сколько книг уже в индексе — нужно только для прогресса. */
    alreadyIndexed: number;
    batchSize: number;
    started: number;
    options: BuildOptions;
  },
): BuildResult {
  const { read, write } = source;
  const { since, fingerprint, alreadyIndexed, batchSize, started, options } = context;

  const insertFts = write.prepare(
    'INSERT INTO books_fts (rowid, title, authors, series, keywords, annotation) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertTrgm = write.prepare(
    'INSERT INTO books_trgm (rowid, title, authors, series, keywords) VALUES (?, ?, ?, ?, ?)',
  );
  const deleteFts = write.prepare('DELETE FROM books_fts WHERE rowid = ?');
  const deleteTrgm = write.prepare('DELETE FROM books_trgm WHERE rowid = ?');
  const select = read.prepare(SOURCE_QUERY_SINCE);

  const total = Math.max((fingerprint.books_count ?? 0) - alreadyIndexed, 0);
  let done = 0;
  let lastId = 0;

  for (;;) {
    const rows = select.all(lastId, batchSize, { since }) as SourceRow[];
    if (rows.length === 0) break;

    write.transaction((batch: SourceRow[]) => {
      for (const row of batch) {
        deleteFts.run(row.bookId);
        deleteTrgm.run(row.bookId);
        insertRow(insertFts, insertTrgm, row);
      }
    })(rows);

    done += rows.length;
    lastId = rows[rows.length - 1]?.bookId ?? lastId;
    options.onProgress?.(done, Math.max(total, done));
  }

  // 'optimize' здесь не зовём: он перестраивает индекс целиком, то есть стоит примерно
  // столько же, сколько сборка с нуля, — ровно та работа, ради отказа от которой всё это.
  saveIndexState(write, fingerprint);

  return {
    built: true,
    books: done,
    tookMs: Date.now() - started,
    reason: `доиндексация: новые поставки после UpdateID ${since}`,
    mode: 'incremental',
  };
}

function insertRow(
  insertFts: { run: (...params: unknown[]) => unknown },
  insertTrgm: { run: (...params: unknown[]) => unknown },
  row: SourceRow,
): void {
  insertFts.run(
    row.bookId,
    indexText(row.title ?? ''),
    indexText(row.authors ?? ''),
    indexText(row.series ?? ''),
    indexText(row.keywords ?? ''),
    indexText(row.annotation ?? ''),
  );

  // Для подстрок нужны исходные формы, а не основы: ищут по написанию.
  const raw = (value: string | null): string => tokenize(value ?? '').join(' ');
  insertTrgm.run(row.bookId, raw(row.title), raw(row.authors), raw(row.series), raw(row.keywords));
}

function saveIndexState(write: Db, fingerprint: Omit<IndexState, 'indexed_at'>): void {
  write
    .prepare(
      `INSERT INTO index_state (id, collection_mtime, collection_size, books_count, max_update_id, indexed_at)
       VALUES (1, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         collection_mtime = excluded.collection_mtime,
         collection_size  = excluded.collection_size,
         books_count      = excluded.books_count,
         max_update_id    = excluded.max_update_id,
         indexed_at       = excluded.indexed_at`,
    )
    .run(
      fingerprint.collection_mtime,
      fingerprint.collection_size,
      fingerprint.books_count,
      fingerprint.max_update_id,
    );
}
