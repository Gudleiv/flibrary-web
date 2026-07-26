// Карточка книги и бинарные ручки.
//
// Обложки и файлы книг мы не извлекаем сами: за этим стоит C++-сервер FLibrary, который
// уже умеет zip/7z, fb2 с восстановлением картинок, mobi/djvu/pdf и внешние конвертеры.

import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { COLLECTION as C } from '../db/index.js';
import { ContentServiceUnavailableError, type BookFormat } from '../content/opds.js';
import type { CoverSize } from '../cache/covers.js';
import { mapBookRow, type BookRow } from './mappers.js';
import { loadAuthors, loadGenres, loadKeywords } from './relations.js';

const bookIdParams = {
  type: 'object',
  required: ['bookId'],
  properties: { bookId: { type: 'integer', minimum: 1 } },
} as const;

interface DetailRow extends BookRow {
  annotation: string | null;
  archive: string | null;
  fileName: string | null;
  updateDate: string | null;
  isDeleted: number;
}

const bookRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, config, content, covers } = fastify;

  fastify.get<{ Params: { bookId: number } }>(
    '/books/:bookId',
    { schema: { params: bookIdParams } },
    async (request, reply) => {
      const userId = request.user!.userId;
      const { bookId } = request.params;

      const row = db.read
        .prepare(
          `SELECT
             b.BookID      AS bookId,
             b.Title       AS title,
             b.Year        AS year,
             b.Lang        AS lang,
             b.Ext         AS ext,
             b.BookSize    AS size,
             b.LibRate     AS libRate,
             b.IsDeleted   AS isDeleted,
             b.UpdateDate  AS updateDate,
             b.FileName    AS fileName,
             f.FolderTitle AS archive,
             s.SeriesID    AS seriesId,
             s.SeriesTitle AS seriesTitle,
             sl.SeqNumber  AS seqNumber,
             a.Text        AS annotation,
             '' AS sortKey,
             (SELECT rate     FROM book_user_data WHERE user_id = :userId AND book_id = b.BookID) AS userRate,
             (SELECT favorite FROM book_user_data WHERE user_id = :userId AND book_id = b.BookID) AS favorite,
             (SELECT read     FROM book_user_data WHERE user_id = :userId AND book_id = b.BookID) AS isRead
           FROM ${C}.Books_View b
           LEFT JOIN ${C}.Folders f ON f.FolderID = b.FolderID
           LEFT JOIN ${C}.Series_List sl ON sl.BookID = b.BookID AND sl.OrdNum = 0
           LEFT JOIN ${C}.Series s ON s.SeriesID = sl.SeriesID
           LEFT JOIN ${C}.Annotations a ON a.BookID = b.BookID
          WHERE b.BookID = ?`,
        )
        .get([bookId], { userId }) as DetailRow | undefined;

      if (row === undefined || (config.hideDeleted && row.isDeleted === 1)) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send({ title: 'Книга не найдена', status: 404 });
      }

      const authors = loadAuthors(db.read, [bookId]).get(bookId) ?? [];
      const genres = loadGenres(db.read, [bookId]).get(bookId) ?? [];

      return {
        ...mapBookRow(row),
        authors,
        genres,
        annotation: row.annotation,
        keywords: loadKeywords(db.read, bookId),
        archive: row.archive,
        fileName: row.fileName,
        updateDate: row.updateDate,
        // Исходный формат всегда доступен; epub/mobi зависят от конвертеров,
        // настроенных в FLibrary, — их список отдаёт /collection.
        formats: [row.ext?.replace(/^\./, '') ?? 'fb2', 'zip'],
        seriesBooks: [],
      };
    },
  );

  fastify.get<{ Params: { bookId: number }; Querystring: { size?: CoverSize } }>(
    '/books/:bookId/cover',
    {
      schema: {
        params: bookIdParams,
        querystring: {
          type: 'object',
          properties: { size: { enum: ['thumb', 'full'] } },
        },
      },
    },
    async (request, reply) => {
      const { bookId } = request.params;
      const size = request.query.size ?? 'thumb';

      const cached = await covers.get(bookId, size);
      if (cached === 'missing') return sendNoCover(reply);
      if (cached !== null)
        return sendCover(
          reply,
          cached.body,
          cached.contentType,
          cached.etag,
          request.headers['if-none-match'],
        );

      let response;
      try {
        response = await content.cover(bookId);
      } catch (error) {
        if (error instanceof ContentServiceUnavailableError) {
          return reply.status(502).type('application/problem+json').send({
            title: 'Content-service недоступен',
            status: 502,
            detail: 'Не удалось получить обложку от внутреннего сервера FLibrary',
          });
        }
        throw error;
      }

      if (response.status !== 200) {
        await covers.putMissing(bookId, size);
        return sendNoCover(reply);
      }

      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      if (body.length === 0) {
        await covers.putMissing(bookId, size);
        return sendNoCover(reply);
      }

      // TODO: ресайз до thumb и пережатие в webp; пока кладём как есть.
      const stored = await covers.put(bookId, size, body);
      return sendCover(
        reply,
        stored.body,
        stored.contentType,
        stored.etag,
        request.headers['if-none-match'],
      );
    },
  );

  fastify.get<{ Params: { bookId: number }; Querystring: { format?: BookFormat } }>(
    '/books/:bookId/content',
    {
      schema: {
        params: bookIdParams,
        querystring: {
          type: 'object',
          properties: { format: { enum: ['original', 'fb2', 'zip', 'epub', 'mobi'] } },
        },
      },
    },
    async (request, reply) => {
      const { bookId } = request.params;
      const format = request.query.format ?? 'original';

      const exists = db.read
        .prepare(`SELECT IsDeleted AS isDeleted FROM ${C}.Books_View WHERE BookID = ?`)
        .get(bookId) as { isDeleted: number } | undefined;

      if (exists === undefined || (config.hideDeleted && exists.isDeleted === 1)) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send({ title: 'Книга не найдена', status: 404 });
      }

      try {
        const response = await content.book(bookId, format);
        if (response.status !== 200) {
          return reply
            .status(502)
            .type('application/problem+json')
            .send({
              title: 'Не удалось получить файл книги',
              status: 502,
              detail: `Content-service ответил ${response.status}`,
            });
        }

        // Стримим как есть: книга может быть большой, буферизовать её незачем.
        for (const header of ['content-type', 'content-length'] as const) {
          const value = response.headers[header];
          if (value !== undefined) reply.header(header, value);
        }
        const disposition = normalizeDisposition(response.headers['content-disposition'], bookId);
        if (disposition !== undefined) reply.header('content-disposition', disposition);
        return reply.send(response.body);
      } catch (error) {
        if (error instanceof ContentServiceUnavailableError) {
          return reply.status(502).type('application/problem+json').send({
            title: 'Content-service недоступен',
            status: 502,
          });
        }
        throw error;
      }
    },
  );
};

