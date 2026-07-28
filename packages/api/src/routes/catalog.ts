// Справочники коллекции: сведения о ней, дерево жанров, языки.
//
// Данные меняются только при обновлении коллекции, поэтому их не грех кэшировать
// на клиенте надолго.

import type { Genre } from '@flibrary/contract';
import type { FastifyPluginAsync } from 'fastify';

import { COLLECTION as C } from '../db/index.js';
import { displayAuthorName, GENRE_LABEL } from '../db/labels.js';
import { buildFtsQuery, buildLikePattern } from '../search/fts.js';

interface GenreRow {
  code: string;
  parentCode: string | null;
  title: string | null;
  books: number;
  ownBooks: number;
}

const authorsSchema = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 128 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    offset: { type: 'integer', minimum: 0, maximum: 5_000_000, default: 0 },
  },
} as const;

const catalogRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, config } = fastify;

  const visible = config.hideDeleted ? 'WHERE b.IsDeleted = 0' : '';
  /** То же условие, но довеском к уже существующему ON/WHERE. */
  const visibleBook = config.hideDeleted ? 'AND b.IsDeleted = 0' : '';

  fastify.get('/collection', async () => {
    const counts = db.read
      .prepare(
        `SELECT
           (SELECT count(*) FROM ${C}.Books_View b ${visible})           AS books,
           (SELECT count(*) FROM ${C}.Authors)                           AS authors,
           (SELECT count(*) FROM ${C}.Series)                            AS series`,
      )
      .get() as { books: number; authors: number; series: number };

    const languages = (
      db.read
        .prepare(
          `SELECT DISTINCT Lang AS code FROM ${C}.Books WHERE Lang IS NOT NULL ORDER BY Lang`,
        )
        .all() as Array<{ code: string }>
    ).map((row) => row.code);

    const years = db.read
      .prepare(
        // Year в коллекции бывает нулевым и заведомо мусорным (0, 1, 9999) — такое
        // в границы фильтра пускать нельзя, иначе ползунок растянется на всю ось.
        `SELECT min(b.Year) AS yearMin, max(b.Year) AS yearMax
           FROM ${C}.Books_View b
          WHERE b.Year BETWEEN 1400 AND 2200 ${config.hideDeleted ? 'AND b.IsDeleted = 0' : ''}`,
      )
      .get() as { yearMin: number | null; yearMax: number | null };

    // Аннотации в коллекции опциональны: inpx импортируют и без них. Ноль здесь —
    // не ошибка, а то, что клиенту нужно знать, чтобы не выдавать «у книги нет
    // аннотации» на каждой книге и не показывать поиск по аннотации как рабочий.
    const { annotations } = db.read
      .prepare(`SELECT count(*) AS annotations FROM ${C}.Annotations`)
      .get() as { annotations: number };

    const indexState = db.read
      .prepare('SELECT indexed_at AS indexedAt FROM index_state WHERE id = 1')
      .get() as { indexedAt: string | null } | undefined;

    return {
      // Имя коллекции живёт в настройках FLibrary (QSettings), а не в БД, поэтому
      // до появления его передачи показываем имя файла.
      name: config.collectionDb.split('/').pop() ?? 'collection',
      books: counts.books,
      authors: counts.authors,
      series: counts.series,
      languages,
      yearMin: years.yearMin,
      yearMax: years.yearMax,
      annotations,
      indexedAt: indexState?.indexedAt ?? null,
    };
  });

  fastify.get('/genres', async () => {
    const rows = db.read
      .prepare(
        // Счётчик считается ПО ПОДДЕРЕВУ. Книге проставляют листовые жанры («Киберпанк»),
        // а не корневые («Фантастика»), поэтому подсчёт по прямым связям давал у всех
        // корней ноль — жанр с тысячей книг выглядел пустым.
        //
        // Рекурсивный CTE разворачивает дерево в пары «корень поддерева → потомок»;
        // справочник жанров — сотни строк, так что разворот дешёвый.
        //
        // count(DISTINCT) обязателен: книге ставят несколько жанров, и у книги с
        // «Киберпанком» и «Фэнтези» корень «Фантастика» иначе посчитался бы дважды.
        //
        // ParentCode у корневых жанров — пустая строка, а не NULL; наружу «родителя нет»
        // отдаём как null, иначе клиенту пришлось бы знать про эту особенность.
        `WITH RECURSIVE subtree (root, code) AS (
             SELECT GenreCode, GenreCode FROM ${C}.Genres WHERE IsDeleted = 0
           UNION ALL
             SELECT s.root, g.GenreCode
               FROM ${C}.Genres g
               JOIN subtree s ON g.ParentCode = s.code
              WHERE g.IsDeleted = 0
         ),
         counts AS (
           SELECT s.root AS code,
                  count(DISTINCT gl.BookID)                                    AS books,
                  count(DISTINCT CASE WHEN s.root = s.code THEN gl.BookID END) AS ownBooks
             FROM subtree s
             JOIN ${C}.Genre_List gl ON gl.GenreCode = s.code
             JOIN ${C}.Books_View b ON b.BookID = gl.BookID ${visibleBook}
            GROUP BY s.root
         )
         SELECT g.GenreCode AS code, nullif(g.ParentCode, '') AS parentCode,
                ${GENRE_LABEL} AS title,
                coalesce(c.books, 0)    AS books,
                coalesce(c.ownBooks, 0) AS ownBooks
           FROM ${C}.Genres g
           LEFT JOIN counts c ON c.code = g.GenreCode
          WHERE g.IsDeleted = 0
          ORDER BY ${GENRE_LABEL}`,
      )
      .all() as GenreRow[];

    return { items: buildGenreTree(rows) };
  });

  /**
   * Алфавитный список авторов для раздела «Авторы».
   *
   * Не то же самое, что `/search/suggest?kind=author`: там топ-N по числу книг для
   * автодополнения, здесь — страница списка и общее число, по которому рисуется пагинация.
   */
  fastify.get<{ Querystring: { q?: string; limit?: number; offset?: number } }>(
    '/authors',
    { schema: { querystring: authorsSchema } },
    async (request) => {
      const { q } = request.query;
      const limit = request.query.limit ?? 50;
      const offset = request.query.offset ?? 0;

      // Ищем двумя способами сразу, потому что поодиночке ни один не покрывает того,
      // что от списка ждут.
      //
      // `SearchName` — это uppercase ФАМИЛИИ и только её (`inpx.cpp::Store` кладёт туда
      // `last.toUpper()`), поэтому по нему находится «оулинг» в середине фамилии, но
      // никогда — имя или отчество. Отсюда второй способ: FTS-таблица `Authors_Search`
      // коллекции построена по всем трём частям имени, и её токенайзер, в отличие от
      // SQLite-функции upper(), знает про кириллицу — «джоан» там найдёт «Джоан».
      //
      // Наоборот тоже: FTS ищет по началу слова, серединой слова в неё не попасть.
      // Вместе получается «с любого места фамилии или с начала любой части имени».
      const raw = q?.trim() ?? '';
      // Спецсимволы LIKE экранируются внутри buildLikePattern: '%' во вводе иначе
      // означал бы «любой остаток».
      const like = raw === '' ? null : buildLikePattern(raw, 'substring');
      // null бывает на вводе из одних кавычек: искать после очистки нечего.
      const fts = raw === '' ? null : buildFtsQuery(raw, 'prefix');
      // Префикс фамилии — не фильтр, а порядок: раньше список искал именно так, и
      // «Роулинг» по запросу «роулинг» должна остаться первой, а не потеряться среди
      // однофамильцев по середине строки.
      const prefix = raw === '' ? null : buildLikePattern(raw, 'prefix');

      const match =
        like === null
          ? null
          : [
              "a.SearchName LIKE :like ESCAPE '\\'",
              // MATCH требует неквалифицированное имя таблицы и не работает с алиасом.
              fts === null
                ? null
                : `a.AuthorID IN (SELECT rowid FROM ${C}.Authors_Search WHERE Authors_Search MATCH :fts)`,
            ]
              .filter((part) => part !== null)
              .join(' OR ');

      const where = [
        // Справочник авторов коллекции содержит записи, не связанные ни с одной книгой:
        // в списке они выглядели бы как авторы без единой книги.
        `EXISTS (SELECT 1 FROM ${C}.Author_List al2 WHERE al2.AuthorID = a.AuthorID)`,
        match === null ? null : `(${match})`,
      ]
        .filter((part) => part !== null)
        .join(' AND ');

      const order =
        prefix === null
          ? 'a.SearchName, a.AuthorID'
          : `CASE WHEN a.SearchName LIKE :prefix ESCAPE '\\' THEN 0 ELSE 1 END,
             a.SearchName, a.AuthorID`;

      const { total } = db.read
        .prepare(`SELECT count(*) AS total FROM ${C}.Authors a WHERE ${where}`)
        .get({ like, fts }) as { total: number };

      const rows = db.read
        .prepare(
          `SELECT a.AuthorID AS authorId,
                  trim(coalesce(a.LastName, '') || ' ' || coalesce(a.FirstName, '')
                       || ' ' || coalesce(a.MiddleName, '')) AS name,
                  (SELECT count(*) FROM ${C}.Author_List al
                     JOIN ${C}.Books_View b ON b.BookID = al.BookID ${visibleBook}
                    WHERE al.AuthorID = a.AuthorID) AS books
             FROM ${C}.Authors a
            WHERE ${where}
            ORDER BY ${order}
            LIMIT :limit OFFSET :offset`,
        )
        .all({ like, fts, prefix, limit, offset }) as Array<{
        authorId: number;
        name: string;
        books: number;
      }>;

      return {
        items: rows.map((row) => ({ ...row, name: displayAuthorName(row.name) })),
        total,
      };
    },
  );

  fastify.get('/languages', async () => {
    const rows = db.read
      .prepare(
        `SELECT b.Lang AS code, count(*) AS books
           FROM ${C}.Books_View b
          WHERE b.Lang IS NOT NULL ${config.hideDeleted ? 'AND b.IsDeleted = 0' : ''}
          GROUP BY b.Lang
          ORDER BY books DESC`,
      )
      .all() as Array<{ code: string; books: number }>;

    return { items: rows };
  });
};

/** Плоский список с ParentCode → дерево. */
export function buildGenreTree(rows: GenreRow[]): Genre[] {
  const nodes = new Map<string, Genre>(
    rows.map((row) => [
      row.code,
      {
        code: row.code,
        parentCode: row.parentCode,
        title: row.title ?? row.code,
        books: row.books,
        ownBooks: row.ownBooks,
        children: [],
      },
    ]),
  );

  const roots: Genre[] = [];
  for (const row of rows) {
    const node = nodes.get(row.code);
    if (node === undefined) continue;

    const parent = row.parentCode === null ? undefined : nodes.get(row.parentCode);
    // Жанр, чей родитель отсутствует в справочнике, показываем как корневой —
    // иначе он просто исчезнет из выдачи.
    if (parent === undefined) roots.push(node);
    else (parent.children ??= []).push(node);
  }

  return roots;
}

export default catalogRoutes;
