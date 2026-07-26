// Приведение строк SQL к форме контракта.
//
// Держим в одном месте: коллекция отдаёт снейк-кейс-подобные поля FLibrary и хранит
// расширение с точкой, а наружу по контракту уходит camelCase и расширение без точки.

import type { AuthorRef, BookListItem, GenreRef } from '@flibrary/contract';

import { displayAuthorName } from '../db/labels.js';

export interface BookRow {
  bookId: number;
  title: string;
  year: number | null;
  lang: string | null;
  ext: string | null;
  size: number | null;
  libRate: number | null;
  seriesId: number | null;
  seriesTitle: string | null;
  seqNumber: number | null;
  sortKey: string | number;
  userRate: number | null;
  favorite: number | null;
  isRead: number | null;
}

/** В коллекции Ext хранится как '.fb2' — наружу отдаём без точки. */
export const normalizeExt = (ext: string | null): string | null =>
  ext === null ? null : ext.replace(/^\./, '');

export function mapBookRow(row: BookRow): BookListItem {
  return {
    bookId: row.bookId,
    title: row.title,
    // Авторы и жанры для списка добираются отдельным запросом (см. attachRelations):
    // тащить их подзапросом на каждую строку дороже, чем одним IN-запросом на страницу.
    authors: [],
    genres: [],
    series:
      row.seriesId === null || row.seriesTitle === null
        ? undefined
        : { seriesId: row.seriesId, title: row.seriesTitle },
    seqNumber: row.seqNumber,
    year: row.year,
    lang: row.lang,
    ext: normalizeExt(row.ext),
    size: row.size,
    libRate: row.libRate,
    userRate: row.userRate,
    hasCover: false,
    favorite: row.favorite === 1,
    read: row.isRead === 1,
  };
}

export interface AuthorRow {
  bookId: number;
  authorId: number;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
}

export interface GenreRow {
  bookId: number;
  code: string;
  title: string | null;
}

export const authorName = (row: AuthorRow): string =>
  displayAuthorName([row.lastName, row.firstName, row.middleName].filter((part) => part).join(' '));

export const toAuthorRef = (row: AuthorRow): AuthorRef => ({
  authorId: row.authorId,
  name: authorName(row),
  lastName: row.lastName,
  firstName: row.firstName,
  middleName: row.middleName,
});

export const toGenreRef = (row: GenreRow): GenreRef => ({
  code: row.code,
  title: row.title ?? row.code,
});
