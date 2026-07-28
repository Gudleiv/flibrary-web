// Генератор синтетической коллекции FLibrary.
//
// Делает то же, что делает импорт inpx, но из воздуха: collection.db по схеме FLibrary
// и zip-архивы с настоящими fb2. Нужен потому, что реальная библиотека — это десятки
// гигабайт, и без неё ни фронтенд разрабатывать, ни производительность мерить нельзя.
//
//   pnpm fixtures                       — 5 000 книг
//   pnpm fixtures -- --books=50000      — как в критерии готовности первой фазы
//   pnpm fixtures -- --books=200 --no-archives  — быстро, только БД

import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { Rng } from './random.js';
import { buildFb2, SAMPLE_COVER_JPEG_BASE64, type Fb2Book } from './fb2.js';
import {
  ADJECTIVES,
  ANNOTATION_SENTENCES,
  CHAPTER_TITLES,
  FEMALE_FIRST_NAMES,
  FEMALE_MIDDLE_NAMES,
  GENITIVES,
  GENRES,
  KEYWORDS,
  LANGUAGES,
  LAST_NAMES,
  MALE_FIRST_NAMES,
  MALE_MIDDLE_NAMES,
  NOUNS,
  PUBLISHER_CITIES,
  PUBLISHERS,
  SERIES_PATTERNS,
  TITLE_PATTERNS,
  VERBS,
} from './data.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..');

interface Options {
  books: number;
  seed: number;
  outDir: string;
  archives: boolean;
  booksPerArchive: number;
}

function parseOptions(argv: string[]): Options {
  const flag = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=', 2)[1];

  return {
    books: Number(flag('books') ?? process.env.FIXTURE_BOOKS ?? 5000),
    seed: Number(flag('seed') ?? 20260725),
    outDir: resolve(flag('out') ?? join(repoRoot, 'data')),
    archives: !argv.includes('--no-archives'),
    booksPerArchive: Number(flag('per-archive') ?? 5000),
  };
}

const options = parseOptions(process.argv.slice(2));
const rng = new Rng(options.seed);

if (!Number.isInteger(options.books) || options.books < 1) {
  throw new Error(`--books должен быть положительным целым, получено ${options.books}`);
}

// --- вспомогательное ---------------------------------------------------------

const upper = (value: string): string => value.toUpperCase();

function pickLanguage(): string {
  const roll = rng.next();
  let acc = 0;
  for (const { code, weight } of LANGUAGES) {
    acc += weight;
    if (roll <= acc) return code;
  }
  return 'ru';
}

function expandPattern(pattern: string): string {
  return pattern
    .replace(/%adj%/g, () => rng.pick(ADJECTIVES))
    .replace(/%noun%/g, () => rng.pick(NOUNS))
    .replace(/%genitive%/g, () => rng.pick(GENITIVES))
    .replace(/%verb%/g, () => rng.pick(VERBS));
}

