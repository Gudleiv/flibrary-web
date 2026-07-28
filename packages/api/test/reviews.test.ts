// Отзывы читателей: чтение 7z-архива «дополнительной папки» и разбор JSON.
//
// Архив в тесте настоящий — собирается тем же 7z, которым он читается. Формат имён
// (архив = Reviews.Folder с расширением, запись = FolderTitle#FileNameExt) взят из
// `inpx.cpp::CollectReviews` и `ReadReviews`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { parseReviews, readReviews, reviewsDirectory } from '../src/content/reviews.js';

const collectionDb = join(import.meta.dirname, '../../../data/collection.db');

/** Без 7z в системе читать нечего — на такой машине тесты пропускаются, а не падают. */
function has7z(): boolean {
  try {
    execFileSync('7z', ['i'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeIf7z = has7z() ? describe : describe.skip;

describe('разбор JSON с отзывами', () => {
  it('читает ник, время и текст', () => {
    const reviews = parseReviews(
      JSON.stringify([{ name: 'reader', time: '2011-04-02 12:30', text: 'Отличная книга.' }]),
    );

    expect(reviews).toEqual([
      { name: 'reader', time: '2011-04-02 12:30', text: 'Отличная книга.' },
    ]);
  });

  it('терпит другие написания ключей', () => {
    // Точные константы (Inpx::NAME, TIME, TEXT) лежат в заголовке, которого нет в
    // открытой части FLibrary: ошибка в одном написании оставила бы пустой раздел
    // на всех книгах разом.
    const reviews = parseReviews(JSON.stringify([{ Nick: 'reader', Date: '2011', Body: 'Текст' }]));

    expect(reviews).toEqual([{ name: 'reader', time: '2011', text: 'Текст' }]);
  });

  it('превращает <br/> в переводы строк', () => {
    const [review] = parseReviews(
      JSON.stringify([{ name: 'x', time: '1', text: 'Первая<br/>Вторая<BR>Третья' }]),
    );

    expect(review?.text).toBe('Первая\nВторая\nТретья');
  });

  it('отзыв без подписи показывает анонимом, без текста — выбрасывает', () => {
    const reviews = parseReviews(
      JSON.stringify([
        { time: '1', text: 'Есть текст' },
        { name: 'кто-то', time: '2', text: '   ' },
      ]),
    );

    expect(reviews).toEqual([{ name: 'Аноним', time: '1', text: 'Есть текст' }]);
  });

  it('сортирует по времени', () => {
    const reviews = parseReviews(
      JSON.stringify([
        { name: 'b', time: '2011-05-01', text: 'Позже' },
        { name: 'a', time: '2011-04-01', text: 'Раньше' },
      ]),
    );

    expect(reviews.map((review) => review.text)).toEqual(['Раньше', 'Позже']);
  });

  it('битый или чужой JSON не роняет ручку', () => {
    expect(parseReviews('не json')).toEqual([]);
    expect(parseReviews('{"items": []}')).toEqual([]);
    expect(parseReviews('[null, 42, "строка"]')).toEqual([]);
  });
});

(existsSync(collectionDb) ? describe : describe.skip)('имя записи в архиве', () => {
  it('Books_View.FileName уже содержит расширение, дописывать Ext нельзя', () => {
    // Из-за этого запросы самой FLibrary выглядят противоречиво: по таблице Books она
    // склеивает `FileName || Ext` (inpx.cpp::ReadReviews), а по представлению берёт
    // FileName как есть (AuthorReviewModel) — и оба правы. Дописав Ext к значению из
    // представления, мы получали бы «книга.fb2.fb2» и пустые отзывы у всех книг.
    const db = new Database(collectionDb, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT v.FileName AS viewName, v.BaseFileName AS baseName, v.Ext AS ext
             FROM Books_View v WHERE v.Ext IS NOT NULL LIMIT 1`,
        )
        .get() as { viewName: string; baseName: string; ext: string };

      expect(row.viewName).toBe(`${row.baseName}${row.ext}`);
    } finally {
      db.close();
    }
  });
});

describeIf7z('чтение архива отзывов', () => {
  let additional: string;
  let directory: string;

  const archive = '123456.7z';
  // Кавычка и пробел в имени: оно приходит из коллекции и в оболочку попадать не должно.
  const entry = 'fb2-000001-005000.zip#Последний "берег" 1.fb2';

  beforeAll(() => {
    additional = join(tmpdir(), `flw-reviews-${process.pid}`);
    directory = join(additional, 'reviews');
    rmSync(additional, { force: true, recursive: true });
    mkdirSync(directory, { recursive: true });

    const staging = join(additional, 'staging');
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, entry),
      JSON.stringify([
        { name: 'читатель', time: '2011-04-02 12:30', text: 'Понравилось.<br/>Рекомендую.' },
        { name: '', time: '2010-01-01 00:00', text: 'Раньше всех.' },
      ]),
      'utf8',
    );

    execFileSync('7z', ['a', '-bd', '-bso0', join(directory, archive), join(staging, entry)]);
  });

  afterAll(() => {
    rmSync(additional, { force: true, recursive: true });
  });

  it('находит каталог отзывов в дополнительной папке', () => {
    expect(reviewsDirectory(additional)).toBe(directory);
    expect(reviewsDirectory('')).toBeNull();
    expect(reviewsDirectory(join(tmpdir(), 'flw-нет-такой-папки'))).toBeNull();
  });

  it('достаёт отзывы книги из архива', async () => {
    const reviews = await readReviews(directory, archive, entry);

    expect(reviews).toHaveLength(2);
    // Отсортированы по времени, <br/> раскрыт, безымянный подписан анонимом.
    expect(reviews[0]).toEqual({ name: 'Аноним', time: '2010-01-01 00:00', text: 'Раньше всех.' });
    expect(reviews[1]?.text).toBe('Понравилось.\nРекомендую.');
  });

  it('книга без отзывов в архиве — пустой список, а не ошибка', async () => {
    await expect(readReviews(directory, archive, 'нет#такой.fb2')).resolves.toEqual([]);
  });

  it('несуществующий архив — пустой список', async () => {
    await expect(readReviews(directory, 'нет.7z', entry)).resolves.toEqual([]);
  });

  it('имя архива не уводит за пределы каталога отзывов', async () => {
    // Значение приходит из коллекции: '../../etc/passwd.7z' читать мы не должны.
    await expect(readReviews(directory, '../../secret.7z', entry)).resolves.toEqual([]);
    expect(existsSync(join(directory, archive))).toBe(true);
  });
});
