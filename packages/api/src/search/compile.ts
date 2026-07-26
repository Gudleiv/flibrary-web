// Компилятор дерева предикатов в параметризованный SQL.
//
// Все литералы уходят только через биндинг — никакой конкатенации пользовательского ввода
// в SQL (в текущем C++-сервере FLibrary это как раз сделано неправильно, см. doc).
//
// Стратегия первой фазы: каждый предикат компилируется в множество BookID, логика
// собирается компаундами SQLite (INTERSECT / UNION / EXCEPT). Это прямолинейно и
// заведомо корректно, но не оптимально: планировщик не может протолкнуть условия внутрь.
// Когда появится собственный индекс в app.db (см. src/indexer), горячие комбинации
// переедут на него — контракт при этом не меняется.

import type {
  BoolPredicate,
  IdPredicate,
  NumberPredicate,
  RangePredicate,
  SearchNode,
  SearchPredicate,
  SearchQuery,
  SortSpec,
  TermPredicate,
  TextPredicate,
} from '@flibrary/contract';
import { isSearchGroup, isSearchNot } from '@flibrary/contract';

import { COLLECTION as C } from '../db/index.js';
import { FACET_SPECS, normalizePinned, type FacetPlan } from './facets.js';
import { buildFtsQuery, buildIndexQuery, buildLikePattern, buildTrigramQuery } from './fts.js';
import { decodeCursor, type Cursor } from './cursor.js';

export class UnsupportedPredicateError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnsupportedPredicateError';
  }
}

export class EmptyQueryError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'EmptyQueryError';
  }
}

interface Fragment {
  sql: string;
  params: unknown[];
}

export interface CompileContext {
  userId: number;
  hideDeleted: boolean;
  /**
   * Собран ли собственный индекс. Если да — текстовые предикаты идут в него (морфология,
   * подстроки, bm25); если нет — работаем по FTS-таблицам коллекции, как раньше.
   * Так приложение остаётся работоспособным до первой индексации.
   */
  useIndex: boolean;
}

/** Колонки books_fts в порядке объявления — нужен для колоночных фильтров и весов bm25. */
const INDEX_COLUMNS: Record<Exclude<TextPredicate['field'], 'any'>, string> = {
  title: 'title',
  author: 'authors',
  series: 'series',
  keyword: 'keywords',
  annotation: 'annotation',
};

