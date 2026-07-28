// Фасеты: счётчики значений по отфильтрованному множеству книг.
//
// Здесь описание измерений и сборка запросов; само множество книг собирает
// компилятор (compile.ts) — фасеты считаются ровно по тому же дереву предикатов,
// что и выдача, иначе счётчики разошлись бы с результатами.
//
// Три решения, из которых всё остальное следует.
//
// 1. Фасет не сужает сам себя. При подсчёте фасета из фильтра выкидываются
//    предикаты по его же полю: выбрав язык «ru», пользователь должен по-прежнему
//    видеть, сколько книг в «en», иначе список схлопнется в одно значение и
//    множественный выбор станет бесполезен. Так работает фасетная навигация
//    везде — и это единственная причина, по которой у каждого фасета может быть
//    своё множество, а не одно общее.
//    Исключение — жанр: у книги их несколько, и выбранные жанры складываются по
//    AND, а не по ИЛИ (см. excludes у genre). Тогда правило переворачивается:
//    считать надо ровно по тому, что уже отфильтровано, иначе счётчик обещает
//    «фэнтези 5000», а щелчок по нему даёт полсотни детских фэнтези.
// 2. Отдаём топ-N по количеству, а не все значения. Авторов и серий в выдаче
//    могут быть тысячи; полный список никто не читает, а стоит он дорого.
//    Обрезание не замалчиваем — в ответе есть truncated.
// 3. Все запросы пишутся против одного отношения hits — «совпавшие книги плюс их
//    скалярные признаки». Тогда одно и то же выражение работает и когда hits это
//    подзапрос, и когда оно материализовано во временную таблицу на несколько
//    фасетов сразу (см. runFacets), — а язык, формат, год и рейтинг считаются
//    вообще без обращения к коллекции.

import type { Facet, FacetField, FacetValue } from '@flibrary/contract';

import { COLLECTION as C } from '../db/index.js';
import { displayAuthorName, GENRE_LABEL } from '../db/labels.js';

/** Сколько значений отдаём по умолчанию. */
const TOP_LIMIT = 20;

/**
 * Год и рейтинг — шкалы: их показывают гистограммой, поэтому значений берём
 * заметно больше и отдаём в порядке значения, а не количества.
 */
const SCALE_LIMIT = 200;

export interface FacetSpec {
  /** SQL-выражение значения относительно hits (алиас h); в ответе оно всегда строка. */
  value: string;
  /** SQL-выражение подписи или null, если значение говорит само за себя. */
  label: string | null;
  /** Связки, которые нужно присоединить к hits. */
  joins: string;
  /** Условие сверх видимости: отсекает «значение неизвестно». */
  where: string | null;
  groupBy: string;
  /** Тай-брейк после `count DESC` — без него порядок равных счётчиков не определён. */
  tieBreak: string;
  limit: number;
  /** Порядок отдачи: по количеству (топ) или по значению (шкала). */
  present: 'count' | 'value';
  /**
   * Поля предикатов, которые выкидываются из фильтра при подсчёте этого фасета
   * (см. решение 1 в шапке файла).
   */
  excludes: string[];
  /**
   * Запрос подписей для выбранных значений, под которые не попало ни одной книги:
   * `SELECT значение, подпись ... WHERE значение IN (?, ?, …)`.
   *
   * Такое значение всё равно надо показать (со счётчиком 0) — иначе выбранный
   * автор пропадает из панели ровно тогда, когда выдача из-за него и опустела,
   * и снять фильтр становится нечем. null — значение говорит само за себя.
   */
  lookup: ((count: number) => string) | null;
}

const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

/** ФИО одной строкой — в коллекции оно разложено на три колонки. */
const AUTHOR_LABEL = `trim(a.LastName || ' ' || coalesce(a.FirstName, '') || ' ' || coalesce(a.MiddleName, ''))`;

/**
 * CROSS JOIN здесь — не декартово произведение, а указание планировщику: внешним
 * циклом идёт hits (уже отфильтрованное множество), а связка ищется по индексу
 * (BookID, ключ). Без этого SQLite для временной таблицы, о размере которой он
 * ничего не знает, выбирает обратный порядок и сканирует всю коллекцию.
 */
