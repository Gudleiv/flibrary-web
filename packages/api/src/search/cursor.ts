// Keyset-пагинация.
//
// LIMIT/OFFSET на сотнях тысяч строк деградирует на глубоких страницах: SQLite всё равно
// проходит все пропускаемые строки. Курсор — это значение ключа сортировки последней
// отданной строки плюс BookID для однозначности.

export interface Cursor {
  /** Значение ключа сортировки последней строки предыдущей страницы. */
  key: string | number;
  bookId: number;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.bookId]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) throw new InvalidCursorError();

  const [key, bookId] = parsed;
  if ((typeof key !== 'string' && typeof key !== 'number') || typeof bookId !== 'number') {
    throw new InvalidCursorError();
  }

  return { key, bookId };
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Некорректный курсор');
    this.name = 'InvalidCursorError';
  }
}