export interface CompiledSearch {
  /** Запрос страницы результатов. */
  sql: string;
  params: unknown[];
  limit: number;
  /** Колонка выдачи, из которой берётся ключ курсора. */
  sortKeyAlias: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Потолок пропуска для постраничной навигации. Курсор остаётся основным способом листать
 * (см. решение 4 в docs/decisions.md), но по номерам страниц курсором не попасть, а цена
 * известна: на несжатой выдаче в 705 тысяч книг последняя страница считается около
 * четырёх секунд против 0,2 на первой. Ограничение — чтобы это не превращалось в
 * произвольно дорогой запрос.
 */
const MAX_OFFSET = 5_000_000;

/** Все книги — база для NOT. */
const ALL_BOOKS = `SELECT BookID FROM ${C}.Books`;

// --- предикаты ---------------------------------------------------------------

/** Текстовый предикат по собственному индексу. */
function compileTextViaIndex(predicate: TextPredicate): Fragment {
  const { field, op, value } = predicate;

  if (op === 'substring') {
    if (field === 'annotation') {
      // Аннотации в триграммный индекс не попадают: он вырос бы в разы, а спрос на
      // подстроку внутри аннотации близок к нулю.
      throw new UnsupportedPredicateError(
        'Подстрочный поиск по аннотации не поддерживается: она не входит в триграммный индекс',
      );
    }

    const query = buildTrigramQuery(value, field === 'any' ? undefined : INDEX_COLUMNS[field]);
    if (query === null) {
      throw new EmptyQueryError('Для подстрочного поиска нужно минимум три символа');
    }
    return {
      sql: 'SELECT books_trgm.rowid AS BookID FROM books_trgm WHERE books_trgm MATCH ?',
      params: [query],
    };
  }

  const column = field === 'any' ? undefined : INDEX_COLUMNS[field];
  const query = buildIndexQuery(value, op, column);
  if (query === null) {
    throw new EmptyQueryError(`Пустой поисковый запрос по полю ${field}`);
  }

  return {
    sql: 'SELECT books_fts.rowid AS BookID FROM books_fts WHERE books_fts MATCH ?',
    params: [query],
  };
}

/** Текстовый предикат по FTS-таблицам коллекции (пока индекс не собран). */
function compileText(predicate: TextPredicate): Fragment {
  const { field, op, value } = predicate;

  if (op === 'substring') {
    // Подстрочный поиск по нормализованным полям. До появления триграммного индекса
    // это LIKE '%...%' — то есть полный проход. Осознанно медленно, но работает.
    const pattern = buildLikePattern(value, 'substring');
    switch (field) {
      case 'title':
      case 'any':
        return {
          sql: `SELECT BookID FROM ${C}.Books WHERE SearchTitle LIKE ? ESCAPE '\\'`,
          params: [pattern],
        };
      case 'author':
        return {
          sql: `SELECT al.BookID FROM ${C}.Author_List al
                  JOIN ${C}.Authors a ON a.AuthorID = al.AuthorID
                 WHERE a.SearchName LIKE ? ESCAPE '\\'`,
          params: [pattern],
        };
      case 'series':
        return {
          sql: `SELECT sl.BookID FROM ${C}.Series_List sl
                  JOIN ${C}.Series s ON s.SeriesID = sl.SeriesID
                 WHERE s.SearchTitle LIKE ? ESCAPE '\\'`,
          params: [pattern],
        };
      case 'keyword':
        return {
          sql: `SELECT kl.BookID FROM ${C}.Keyword_List kl
                  JOIN ${C}.Keywords k ON k.KeywordID = kl.KeywordID
                 WHERE k.SearchTitle LIKE ? ESCAPE '\\'`,
          params: [pattern],
        };
      case 'annotation':
        throw new UnsupportedPredicateError(
          'Подстрочный поиск по аннотации не поддерживается: нужен триграммный индекс (см. indexer)',
        );
    }
  }

  // Ключевые слова в коллекции не покрыты FTS-таблицей — только нормализованное поле.
  if (field === 'keyword') {
    const pattern = buildLikePattern(value, 'prefix');
    return {
      sql: `SELECT kl.BookID FROM ${C}.Keyword_List kl
              JOIN ${C}.Keywords k ON k.KeywordID = kl.KeywordID
             WHERE k.SearchTitle LIKE ? ESCAPE '\\'`,
      params: [pattern],
    };
  }

  const ftsQuery = buildFtsQuery(value, op);
  if (ftsQuery === null) {
    throw new EmptyQueryError(`Пустой поисковый запрос по полю ${field}`);
  }

  const byTitle: Fragment = {
    sql: `SELECT Books_Search.rowid AS BookID FROM ${C}.Books_Search WHERE Books_Search MATCH ?`,
    params: [ftsQuery],
  };
  const byAuthor: Fragment = {
    sql: `SELECT al.BookID FROM ${C}.Author_List al
            JOIN ${C}.Authors_Search ON Authors_Search.rowid = al.AuthorID
           WHERE Authors_Search MATCH ?`,
    params: [ftsQuery],
  };
  const bySeries: Fragment = {
    sql: `SELECT sl.BookID FROM ${C}.Series_List sl
            JOIN ${C}.Series_Search ON Series_Search.rowid = sl.SeriesID
           WHERE Series_Search MATCH ?`,
    params: [ftsQuery],
  };
  const byAnnotation: Fragment = {
    sql: `SELECT Annotations_Search.rowid AS BookID FROM ${C}.Annotations_Search WHERE Annotations_Search MATCH ?`,
    params: [ftsQuery],
  };

  switch (field) {
    case 'title':
      return byTitle;
    case 'author':
      return byAuthor;
    case 'series':
      return bySeries;
    case 'annotation':
      return byAnnotation;
    case 'any':
      // Пока сводного индекса нет — объединяем четыре. Именно это заменит indexer.
      return union([byTitle, byAuthor, bySeries, byAnnotation]);
  }
}

function compileTerm(predicate: TermPredicate): Fragment {
  const { values } = predicate;
  const placeholders = values.map(() => '?').join(', ');

  switch (predicate.field) {
    case 'lang':
      return {
        sql: `SELECT BookID FROM ${C}.Books WHERE Lang IN (${placeholders})`,
        params: values,
      };
    case 'ext': {
      // В коллекции Ext хранится с точкой ('.fb2') — приводим пользовательский ввод.
      const normalized = values.map((value: string) =>
        value.startsWith('.') ? value : `.${value}`,
      );
      return {
        sql: `SELECT BookID FROM ${C}.Books WHERE Ext IN (${placeholders})`,
        params: normalized,
      };
    }
    case 'archive':
      return {
        sql: `SELECT b.BookID FROM ${C}.Books b
                JOIN ${C}.Folders f ON f.FolderID = b.FolderID
               WHERE f.FolderTitle IN (${placeholders})`,
        params: values,
      };
    case 'genre':
      if (predicate.includeChildren) {
        // Дерево жанров в коллекции — ParentCode; разворачиваем рекурсивным CTE.
        return {
          sql: `SELECT gl.BookID FROM ${C}.Genre_List gl
                 WHERE gl.GenreCode IN (
                   WITH RECURSIVE tree (code) AS (
                     SELECT GenreCode FROM ${C}.Genres WHERE GenreCode IN (${placeholders})
                     UNION
                     SELECT g.GenreCode FROM ${C}.Genres g JOIN tree t ON g.ParentCode = t.code
                   )
                   SELECT code FROM tree
                 )`,
          params: values,
        };
      }
      return {
        sql: `SELECT BookID FROM ${C}.Genre_List WHERE GenreCode IN (${placeholders})`,
        params: values,
      };
  }
}

function compileNumber(predicate: NumberPredicate): Fragment {
  const operators = { eq: '=', gte: '>=', lte: '<=', gt: '>', lt: '<' } as const;
  const operator = operators[predicate.op];

  switch (predicate.field) {
    case 'year':
      return {
        sql: `SELECT BookID FROM ${C}.Books WHERE Year ${operator} ?`,
        params: [predicate.value],
      };
    case 'libRate':
      return {
        sql: `SELECT BookID FROM ${C}.Books WHERE LibRate ${operator} ?`,
        params: [predicate.value],
      };
    case 'size':
      return {
        sql: `SELECT BookID FROM ${C}.Books WHERE BookSize ${operator} ?`,
        params: [predicate.value],
      };
    case 'seqNumber':
      return {
        sql: `SELECT BookID FROM ${C}.Series_List WHERE SeqNumber ${operator} ?`,
        params: [predicate.value],
      };
    case 'userRate':
      // Оценка ИЗ НАШЕЙ БД: в коллекции Books_User — это данные единственного
      // локального пользователя десктопа, а у нас пользователей несколько.
      return {
        sql: `SELECT book_id AS BookID FROM book_user_data WHERE user_id = :userId AND rate ${operator} ?`,
        params: [predicate.value],
      };
  }
}

function compileRange(predicate: RangePredicate): Fragment {
  if (predicate.from == null && predicate.to == null) {
    throw new EmptyQueryError(`Диапазон по полю ${predicate.field} без границ`);
  }

  if (predicate.field === 'seqNumber') {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (predicate.from != null) {
      parts.push('SeqNumber >= ?');
      params.push(predicate.from);
    }
    if (predicate.to != null) {
      parts.push('SeqNumber <= ?');
      params.push(predicate.to);
    }
    return {
      sql: `SELECT BookID FROM ${C}.Series_List WHERE ${parts.join(' AND ')}`,
      params,
    };
  }

  if (predicate.field === 'userRate') {
    const parts: string[] = ['user_id = :userId'];
    const params: unknown[] = [];
    if (predicate.from != null) {
      parts.push('rate >= ?');
      params.push(predicate.from);
    }
    if (predicate.to != null) {
      parts.push('rate <= ?');
      params.push(predicate.to);
    }
    return {
      sql: `SELECT book_id AS BookID FROM book_user_data WHERE ${parts.join(' AND ')}`,
      params,
    };
  }

  const column = { year: 'Year', libRate: 'LibRate', size: 'BookSize' }[predicate.field];
  const parts: string[] = [];
  const params: unknown[] = [];
  if (predicate.from != null) {
    parts.push(`${column} >= ?`);
    params.push(predicate.from);
  }
  if (predicate.to != null) {
    parts.push(`${column} <= ?`);
    params.push(predicate.to);
  }

  return { sql: `SELECT BookID FROM ${C}.Books WHERE ${parts.join(' AND ')}`, params };
}

function compileId(predicate: IdPredicate): Fragment {
  const { values } = predicate;
  const placeholders = values.map(() => '?').join(', ');

  switch (predicate.field) {
    case 'authorId':
      return {
        sql: `SELECT BookID FROM ${C}.Author_List WHERE AuthorID IN (${placeholders})`,
        params: values,
      };
    case 'seriesId':
      return {
        sql: `SELECT BookID FROM ${C}.Series_List WHERE SeriesID IN (${placeholders})`,
        params: values,
      };
    case 'keywordId':
      return {
        sql: `SELECT BookID FROM ${C}.Keyword_List WHERE KeywordID IN (${placeholders})`,
        params: values,
      };
    case 'groupId':
      // Группы живут в коллекции и принадлежат десктопному пользователю — оставляем
      // как есть: это кураторские подборки, а не персональные данные.
      return {
        sql: `SELECT BookID FROM ${C}.Groups_List_User_View WHERE GroupID IN (${placeholders})`,
        params: values,
      };
  }
}

function compileBool(predicate: BoolPredicate): Fragment {
  const { field, value } = predicate;

  const ours = (column: 'favorite' | 'read'): Fragment =>
    value
      ? {
          sql: `SELECT book_id AS BookID FROM book_user_data WHERE user_id = :userId AND ${column} = 1`,
          params: [],
        }
      : {
          sql: `${ALL_BOOKS} EXCEPT SELECT book_id FROM book_user_data WHERE user_id = :userId AND ${column} = 1`,
          params: [],
        };

  const exists = (sql: string): Fragment =>
    value ? { sql, params: [] } : { sql: `${ALL_BOOKS} EXCEPT ${sql}`, params: [] };

  switch (field) {
    case 'favorite':
      return ours('favorite');
    case 'read':
      return ours('read');
    case 'hasAnnotation':
      return exists(`SELECT BookID FROM ${C}.Annotations`);
    case 'hasReview':
      return exists(`SELECT BookID FROM ${C}.Reviews`);
    case 'deleted':
      return {
        sql: `SELECT BookID FROM ${C}.Books_View WHERE IsDeleted = ?`,
        params: [value ? 1 : 0],
      };
    case 'hasCover':
      // Наличие обложки в коллекции не хранится: FLibrary узнаёт это, распаковав книгу.
      // Флаг появится, когда индексатор начнёт его записывать в app.db.
      throw new UnsupportedPredicateError(
        'Фильтр hasCover пока не поддерживается: наличие обложки станет известно после индексации',
      );
  }
}

function compilePredicate(predicate: SearchPredicate, context: CompileContext): Fragment {
  const textFields = ['any', 'title', 'author', 'series', 'annotation', 'keyword'];
  const termFields = ['lang', 'ext', 'genre', 'archive'];
  const numberFields = ['year', 'libRate', 'userRate', 'size', 'seqNumber'];
  const idFields = ['authorId', 'seriesId', 'keywordId', 'groupId'];

  if (predicate.op === 'range') return compileRange(predicate as RangePredicate);
  if (textFields.includes(predicate.field)) {
    return context.useIndex
      ? compileTextViaIndex(predicate as TextPredicate)
      : compileText(predicate as TextPredicate);
  }
  if (termFields.includes(predicate.field)) return compileTerm(predicate as TermPredicate);
  if (numberFields.includes(predicate.field)) return compileNumber(predicate as NumberPredicate);
  if (idFields.includes(predicate.field)) return compileId(predicate as IdPredicate);
  return compileBool(predicate as BoolPredicate);
}

// --- сборка дерева -----------------------------------------------------------

function combine(fragments: Fragment[], operator: 'INTERSECT' | 'UNION'): Fragment {
  if (fragments.length === 1) return fragments[0] as Fragment;
  return {
    sql: fragments
      .map((fragment) => `SELECT BookID FROM (${fragment.sql})`)
      .join(`\n${operator}\n`),
    params: fragments.flatMap((fragment) => fragment.params),
  };
}

const union = (fragments: Fragment[]): Fragment => combine(fragments, 'UNION');

/**
 * Множество без дублей BookID.
 *
 * Одиночный предикат по связке может вернуть книгу несколько раз: у книги два
 * автора, оба подошли под «фамилия начинается на…» — и она попадает в множество
 * дважды. Без дедупликации это даёт дубли в выдаче, завышенный total и завышенные
 * счётчики фасетов. Компаунды (INTERSECT/UNION) дубли снимают сами, но полагаться
 * на это нельзя: дерево может состоять из одного узла.
 */
const distinct = (fragment: Fragment): Fragment => ({
  sql: `SELECT DISTINCT BookID FROM (${fragment.sql})`,
  params: fragment.params,
});

function compileNode(node: SearchNode, context: CompileContext): Fragment {
  if (isSearchGroup(node)) {
    const parts = node.nodes.map((child) => compileNode(child, context));
    return combine(parts, node.op === 'and' ? 'INTERSECT' : 'UNION');
  }

  if (isSearchNot(node)) {
    const inner = compileNode(node.node, context);
    return {
      sql: `${ALL_BOOKS} EXCEPT SELECT BookID FROM (${inner.sql})`,
      params: inner.params,
    };
  }

  return compilePredicate(node, context);
}

// --- сортировка --------------------------------------------------------------

interface SortPlan {
  /** SQL-выражение ключа сортировки; должно быть NOT NULL, иначе курсор поедет. */
  expression: string;
  direction: 'ASC' | 'DESC';
}

function planSort(sort: SortSpec[] | undefined, rankAvailable: boolean): SortPlan {
  const first = sort?.[0];
  const field = first?.field ?? 'relevance';
  const direction: 'ASC' | 'DESC' =
    (first?.dir ?? (field === 'relevance' ? 'desc' : 'asc')) === 'desc' ? 'DESC' : 'ASC';

  // bm25 возвращает тем меньшее число, чем релевантнее документ, поэтому ASC.
  if (field === 'relevance' && rankAvailable) {
    return { expression: 'm.rank', direction: 'ASC' };
  }

  // NULL-значения приводим к краю диапазона: ключ курсора обязан быть сравнимым.
  switch (field) {
    case 'title':
      return { expression: `IFNULL(b.SearchTitle, '')`, direction };
    case 'year':
      return { expression: 'IFNULL(b.Year, 0)', direction };
    case 'libRate':
      return { expression: 'IFNULL(b.LibRate, 0)', direction };
    case 'userRate':
      return {
        expression: `IFNULL((SELECT rate FROM book_user_data WHERE user_id = :userId AND book_id = b.BookID), 0)`,
        direction,
      };
    case 'size':
      return { expression: 'IFNULL(b.BookSize, 0)', direction };
    case 'addedAt':
      return { expression: 'IFNULL(b.UpdateID, 0)', direction };
    case 'seqNumber':
      return {
        expression: `IFNULL((SELECT MIN(SeqNumber) FROM ${C}.Series_List WHERE BookID = b.BookID), 0)`,
        direction,
      };
    case 'author':
      return {
        expression: `IFNULL((SELECT a.SearchName FROM ${C}.Author_List al
                               JOIN ${C}.Authors a ON a.AuthorID = al.AuthorID
                              WHERE al.BookID = b.BookID ORDER BY al.OrdNum LIMIT 1), '')`,
        direction,
      };
    case 'series':
      return {
        expression: `IFNULL((SELECT s.SearchTitle FROM ${C}.Series_List sl
                               JOIN ${C}.Series s ON s.SeriesID = sl.SeriesID
                              WHERE sl.BookID = b.BookID ORDER BY sl.OrdNum LIMIT 1), '')`,
        direction,
      };
    case 'relevance':
    default:
      // Ранжировать по bm25 можно, только когда запрос — один текстовый предикат по
      // нашему индексу: при компаундах (INTERSECT/UNION) FTS-таблица во внешнем запросе
      // недоступна. В остальных случаях даём предсказуемый порядок по названию.
      return { expression: `IFNULL(b.SearchTitle, '')`, direction: 'ASC' };
  }
}

const TEXT_FIELDS = ['any', 'title', 'author', 'series', 'annotation', 'keyword'];

/**
 * Запрос, который можно отранжировать по релевантности: единственный текстовый предикат
 * по собственному индексу. Подстроки не в счёт — у триграммного индекса bm25 бессмысленен.
 */
type RankableTextPredicate = TextPredicate & { op: Exclude<TextPredicate['op'], 'substring'> };

function rankableTextPredicate(
  node: SearchNode,
  context: CompileContext,
): RankableTextPredicate | null {
  if (!context.useIndex) return null;
  if (isSearchGroup(node) || isSearchNot(node)) return null;

  const predicate = node as TextPredicate;
  if (!TEXT_FIELDS.includes(predicate.field) || predicate.op === 'substring') return null;

  return predicate as RankableTextPredicate;
}

/** Матч с bm25: тот же предикат, но множество несёт ещё и ранг. */
function compileRankedMatch(predicate: RankableTextPredicate): Fragment {
  const column = predicate.field === 'any' ? undefined : INDEX_COLUMNS[predicate.field];
  const query = buildIndexQuery(predicate.value, predicate.op, column);
  if (query === null) {
    throw new EmptyQueryError(`Пустой поисковый запрос по полю ${predicate.field}`);
  }

  // Веса колонок: совпадение в названии важнее, чем в аннотации.
  return {
    sql: `SELECT books_fts.rowid AS BookID, bm25(books_fts, 10.0, 8.0, 4.0, 2.0, 1.0) AS rank
            FROM books_fts WHERE books_fts MATCH ?`,
    params: [query],
  };
}

// --- публичный вход ----------------------------------------------------------

export function compileSearch(query: SearchQuery, context: CompileContext): CompiledSearch {
  const sortField = query.sort?.[0]?.field ?? 'relevance';
  const rankable = sortField === 'relevance' ? rankableTextPredicate(query.where, context) : null;

  const matched =
    rankable === null ? distinct(compileNode(query.where, context)) : compileRankedMatch(rankable);
  const sort = planSort(query.sort, rankable !== null);

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.min(Math.max(query.offset ?? 0, 0), MAX_OFFSET);

  // Условия видимости идут и в выдачу, и в подсчёт total; условие курсора — только в выдачу.
  const visibility = visibilityConditions(query.where, context);

  const cursor: Cursor | null = query.cursor ? decodeCursor(query.cursor) : null;
  const comparison = sort.direction === 'ASC' ? '>' : '<';
  const cursorParams: unknown[] = cursor ? [cursor.key, cursor.bookId] : [];

  // Ключ сортировки вычисляется во вложенном запросе, чтобы курсор сравнивался с
  // настоящей колонкой, а не с алиасом из списка выборки.
  // Колонки CTE зависят от того, несёт ли множество ранг bm25.
  const matchedColumns = rankable === null ? '(BookID)' : '(BookID, rank)';

  const sql = `
    WITH matched ${matchedColumns} AS (
      ${matched.sql}
    )
    SELECT * FROM (
      SELECT
        b.BookID           AS bookId,
        b.Title            AS title,
        b.Year             AS year,
        b.Lang             AS lang,
        b.Ext              AS ext,
        b.BookSize         AS size,
        b.LibRate          AS libRate,
        s.SeriesID         AS seriesId,
        s.SeriesTitle      AS seriesTitle,
        sl.SeqNumber       AS seqNumber,
        ${sort.expression} AS sortKey,
        (SELECT rate     FROM book_user_data WHERE user_id = :userId AND book_id = b.BookID) AS userRate,
        (SELECT favorite FROM book_user_data WHERE user_id = :userId AND book_id = b.BookID) AS favorite,
        (SELECT read     FROM book_user_data WHERE user_id = :userId AND book_id = b.BookID) AS isRead
      FROM ${C}.Books_View b
      JOIN matched m ON m.BookID = b.BookID
      LEFT JOIN ${C}.Series_List sl ON sl.BookID = b.BookID AND sl.OrdNum = 0
      LEFT JOIN ${C}.Series s ON s.SeriesID = sl.SeriesID
      ${visibility.length > 0 ? `WHERE ${visibility.join(' AND ')}` : ''}
    ) page
    ${cursor ? `WHERE (page.sortKey, page.bookId) ${comparison} (?, ?)` : ''}
    ORDER BY page.sortKey ${sort.direction}, page.bookId ${sort.direction}
    LIMIT ? OFFSET ?
  `;

  return {
    sql,
    params: [...matched.params, ...cursorParams, limit, offset],
    limit,
    sortKeyAlias: 'sortKey',
  };
}

/**
 * Запрос общего числа совпадений.
 *
 * Отдельно от выдачи, потому что это работа другого порядка: страница читает limit
 * строк, а total обязан пройти всё совпавшее множество. Ранг bm25 здесь не строится —
 * на множество он не влияет, а считать его для всех совпадений незачем.
 */
export function compileCount(
  query: SearchQuery,
  context: CompileContext,
): { sql: string; params: unknown[] } {
  const matched = distinct(compileNode(query.where, context));
  const visibility = visibilityConditions(query.where, context);

  return {
    sql: `
      WITH matched (BookID) AS (
        ${matched.sql}
      )
      SELECT count(*) AS total
        FROM ${C}.Books_View b
        JOIN matched m ON m.BookID = b.BookID
       ${visibility.length > 0 ? `WHERE ${visibility.join(' AND ')}` : ''}
    `,
    params: [...matched.params],
  };
}

function mentionsDeleted(node: SearchNode): boolean {
  if (isSearchGroup(node)) return node.nodes.some(mentionsDeleted);
  if (isSearchNot(node)) return mentionsDeleted(node.node);
  return (node as BoolPredicate).field === 'deleted';
}

/** Условия видимости — одинаковые для выдачи, total и фасетов. */
function visibilityConditions(where: SearchNode, context: CompileContext): string[] {
  // Скрытие удалённых — общая для всех выдач семантика (аналог Books_View_Opds).
  // Если пользователь явно спросил про удалённые, предикат уже это учёл.
  return context.hideDeleted && !mentionsDeleted(where) ? ['b.IsDeleted = 0'] : [];
}

// --- фасеты ------------------------------------------------------------------

/**
 * Дерево без предикатов по указанным полям плюс сами выброшенные предикаты.
 * `node: null` значит, что не осталось ничего, то есть фильтра нет и считать
 * надо по всей коллекции.
 *
 * Выкидываем только прямых потомков верхнего AND и сам верхний предикат. Внутри
 * OR и NOT предикат участвует в логике: убрав «или на английском», мы получили бы
 * не расширенное, а другое множество. Такие фасеты считаются по полному фильтру —
 * то есть могут схлопнуться до одного значения, и это честнее, чем врать счётчиком.
 */
function pruneFields(
  node: SearchNode,
  fields: string[],
): { node: SearchNode | null; dropped: SearchPredicate[] } {
  const isExcluded = (candidate: SearchNode): candidate is SearchPredicate =>
    !isSearchGroup(candidate) &&
    !isSearchNot(candidate) &&
    fields.includes((candidate as SearchPredicate).field);

  if (isExcluded(node)) return { node: null, dropped: [node] };

  if (isSearchGroup(node) && node.op === 'and') {
    const dropped = node.nodes.filter(isExcluded);
    if (dropped.length === 0) return { node, dropped };

    const kept = node.nodes.filter((child) => !isExcluded(child));
    if (kept.length === 0) return { node: null, dropped };
    return {
      node: kept.length === 1 ? (kept[0] as SearchNode) : { op: 'and', nodes: kept },
      dropped,
    };
  }

  return { node, dropped: [] };
}

/** Планы запросов счётчиков — по одному на каждое запрошенное поле. */
export function compileFacets(query: SearchQuery, context: CompileContext): FacetPlan[] {
  const fields = query.facets ?? [];
  if (fields.length === 0) return [];

  const visibility = visibilityConditions(query.where, context);

  return fields.map((field) => {
    const spec = FACET_SPECS[field];
    const pruned = pruneFields(query.where, spec.excludes);
    const matched: Fragment =
      pruned.node === null
        ? { sql: ALL_BOOKS, params: [] }
        : distinct(compileNode(pruned.node, context));

    return {
      field,
      spec,
      matched,
      visibility,
      // Уже выбранные значения — из тех предикатов, которые для этого фасета сняты.
      pinned: normalizePinned(
        field,
        pruned.dropped.flatMap((predicate) =>
          'values' in predicate ? (predicate.values as unknown[]) : [],
        ),
      ),
    };
  });
}