export const FACET_SPECS: Record<FacetField, FacetSpec> = {
  lang: {
    value: 'h.lang',
    label: null,
    joins: '',
    where: `h.lang IS NOT NULL AND h.lang <> ''`,
    groupBy: 'h.lang',
    tieBreak: 'value',
    limit: TOP_LIMIT,
    present: 'count',
    excludes: ['lang'],
    lookup: null,
  },
  ext: {
    value: 'h.ext',
    label: null,
    joins: '',
    where: `h.ext IS NOT NULL AND h.ext <> ''`,
    groupBy: 'h.ext',
    tieBreak: 'value',
    limit: TOP_LIMIT,
    present: 'count',
    excludes: ['ext'],
    lookup: null,
  },
  genre: {
    value: 'gl.GenreCode',
    label: GENRE_LABEL,
    // LEFT JOIN на справочник: жанр, которого в нём нет, всё равно надо показать —
    // иначе часть книг просто пропадёт из счётчиков.
    joins: `CROSS JOIN ${C}.Genre_List gl ON gl.BookID = h.BookID
            LEFT JOIN ${C}.Genres g ON g.GenreCode = gl.GenreCode`,
    where: null,
    groupBy: 'gl.GenreCode',
    tieBreak: 'value',
    limit: TOP_LIMIT,
    present: 'count',
    // Единственный фасет, который сужает сам себя (см. решение 1 в шапке файла):
    // жанров у книги несколько, выбранные складываются по AND, и «какие ещё жанры
    // есть у найденного» — это счётчики по уже отфильтрованному множеству.
    excludes: [],
    // Закреплять здесь нечего: выбранный жанр из фильтра не выкидывается, поэтому
    // либо он есть у найденных книг, либо не найдено ничего вовсе. Подписи жанров
    // клиент знает сам — он держит весь справочник ради дерева выбора.
    lookup: null,
  },
  year: {
    value: 'CAST(h.year AS TEXT)',
    label: null,
    joins: '',
    // Год 0 в коллекции означает «неизвестен», а не первый век.
    where: 'h.year IS NOT NULL AND h.year > 0',
    groupBy: 'h.year',
    tieBreak: 'h.year DESC',
    limit: SCALE_LIMIT,
    present: 'value',
    excludes: ['year'],
    lookup: null,
  },
  libRate: {
    value: 'CAST(h.libRate AS TEXT)',
    label: null,
    joins: '',
    // 0 — «не оценено».
    where: 'h.libRate IS NOT NULL AND h.libRate > 0',
    groupBy: 'h.libRate',
    tieBreak: 'h.libRate DESC',
    limit: SCALE_LIMIT,
    present: 'value',
    excludes: ['libRate'],
    lookup: null,
  },
  author: {
    // Значение — идентификатор: имена не уникальны, а вернуть значение фасета
    // в запрос надо однозначно (предикат authorId).
    value: 'CAST(a.AuthorID AS TEXT)',
    label: AUTHOR_LABEL,
    joins: `CROSS JOIN ${C}.Author_List al ON al.BookID = h.BookID
            JOIN ${C}.Authors a ON a.AuthorID = al.AuthorID`,
    where: null,
    groupBy: 'a.AuthorID',
    tieBreak: 'label',
    limit: TOP_LIMIT,
    present: 'count',
    // Текстовый предикат author не выкидываем: это поисковый запрос, а не выбор
    // значения фасета — сузить выдачу он должен и для счётчиков тоже.
    excludes: ['authorId'],
    // Идентификатор приходит строкой, а колонка числовая — сравнение отрабатывает
    // по affinity колонки, поэтому индекс по AuthorID остаётся в деле.
    lookup: (count) =>
      `SELECT CAST(a.AuthorID AS TEXT) AS value, ${AUTHOR_LABEL} AS label
         FROM ${C}.Authors a
        WHERE a.AuthorID IN (${placeholders(count)})`,
  },
  series: {
    value: 'CAST(s.SeriesID AS TEXT)',
    label: 's.SeriesTitle',
    joins: `CROSS JOIN ${C}.Series_List sl ON sl.BookID = h.BookID
            JOIN ${C}.Series s ON s.SeriesID = sl.SeriesID`,
    where: null,
    groupBy: 's.SeriesID',
    tieBreak: 'label',
    limit: TOP_LIMIT,
    present: 'count',
    excludes: ['seriesId'],
    lookup: (count) =>
      `SELECT CAST(s.SeriesID AS TEXT) AS value, s.SeriesTitle AS label
         FROM ${C}.Series s
        WHERE s.SeriesID IN (${placeholders(count)})`,
  },
};

/** План подсчёта одного фасета: множество книг плюс всё, что нужно для запроса. */
export interface FacetPlan {
  field: FacetField;
  spec: FacetSpec;
  /** Запрос множества книг; обязан отдавать BookID без дублей. */
  matched: { sql: string; params: unknown[] };
  visibility: string[];
  /** Уже выбранные значения — закрепляются в начале списка. */
  pinned: string[];
}

/**
 * Откуда брать hits: подзапросом прямо здесь или из временной таблицы, куда оно
 * уже материализовано для нескольких фасетов сразу (см. runFacets).
 */
