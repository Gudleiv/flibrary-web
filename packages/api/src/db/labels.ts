// Подписи справочников коллекции.
//
// Одно правило на всех потребителей: подпись жанра нужна и фасетам, и карточке книги,
// и дереву жанров, а разъехавшись, они показали бы одну и ту же сущность по-разному.

/**
 * Читаемое название жанра — выражение относительно справочника под алиасом `g`.
 *
 * Колонка `GenreTitle` в схеме есть, но в коллекции FLibrary она пустая у всех жанров:
 * человекочитаемое имя лежит в `GenreAlias` («Научная Фантастика»), а `GenreCode` —
 * это позиционный код вида «001.001», который в интерфейсе показывать нечего.
 * `GenreTitle` всё же берём первым: если он заполнен, это более точная подпись.
 */
export const GENRE_LABEL = `coalesce(nullif(g.GenreTitle, ''), nullif(g.GenreAlias, ''), g.GenreCode)`;

export const UNKNOWN_AUTHOR = 'Неизвестный автор';

/**
 * «Автор неизвестен» в коллекции — это не пропуск данных, а реальная запись справочника
 * с английским именем: `Unknown author` (887 книг) и `Unknown`. Пользователю показывать
 * её как есть незачем, поэтому сводим оба варианта и пустое имя к одной русской подписи.
 */
const UNKNOWN_AUTHOR_NAMES = new Set(['unknown', 'unknown author', 'unknown authors']);

export function displayAuthorName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' || UNKNOWN_AUTHOR_NAMES.has(trimmed.toLowerCase())
    ? UNKNOWN_AUTHOR
    : trimmed;
}
