// Поиск.
//
// Валидация тела — сгенерированной из OpenAPI JSON Schema, то есть ровно тем же
// контрактом, по которому клиент строит запрос.

import { searchQuerySchema, type Facet, type SearchQuery } from '@flibrary/contract';
import type { FastifyPluginAsync } from 'fastify';

import { COLLECTION as C } from '../db/index.js';
import { displayAuthorName } from '../db/labels.js';
import {
  compileCount,
  compileFacets,
  compileSearch,
  type CompileContext,
} from '../search/compile.js';
import { encodeCursor } from '../search/cursor.js';
import { buildIndexQuery } from '../search/fts.js';
import { runFacets } from '../search/runFacets.js';
import { mapBookRow, type BookRow } from './mappers.js';
import { loadAuthors, loadGenres } from './relations.js';

const suggestSchema = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 128 },
    kind: { enum: ['author', 'series', 'keyword', 'title'], default: 'author' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  },
} as const;

type SuggestKind = 'author' | 'series' | 'keyword' | 'title';

const searchRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, config } = fastify;

  const context = (userId: number): CompileContext => ({
    userId,
    hideDeleted: config.hideDeleted,
    useIndex: fastify.searchIndex.isReady(),
  });

  /**
   * Число совпадений по фильтру целиком — за тем же кэшем, что и счётчики фасетов.
   *
   * Цифра не зависит ни от страницы, ни от сортировки, а стоит полного прохода по
   * совпавшему множеству, поэтому листание с одним и тем же фильтром считает её один раз.
   */
  const countMatches = (query: SearchQuery, userId: number): number => {
    const count = compileCount(query, context(userId));
    const key = fastify.queries.key(['total', count.sql, count.params, userId]);

    const cached = fastify.queries.get<number>(key);
    if (cached !== null) return cached;

    const { total } = db.read.prepare(count.sql).get(count.params, { userId }) as { total: number };
    fastify.queries.set(key, total);
    return total;
  };

  fastify.post<{ Body: SearchQuery }>(
    '/search',
    { schema: { body: searchQuerySchema } },
    async (request) => {
      const started = process.hrtime.bigint();
      const userId = request.user!.userId;

      const compiled = compileSearch(request.body, context(userId));

      const rows = db.read.prepare(compiled.sql).all(compiled.params, { userId }) as BookRow[];

      // total — второй полный проход по совпавшему множеству, поэтому по умолчанию его
      // здесь нет: интерфейс с номерами страниц берёт его из POST /search/facets, где он
      // считается один раз на фильтр. Флаг оставлен для клиента, которому нужен ровно
      // один запрос и не нужны счётчики.
      const total = request.body.withTotal === true ? countMatches(request.body, userId) : null;

      const last = rows.at(-1);
      const nextCursor =
        rows.length === compiled.limit && last !== undefined
          ? encodeCursor({ key: last.sortKey, bookId: last.bookId })
          : null;

      const bookIds = rows.map((row) => row.bookId);
      const authors = loadAuthors(db.read, bookIds);
      const genres = loadGenres(db.read, bookIds);

      return {
        items: rows.map((row) => ({
          ...mapBookRow(row),
          authors: authors.get(row.bookId) ?? [],
          genres: genres.get(row.bookId) ?? [],
        })),
        nextCursor,
        total,
        tookMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      };
    },
  );

  /**
   * Счётчики фасетов и общее число совпадений — отдельной операцией.
   *
   * Раньше это считалось внутри POST /search, то есть пользователь ждал панель
   * уточнения, чтобы увидеть выдачу, а каждая следующая страница пересчитывала цифры,
   * которые от страницы не зависят. Разделение снимает и то, и другое: выдача
   * возвращается сразу, а счётчики приходят своим запросом — один раз на набор фильтров.
   */
  fastify.post<{ Body: SearchQuery }>(
    '/search/facets',
    { schema: { body: searchQuerySchema } },
    async (request) => {
      const started = process.hrtime.bigint();
      const userId = request.user!.userId;

      const facets: Facet[] = runFacets(
        db.read,
        compileFacets(request.body, context(userId)),
        userId,
        fastify.queries,
      );

      return {
        total: countMatches(request.body, userId),
        facets,
        tookMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      };
    },
  );

  fastify.get<{ Querystring: { q: string; kind?: SuggestKind; limit?: number } }>(
    '/search/suggest',
    { schema: { querystring: suggestSchema } },
    async (request, reply) => {
      const { q } = request.query;
      const kind = request.query.kind ?? 'author';
      const limit = request.query.limit ?? 10;

      // Подсказки строятся по справочникам коллекции: их нормализованные поля
      // (SearchName / SearchTitle) — это uppercase, по ним же и ищем префиксом.
      const prefix = `${q.toUpperCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      const visible = config.hideDeleted ? 'AND b.IsDeleted = 0' : '';

      if (kind === 'title') {
        // Названия — не справочник, поэтому подсказки берём из поискового индекса,
        // если он собран, и из FTS коллекции, если ещё нет.
        if (fastify.searchIndex.isReady()) {
          const query = buildIndexQuery(q, 'prefix', 'title');
          if (query === null) return { items: [] };

          const rows = db.read
            .prepare(
              `SELECT b.BookID AS id, b.Title AS label
                 FROM books_fts
                 JOIN ${C}.Books_View b ON b.BookID = books_fts.rowid
                WHERE books_fts MATCH ? ${visible}
                ORDER BY bm25(books_fts, 10.0, 8.0, 4.0, 2.0, 1.0)
                LIMIT ?`,
            )
            .all(query, limit) as Array<{ id: number; label: string }>;

          return {
            items: rows.map((row) => ({ kind, id: row.id, label: row.label, books: null })),
          };
        }

        const rows = db.read
          .prepare(
            `SELECT b.BookID AS id, b.Title AS label
               FROM ${C}.Books_View b
              WHERE b.SearchTitle LIKE ? ESCAPE '\\' ${visible}
              ORDER BY b.SearchTitle
              LIMIT ?`,
          )
          .all(prefix, limit) as Array<{ id: number; label: string }>;

        return { items: rows.map((row) => ({ kind, id: row.id, label: row.label, books: null })) };
      }

      const queries: Record<Exclude<SuggestKind, 'title'>, string> = {
        author: `SELECT a.AuthorID AS id,
                        trim(a.LastName || ' ' || coalesce(a.FirstName, '') || ' ' || coalesce(a.MiddleName, '')) AS label,
                        count(DISTINCT al.BookID) AS books
                   FROM ${C}.Authors a
                   JOIN ${C}.Author_List al ON al.AuthorID = a.AuthorID
                   JOIN ${C}.Books_View b ON b.BookID = al.BookID
                  WHERE a.SearchName LIKE ? ESCAPE '\\' ${visible}
                  GROUP BY a.AuthorID
                  ORDER BY books DESC
                  LIMIT ?`,
        series: `SELECT s.SeriesID AS id, s.SeriesTitle AS label, count(DISTINCT sl.BookID) AS books
                   FROM ${C}.Series s
                   JOIN ${C}.Series_List sl ON sl.SeriesID = s.SeriesID
                   JOIN ${C}.Books_View b ON b.BookID = sl.BookID
                  WHERE s.SearchTitle LIKE ? ESCAPE '\\' ${visible}
                  GROUP BY s.SeriesID
                  ORDER BY books DESC
                  LIMIT ?`,
        keyword: `SELECT k.KeywordID AS id, k.KeywordTitle AS label, count(DISTINCT kl.BookID) AS books
                    FROM ${C}.Keywords k
                    JOIN ${C}.Keyword_List kl ON kl.KeywordID = k.KeywordID
                    JOIN ${C}.Books_View b ON b.BookID = kl.BookID
                   WHERE k.SearchTitle LIKE ? ESCAPE '\\' ${visible}
                   GROUP BY k.KeywordID
                   ORDER BY books DESC
                   LIMIT ?`,
      };

      const rows = db.read.prepare(queries[kind]).all(prefix, limit) as Array<{
        id: number;
        label: string;
        books: number;
      }>;

      return reply.send({
        items: rows.map((row) => ({
          kind,
          id: row.id,
          label: kind === 'author' ? displayAuthorName(row.label) : row.label,
          books: row.books,
        })),
      });
    },
  );
};

export default searchRoutes;
