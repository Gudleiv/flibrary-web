// Догрузка связанных сущностей для страницы результатов.
//
// Один запрос на страницу вместо подзапроса на строку: на выдаче из 50 книг разница
// между 1 и 150 обращениями к SQLite заметна. Ровно та же причина, по которой в
// GraphQL-варианте пришлось бы писать dataloader-ы.

import type { Database as Db } from 'better-sqlite3';
import type { AuthorRef, GenreRef } from '@flibrary/contract';

import { COLLECTION as C } from '../db/index.js';
import { GENRE_LABEL } from '../db/labels.js';
import { toAuthorRef, toGenreRef, type AuthorRow, type GenreRow } from './mappers.js';

function groupBy<T extends { bookId: number }, R>(rows: T[], map: (row: T) => R): Map<number, R[]> {
  const result = new Map<number, R[]>();
  for (const row of rows) {
    const list = result.get(row.bookId);
    if (list === undefined) result.set(row.bookId, [map(row)]);
    else list.push(map(row));
  }
  return result;
}

export function loadAuthors(db: Db, bookIds: number[]): Map<number, AuthorRef[]> {
  if (bookIds.length === 0) return new Map();
  const placeholders = bookIds.map(() => '?').join(', ');

  const rows = db
    .prepare(
      `SELECT al.BookID AS bookId, a.AuthorID AS authorId, a.LastName AS lastName,
              a.FirstName AS firstName, a.MiddleName AS middleName
         FROM ${C}.Author_List al
         JOIN ${C}.Authors a ON a.AuthorID = al.AuthorID
        WHERE al.BookID IN (${placeholders})
        ORDER BY al.BookID, al.OrdNum`,
    )
    .all(bookIds) as AuthorRow[];

  return groupBy(rows, toAuthorRef);
}

export function loadGenres(db: Db, bookIds: number[]): Map<number, GenreRef[]> {
  if (bookIds.length === 0) return new Map();
  const placeholders = bookIds.map(() => '?').join(', ');

  const rows = db
    .prepare(
      `SELECT gl.BookID AS bookId, g.GenreCode AS code, ${GENRE_LABEL} AS title
         FROM ${C}.Genre_List gl
         JOIN ${C}.Genres g ON g.GenreCode = gl.GenreCode
        WHERE gl.BookID IN (${placeholders})
        ORDER BY gl.BookID, gl.OrdNum`,
    )
    .all(bookIds) as GenreRow[];

  return groupBy(rows, toGenreRef);
}

export function loadKeywords(db: Db, bookId: number): string[] {
  const rows = db
    .prepare(
      `SELECT k.KeywordTitle AS title
         FROM ${C}.Keyword_List kl
         JOIN ${C}.Keywords k ON k.KeywordID = kl.KeywordID
        WHERE kl.BookID = ?
        ORDER BY kl.OrdNum`,
    )
    .all(bookId) as Array<{ title: string | null }>;

  return rows.map((row) => row.title).filter((title): title is string => title !== null);
}