const makeTitle = (): string => {
  const raw = expandPattern(rng.pick(TITLE_PATTERNS));
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

const makeSeriesTitle = (): string => {
  const raw = expandPattern(rng.pick(SERIES_PATTERNS));
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

function makeAnnotation(): string {
  return rng.sample(ANNOTATION_SENTENCES, rng.int(1, 3)).join(' ');
}

function transliterate(value: string): string {
  const map: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  };
  return [...value.toLowerCase()]
    .map((char) => map[char] ?? (/[a-z0-9]/.test(char) ? char : '_'))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// --- подготовка каталогов ----------------------------------------------------

const dbPath = join(options.outDir, 'collection.db');
const archivesDir = join(options.outDir, 'archives');

mkdirSync(options.outDir, { recursive: true });
mkdirSync(archivesDir, { recursive: true });
rmSync(dbPath, { force: true });

const db = new Database(dbPath);
db.pragma('journal_mode = OFF');
db.pragma('synchronous = OFF');
db.exec(readFileSync(join(packageRoot, 'schema/collection.sql'), 'utf8'));

// --- справочники -------------------------------------------------------------

const insertGenre = db.prepare(
  'INSERT INTO Genres (GenreCode, ParentCode, FB2Code, GenreAlias, GenreTitle) VALUES (?, ?, ?, ?, ?)',
);
const insertLanguage = db.prepare('INSERT INTO Languages (LanguageCode, Flags) VALUES (?, 0)');
const insertFolder = db.prepare('INSERT INTO Folders (FolderID, FolderTitle) VALUES (?, ?)');
const insertUpdate = db.prepare(
  'INSERT INTO Updates (UpdateID, UpdateTitle, ParentID, IsDeleted) VALUES (?, ?, ?, 0)',
);
const insertAuthor = db.prepare(
  'INSERT INTO Authors (AuthorID, LastName, FirstName, MiddleName, SearchName) VALUES (?, ?, ?, ?, ?)',
);
const insertSeries = db.prepare(
  'INSERT INTO Series (SeriesID, SeriesTitle, SearchTitle) VALUES (?, ?, ?)',
);
const insertKeyword = db.prepare(
  'INSERT INTO Keywords (KeywordID, KeywordTitle, SearchTitle) VALUES (?, ?, ?)',
);
const insertBook = db.prepare(
  `INSERT INTO Books
     (BookID, LibID, Title, UpdateDate, LibRate, Lang, Year, FolderID, FileName, Ext,
      BookSize, UpdateID, IsDeleted, SourceLib, SearchTitle)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
);
const insertAuthorLink = db.prepare(
  'INSERT INTO Author_List (AuthorID, BookID, OrdNum) VALUES (?, ?, ?)',
);
const insertSeriesLink = db.prepare(
  'INSERT INTO Series_List (SeriesID, BookID, SeqNumber, OrdNum) VALUES (?, ?, ?, 0)',
);
const insertGenreLink = db.prepare(
  'INSERT INTO Genre_List (GenreCode, BookID, OrdNum) VALUES (?, ?, ?)',
);
const insertKeywordLink = db.prepare(
  'INSERT INTO Keyword_List (KeywordID, BookID, OrdNum) VALUES (?, ?, ?)',
);
const insertAnnotation = db.prepare('INSERT INTO Annotations (BookID, Text) VALUES (?, ?)');
const insertBookUser = db.prepare(
  'INSERT INTO Books_User (BookID, IsDeleted, UserRate, Lang, CreatedAt) VALUES (?, 0, ?, NULL, ?)',
);
const insertSetting = db.prepare(
  'INSERT OR REPLACE INTO Settings (SettingID, SettingValue) VALUES (?, ?)',
);
const insertInpx = db.prepare('INSERT INTO Inpx (Folder, File, Hash) VALUES (?, ?, ?)');

const leafGenres = GENRES.filter((genre) => genre.parent !== null);

const authorCount = Math.max(8, Math.round(options.books / 6));
const seriesCount = Math.max(4, Math.round(options.books / 12));
const archiveCount = Math.max(1, Math.ceil(options.books / options.booksPerArchive));

interface Book {
  id: number;
  title: string;
  fileName: string;
  folderId: number;
  lang: string;
  year: number | null;
  authorIds: number[];
  seriesId: number | null;
  seqNumber: number | null;
  genres: string[];
  keywordIds: number[];
  annotation: string | null;
  hasCover: boolean;
}

const authors: Array<{ id: number; last: string; first: string; middle: string }> = [];
const seriesList: Array<{ id: number; title: string }> = [];
const keywords: Array<{ id: number; title: string }> = [];
const books: Book[] = [];

console.log(
  `Генерирую коллекцию: книг ${options.books}, авторов ~${authorCount}, серий ~${seriesCount}, архивов ${archiveCount}`,
);

db.transaction(() => {
  for (const genre of GENRES) {
    // Повторяем коллекцию как есть: у корневых жанров ParentCode — пустая строка,
    // а GenreTitle не заполнен вообще, название лежит только в GenreAlias.
    insertGenre.run(genre.code, genre.parent ?? '', genre.fb2, genre.title, null);
  }
  for (const { code } of LANGUAGES) {
    insertLanguage.run(code);
  }
  for (let index = 0; index < archiveCount; index += 1) {
    const from = index * options.booksPerArchive + 1;
    const to = (index + 1) * options.booksPerArchive;
    insertFolder.run(
      index + 1,
      `fb2-${String(from).padStart(6, '0')}-${String(to).padStart(6, '0')}.zip`,
    );
  }
  // Несколько «поставок»: по ним работает навигация Updates и сортировка «недавно добавленные».
  for (let index = 1; index <= 4; index += 1) {
    insertUpdate.run(index, index, 0);
  }

  for (let id = 1; id <= authorCount; id += 1) {
    const last = rng.pick(LAST_NAMES);
    // Род определяем по окончанию фамилии — так имя и отчество согласуются.
    const female = /(ва|на|ая|ёва|ева)$/.test(last);
    const first = rng.pick(female ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES);
    const middle = rng.pick(female ? FEMALE_MIDDLE_NAMES : MALE_MIDDLE_NAMES);
    authors.push({ id, last, first, middle });
    insertAuthor.run(id, last, first, middle, upper(last));
  }

  // В коллекции есть служебная запись «Unknown author» — обычный автор справочника с
  // сотнями книг. Повторяем её здесь, иначе перевод такой подписи в интерфейсе нечем
  // проверить: в синтетических данных все авторы русские и правило не срабатывает.
  const unknownAuthorId = authorCount + 1;
  authors.push({ id: unknownAuthorId, last: 'Unknown author', first: '', middle: '' });
  insertAuthor.run(unknownAuthorId, 'Unknown author', '', '', upper('Unknown author'));

  for (let id = 1; id <= seriesCount; id += 1) {
    const title = makeSeriesTitle();
    seriesList.push({ id, title });
    insertSeries.run(id, title, upper(title));
  }

  KEYWORDS.forEach((title, index) => {
    const id = index + 1;
    keywords.push({ id, title });
    insertKeyword.run(id, title, upper(title));
  });
})();

// --- книги -------------------------------------------------------------------

const nowIso = new Date(Date.UTC(2026, 6, 25)).toISOString();

const fillBooks = db.transaction(() => {
  for (let id = 1; id <= options.books; id += 1) {
    const title = makeTitle();
    const lang = pickLanguage();
    const folderId = Math.floor((id - 1) / options.booksPerArchive) + 1;
    const bookAuthors = rng.sample(authors, rng.weightedInt(1, 3));
    const inSeries = rng.bool(0.45);
    const series = inSeries ? rng.pick(seriesList) : null;
    const seqNumber = series ? rng.int(1, 12) : null;
    const genres = rng.sample(leafGenres, rng.weightedInt(1, 3));
    const bookKeywords = rng.sample(keywords, rng.weightedInt(0, 4));
    const annotation = rng.bool(0.85) ? makeAnnotation() : null;
    const year = rng.bool(0.93) ? rng.int(1890, 2026) : null;
    const libRate = rng.bool(0.6) ? rng.int(1, 5) : 0;
    const hasCover = rng.bool(0.7);
    const fileName = `${transliterate(title).slice(0, 40)}_${id}`;
    const updateId = rng.int(1, 4);

    const book: Book = {
      id,
      title,
      fileName,
      folderId,
      lang,
      year,
      authorIds: bookAuthors.map((author) => author.id),
      seriesId: series?.id ?? null,
      seqNumber,
      // В fb2 идут коды FB2, в Genre_List — коды коллекции: это разные словари.
      genres: genres.map((genre) => genre.fb2),
      keywordIds: bookKeywords.map((keyword) => keyword.id),
      annotation,
      hasCover,
    };
    books.push(book);

    // BookSize уточним после сборки fb2; пока приблизительно.
    insertBook.run(
      id,
      String(id),
      title,
      nowIso,
      libRate,
      lang,
      year,
      folderId,
      fileName,
      '.fb2',
      0,
      updateId,
      'fixtures',
      upper(title),
    );

    bookAuthors.forEach((author, index) => insertAuthorLink.run(author.id, id, index));
    genres.forEach((genre, index) => insertGenreLink.run(genre.code, id, index));
    bookKeywords.forEach((keyword, index) => insertKeywordLink.run(keyword.id, id, index));
    if (series) insertSeriesLink.run(series.id, id, seqNumber);
    if (annotation) insertAnnotation.run(id, annotation);
    if (rng.bool(0.12)) insertBookUser.run(id, rng.int(1, 5), nowIso);
  }
});

fillBooks();

// --- fb2 и архивы -----------------------------------------------------------

const updateSize = db.prepare('UPDATE Books SET BookSize = ? WHERE BookID = ?');

const authorsById = new Map(authors.map((author) => [author.id, author]));
const seriesById = new Map(seriesList.map((series) => [series.id, series]));
const keywordsById = new Map(keywords.map((keyword) => [keyword.id, keyword]));

function fb2For(book: Book): string {
  const payload: Fb2Book = {
    title: book.title,
    authors: book.authorIds.map((authorId) => {
      const author = authorsById.get(authorId);
      return {
        firstName: author?.first ?? '',
        middleName: author?.middle ?? '',
        lastName: author?.last ?? '',
      };
    }),
    genres: book.genres,
    lang: book.lang,
    year: book.year,
    annotation: book.annotation,
    series:
      book.seriesId === null
        ? null
        : {
            title: seriesById.get(book.seriesId)?.title ?? '',
            seqNumber: book.seqNumber,
          },
    keywords: book.keywordIds.map((keywordId) => keywordsById.get(keywordId)?.title ?? ''),
    // Язык оригинала и переводчики — только у части книг, как в жизни: разбор fb2
    // должен одинаково справляться и с ними, и без них.
    srcLang: book.lang !== 'ru' || !rng.bool(0.25) ? null : 'en',
    translators:
      book.lang === 'ru' && rng.bool(0.25)
        ? [{ firstName: rng.pick(MALE_FIRST_NAMES), lastName: rng.pick(LAST_NAMES) }]
        : [],
    publisher: rng.bool(0.7)
      ? {
          name: rng.pick(PUBLISHERS),
          city: rng.pick(PUBLISHER_CITIES),
          year: book.year ?? 2000,
          isbn: `978-5-${rng.int(1000, 9999)}-${rng.int(1000, 9999)}-${rng.int(0, 9)}`,
        }
      : null,
    chapters: Array.from({ length: rng.int(2, 5) }, (_, index) => ({
      title: CHAPTER_TITLES[index % CHAPTER_TITLES.length] ?? `Глава ${index + 1}`,
      paragraphs: Array.from({ length: rng.int(3, 8) }, () => makeAnnotation()),
    })),
    paragraphs: Array.from({ length: rng.int(6, 18) }, () => makeAnnotation()),
    cover: book.hasCover
      ? { fileName: 'cover.jpg', contentType: 'image/jpeg', base64: SAMPLE_COVER_JPEG_BASE64 }
      : null,
  };
  return buildFb2(payload);
}

const archiveNames = db
  .prepare('SELECT FolderID, FolderTitle FROM Folders ORDER BY FolderID')
  .all() as Array<{ FolderID: number; FolderTitle: string }>;

const sizes = new Map<number, number>();

for (const archive of archiveNames) {
  const archiveBooks = books.filter((book) => book.folderId === archive.FolderID);
  const zip = options.archives ? new JSZip() : null;

  for (const book of archiveBooks) {
    const content = fb2For(book);
    sizes.set(book.id, Buffer.byteLength(content, 'utf8'));
    zip?.file(`${book.fileName}.fb2`, content);
  }

  if (zip) {
    const target = join(archivesDir, archive.FolderTitle);

    // Поток, а не generateAsync({type:'nodebuffer'}): тот собирает готовый архив вторым
    // буфером в памяти — вдобавок к самим fb2, которые JSZip и так держит. На
    // --books=50000 это единственное место в проекте с реальным риском OOM. Здесь
    // сжатое пишется на диск по мере готовности, и обратное давление создаёт файл.
    //
    // streamFiles намеренно не включаем: с ним размер и CRC уезжают в дескриптор после
    // данных, а архивы читает распаковщик C++-сервера — незачем проверять, как он
    // относится к такому заголовку, ради буфера в одну книгу.
    await pipeline(
      zip.generateNodeStream({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      }),
      createWriteStream(target),
    );

    console.log(
      `${archive.FolderTitle}: ${archiveBooks.length} книг, ${(statSync(target).size / 1024 / 1024).toFixed(1)} МБ`,
    );
  }
}

db.transaction(() => {
  for (const [bookId, size] of sizes) updateSize.run(size, bookId);
})();

// --- FTS и служебное --------------------------------------------------------

// Индексы внешние (content=), поэтому после массовой вставки их надо пересобрать —
// ровно то же делает FLibrary после импорта inpx.
for (const table of [
  'Books_Search',
  'Authors_Search',
  'Series_Search',
  'Annotations_Search',
  'Compilations_Search',
]) {
  db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`);
}

// SettingID = 0 — версия схемы (IDatabaseUser::Key::DatabaseVersion), FLibrary ждёт 13.
insertSetting.run(0, '13');
insertInpx.run('fixtures', 'fixtures.inpx', 'fixtures');

db.exec('ANALYZE');
db.close();

const stats = new Database(dbPath, { readonly: true });
const count = (sql: string): number => (stats.prepare(sql).get() as { n: number }).n;
console.log('');
console.log('Готово:');
console.log(`  ${dbPath}`);
console.log(`    книг            ${count('SELECT count(*) n FROM Books')}`);
console.log(`    авторов         ${count('SELECT count(*) n FROM Authors')}`);
console.log(`    серий           ${count('SELECT count(*) n FROM Series')}`);
console.log(`    аннотаций       ${count('SELECT count(*) n FROM Annotations')}`);
console.log(`    жанров          ${count('SELECT count(*) n FROM Genres')}`);
console.log(`    оценок юзера    ${count('SELECT count(*) n FROM Books_User')}`);
if (options.archives) console.log(`  ${archivesDir}`);
stats.close();