const FILENAME = /filename="([^"]*)"/i;

/**
 * C++-сервер кладёт имя файла в `filename="..."` percent-кодированным
 * (`filename="%D0%91%D0%B5%D1%80%D0%B5%D0%B3.fb2"`). Расшифровать такое — эвристика
 * Chromium, а не требование RFC 6266: стандартный способ передать не-ASCII имя — параметр
 * `filename*` (RFC 5987), и полагаться на то, что каждый браузер угадает, не стоит.
 *
 * Percent-кодированный UTF-8 — ровно то, что нужно `filename*`, так что имя перекладывается
 * туда, а в `filename` остаётся ASCII-фолбэк.
 */
function normalizeDisposition(
  raw: string | string[] | undefined,
  bookId: number,
): string | undefined {
  if (typeof raw !== 'string') return undefined;

  const encoded = FILENAME.exec(raw)?.[1];
  if (encoded === undefined) return raw;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // Не percent-кодированное имя (или битое) — не наше дело его исправлять.
    return raw;
  }
  if (decoded === encoded) return raw;

  const extension = /\.[A-Za-z0-9.]+$/.exec(decoded)?.[0] ?? '';
  return `attachment; filename="book-${bookId}${extension}"; filename*=UTF-8''${encodeRfc5987(decoded)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sendCover(
  reply: FastifyReply,
  body: Buffer,
  contentType: string,
  etag: string,
  ifNoneMatch: string | undefined,
): FastifyReply {
  if (ifNoneMatch === etag) return reply.status(304).send();

  return (
    reply
      .header('content-type', contentType)
      .header('etag', etag)
      // Обложка книги не меняется, поэтому кэшируем агрессивно.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(body)
  );
}

function sendNoCover(reply: FastifyReply): FastifyReply {
  return reply
    .status(404)
    .type('application/problem+json')
    .header('cache-control', 'private, max-age=86400')
    .send({ title: 'У книги нет обложки', status: 404 });
}

export default bookRoutes;
