// Форматирование величин для показа пользователю.

const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] as const;

/**
 * Размер файла человекочитаемо.
 *
 * Килобайт здесь двоичный (1024), как его считает и сама FLibrary: `BookSize` в
 * коллекции — это размер файла в байтах, и сравнивать наши цифры пользователь будет
 * с тем, что показывает проводник, а не с округлением по СИ.
 */
export function formatSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes === 0) return '0 Б';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Байты и килобайты дробными не бывают полезны: «5 КБ» читается, «4,9 КБ» — нет.
  // Начиная с мегабайт знак после запятой уже несёт смысл.
  const digits = unit >= 2 && value < 100 ? 1 : 0;
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: digits })} ${UNITS[unit]}`;
}

/** Целое с разделителями разрядов: 1234567 → «1 234 567». */
export function formatCount(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toLocaleString('ru-RU');
}

/**
 * Дата из коллекции. `UpdateDate` FLibrary хранит по-разному — от `2024-01-31` до
 * ISO с временем, — поэтому нераспознанное отдаём как есть, а не прячем.
 */
export function formatDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;

  return parsed.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });
}
