// Отзывы читателей — исторический слепок с форума библиотеки.
//
// В БД коллекции их нет: `Reviews (BookID, Folder)` — это только указатель. Сами отзывы
// лежат в «дополнительной папке» коллекции: `<additional>/reviews/<Folder>`, где Folder —
// имя 7z-архива вместе с расширением (`inpx.cpp::CollectReviews` кладёт в БД
// `fileInfo.fileName()`). Внутри архива запись называется `<FolderTitle>#<FileName><Ext>`
// — то же имя строят два независимых запроса FLibrary (`inpx.cpp::ReadReviews` и
// `AnnotationController.cpp::REVIEWS_QUERY`), — а её содержимое это JSON-массив отзывов.
//
// Почему внешний 7z, а не библиотека: рабочих чистых JS-распаковщиков 7z нет, а
// подключать wasm-сборку ради необязательной функции дороже, чем строчка в Dockerfile.
// Архив читается в поток (`-so`), на диск ничего не кладётся.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Один отзыв: ник, время и текст — ровно то, что показывает десктопный FLibrary. */
export interface Review {
  name: string;
  time: string;
  text: string;
}

/** Отзывы бывают огромными, но не мегабайтными: ограничение против битого архива. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export class ReviewsUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Не удалось прочитать архив отзывов');
    this.name = 'ReviewsUnavailableError';
    this.cause = cause;
  }
}

/** Каталог с архивами отзывов — или null, если у коллекции его нет. */
export function reviewsDirectory(additionalDir: string): string | null {
  if (additionalDir === '') return null;
  const directory = join(additionalDir, 'reviews');
  return existsSync(directory) ? directory : null;
}

/**
 * Отзывы к одной книге.
 *
 * `archive` — значение `Reviews.Folder`, `entry` — `<FolderTitle>#<FileName><Ext>`.
 * Оба приходят из коллекции, но в командную строку не подставляются: `execFile` без
 * оболочки, аргументы списком — имя файла с кавычкой или точкой с запятой команду
 * не разорвёт.
 */
export async function readReviews(
  directory: string,
  archive: string,
  entry: string,
): Promise<Review[]> {
  const path = join(directory, archive);
  // Имя архива из БД не должно уводить за пределы каталога отзывов.
  if (!path.startsWith(directory) || !existsSync(path)) return [];

  let stdout: string;
  try {
    // `e -so` — извлечь в стандартный вывод; `-ba` убирает шапку 7-Zip из него.
    ({ stdout } = await run('7z', ['e', '-so', '-ba', '-bd', path, entry], {
      maxBuffer: MAX_ENTRY_BYTES,
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
    }));
  } catch (error) {
    // Нет такой записи в архиве — не ошибка: у книги просто нет отзывов.
    if (isMissingEntry(error)) return [];
    throw new ReviewsUnavailableError(error);
  }

  return parseReviews(stdout);
}

function isMissingEntry(error: unknown): boolean {
  const message = (error as { stderr?: string; message?: string }).stderr ?? '';
  return /No files to process|ERROR: .*\bcannot find\b/i.test(message);
}

/**
 * Разбор JSON с отзывами.
 *
 * Имена полей терпимы к регистру и синонимам осознанно: точные константы
 * (`Inpx::NAME`, `TIME`, `TEXT`) лежат в заголовке, которого нет в открытой части
 * FLibrary, поэтому полагаться на одно написание нельзя. Лишний вариант ключа стоит
 * строчки, а ошибка в нём — пустого раздела на всех книгах сразу.
 */
export function parseReviews(json: string): Review[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const reviews = parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const pick = (...keys: string[]): string => {
        for (const key of keys) {
          const found = Object.entries(item).find(
            ([name]) => name.toLowerCase() === key.toLowerCase(),
          );
          if (typeof found?.[1] === 'string' && found[1] !== '') return found[1];
        }
        return '';
      };

      return {
        // Отзывы без подписи в слепке форума обычны — «Аноним» честнее пустой строки.
        name: pick('name', 'nick', 'nickname', 'user', 'author') || 'Аноним',
        time: pick('time', 'date', 'datetime'),
        // Переносы в слепке размечены `<br/>`; больше разметки в отзывах не бывает.
        text: pick('text', 'body', 'review')
          .replace(/<br\s*\/?>/gi, '\n')
          .trim(),
      };
    })
    .filter((review) => review.text !== '');

  // По времени: слепок форума приходит как попало, а читать отзывы в порядке
  // появления — единственный осмысленный порядок.
  return reviews.sort((a, b) => a.time.localeCompare(b.time));
}
