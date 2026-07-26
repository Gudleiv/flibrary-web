// Справочники коллекции: сведения о ней, дерево жанров, языки.
//
// Данные меняются только при обновлении коллекции, поэтому их не грех кэшировать
// на клиенте надолго.

import type { Genre } from '@flibrary/contract';
import type { FastifyPluginAsync } from 'fastify';

import { COLLECTION as C } from '../db/index.js';
import { GENRE_LABEL } from '../db/labels.js';

interface GenreRow {
  code: string;
  parentCode: string | null;
  title: string | null;
  books: number;
}

const catalogRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, config } = fastify;

  const visible = config.hideDeleted ? 'WHERE b.IsDeleted = 0' : '';

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
      indexedAt: indexState?.indexedAt ?? null,
    };
  });

  fastify.get('/genres', async () => {
    const rows = db.read
      .prepare(
        // ParentCode у корневых жанров — пустая строка, а не NULL; наружу «родителя нет»
        // отдаём как null, иначе клиенту пришлось бы знать про эту особенность.
        `SELECT g.GenreCode AS code, nullif(g.ParentCode, '') AS parentCode,
                ${GENRE_LABEL} AS title,
                (SELECT count(*) FROM ${C}.Genre_List gl
                   JOIN ${C}.Books_View b ON b.BookID = gl.BookID
                  WHERE gl.GenreCode = g.GenreCode
                    ${config.hideDeleted ? 'AND b.IsDeleted = 0' : ''}) AS books
           FROM ${C}.Genres g
          WHERE g.IsDeleted = 0
          ORDER BY ${GENRE_LABEL}`,
      )
      .all() as GenreRow[];

    return { items: buildGenreTree(rows) };
  });

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