export type FacetSource = { kind: 'inline' } | { kind: 'table'; name: string };

/**
 * Совпавшие книги вместе со скалярными признаками.
 *
 * Скалярные измерения вытаскиваются здесь один раз, поэтому фасеты по языку,
 * формату, году и рейтингу дальше не трогают коллекцию вообще.
 */
export function hitsSql(plan: FacetPlan): string {
  return `
    SELECT b.BookID          AS BookID,
           b.Lang            AS lang,
           ltrim(b.Ext, '.') AS ext,
           b.Year            AS year,
           b.LibRate         AS libRate
      FROM ${C}.Books_View b
      JOIN (${plan.matched.sql}) m ON m.BookID = b.BookID
     ${plan.visibility.length > 0 ? `WHERE ${plan.visibility.join(' AND ')}` : ''}
  `;
}

/**
 * Значения, выбранные пользователем, приводим к тому виду, в котором фасет их
 * отдаёт: иначе выбранное значение не совпадёт с собственным счётчиком.
 */
export function normalizePinned(field: FacetField, values: unknown[]): string[] {
  return values.map((value) => {
    const text = String(value);
    // Ext в предикате допускается и с точкой, и без; фасет отдаёт без.
    return field === 'ext' && text.startsWith('.') ? text.slice(1) : text;
  });
}

/**
 * Запрос счётчиков.
 *
 * Множество обязано быть без дублей: связки *_List имеют уникальный индекс по
 * (BookID, ключ), поэтому на дедуплицированном множестве count(*) — это ровно
 * число книг, а не число пар «книга — значение».
 *
 * Закреплённые значения (`plan.pinned`) уходят в начало списка: без этого выбор
 * редкого автора выпал бы из топ-20 и снять фильтр в интерфейсе стало бы нечем.
 */
export function facetQuery(
  plan: FacetPlan,
  source: FacetSource,
): { sql: string; params: unknown[] } {
  const { spec } = plan;
  const pin =
    plan.pinned.length > 0
      ? `CASE WHEN ${spec.value} IN (${plan.pinned.map(() => '?').join(', ')}) THEN 0 ELSE 1 END, `
      : '';

  const inline = source.kind === 'inline';
  const sql = `
    ${inline ? `WITH hits AS (${hitsSql(plan)})` : ''}
    SELECT ${spec.value} AS value,
           ${spec.label ?? 'NULL'} AS label,
           count(*) AS count
      FROM ${inline ? 'hits' : source.name} h
      ${spec.joins}
     ${spec.where === null ? '' : `WHERE ${spec.where}`}
     GROUP BY ${spec.groupBy}
     ORDER BY ${pin}count DESC, ${spec.tieBreak}
     LIMIT ?
  `;

  return {
    sql,
    // Порядок биндинга — порядок появления «?» в тексте запроса.
    params: [
      ...(inline ? plan.matched.params : []),
      ...plan.pinned,
      // На одно значение больше лимита — чтобы отличить «ровно N» от «больше N».
      spec.limit + 1,
    ],
  };
}

export interface FacetRow {
  value: string | null;
  label: string | null;
  count: number;
}

function toValue(field: FacetField, row: FacetRow & { value: string }): FacetValue {
  // Подпись автора приводим к тому же виду, что и в карточке книги: иначе в панели
  // уточнения стоял бы «Unknown author», а в выдаче — «Неизвестный автор».
  const label = field === 'author' ? displayAuthorName(row.label) : row.label;
  return {
    value: row.value,
    // Подпись отдаём только когда она отличается от значения: для языка и
    // расширения дублировать её в JSON незачем.
    ...(label === null || label === row.value ? {} : { label }),
    count: row.count,
  };
}

/**
 * Строки из БД → фасет контракта.
 *
 * Запрашивается на одну строку больше лимита: лишняя строка и есть признак того,
 * что значений больше, чем отдано.
 *
 * `selected` — выбранные значения, которых в счётчиках не оказалось: они идут в
 * начало со счётчиком 0 и на признак обрезания не влияют, потому что не из выдачи.
 */
export function toFacet(plan: FacetPlan, rows: FacetRow[], selected: FacetRow[] = []): Facet {
  const { field, spec } = plan;
  const truncated = rows.length > spec.limit;
  const values: FacetValue[] = rows
    .slice(0, spec.limit)
    .filter((row): row is FacetRow & { value: string } => row.value !== null)
    .map((row) => toValue(field, row));

  if (spec.present === 'value') {
    values.sort((left, right) => Number(right.value) - Number(left.value));
  }

  const missing = selected
    .filter((row): row is FacetRow & { value: string } => row.value !== null)
    .map((row) => toValue(field, row));

  return { field, values: [...missing, ...values], truncated };
}
