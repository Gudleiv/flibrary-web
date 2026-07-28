// Состояние поиска: форма ⇄ URL ⇄ дерево предикатов.
//
// Состояние живёт в URL, чтобы поиском можно было поделиться ссылкой и вернуться к нему
// кнопкой «назад». Форма — упрощённое представление; наружу всегда уходит полноценное
// дерево предикатов из контракта, так что конструктор сложных запросов потом ложится
// сюда же без смены API.
//
// Отправленный запрос — это ровно то, что записано в URL (`applied`), а не отдельная
// копия состояния. Иначе после «назад» URL и выдача расходятся: адрес показывает старый
// поиск, а на экране висит то, что было отправлено последним.

import { computed, reactive, watch } from 'vue';
import type { FacetField, SearchNode, SearchQuery, SortSpec } from '@flibrary/contract';
import { useRoute, useRouter } from 'vue-router';

export interface SearchForm {
  /** Отдельные поля, а не «строка + где искать»: так спрашивают в девяти случаях из десяти. */
  title: string;
  author: string;
  languages: string[];
  genres: string[];
  /** Расширения без точки — как их отдаёт фасет. */
  exts: string[];
  authors: number[];
  series: number[];
  yearFrom: number | null;
  yearTo: number | null;
  sortField: SortSpec['field'];
  sortDir: 'asc' | 'desc';
  /** Номер страницы, с единицы: он же в URL, поэтому «назад» возвращает на неё же. */
  page: number;
  perPage: number;
}

/**
 * Фасеты, которые показывает панель уточнения. Каждый — отдельный GROUP BY по всему
 * совпавшему множеству, поэтому список осознанно короткий: просим только то, что рисуем.
 */
export const PANEL_FACETS: FacetField[] = ['genre', 'author', 'series', 'lang', 'year', 'ext'];

/** Ограничено сверху контрактом: limit больше 200 API не принимает. */
export const PER_PAGE_OPTIONS = [20, 50, 100, 200];

const DEFAULT_PER_PAGE = 50;

export const createEmptyForm = (): SearchForm => ({
  title: '',
  author: '',
  languages: [],
  genres: [],
  exts: [],
  authors: [],
  series: [],
  yearFrom: null,
  yearTo: null,
  sortField: 'relevance',
  sortDir: 'desc',
  page: 1,
  perPage: DEFAULT_PER_PAGE,
});

/** Форма → дерево предикатов. */
function buildWhere(form: SearchForm): SearchNode {
  const nodes: SearchNode[] = [];

  // Два поля — два независимых предиката, объединённых `and`: «Стругацкие» в поле
  // автора и «Пикник» в поле названия должны сойтись на одной книге, а не дать
  // объединение двух выдач.
  if (form.title.trim() !== '') {
    nodes.push({ field: 'title', op: 'prefix', value: form.title.trim() });
  }
  if (form.author.trim() !== '') {
    nodes.push({ field: 'author', op: 'prefix', value: form.author.trim() });
  }
  if (form.languages.length > 0) {
    nodes.push({ field: 'lang', op: 'in', values: form.languages });
  }
  if (form.genres.length > 0) {
    nodes.push({ field: 'genre', op: 'in', values: form.genres, includeChildren: true });
  }
  if (form.exts.length > 0) {
    nodes.push({ field: 'ext', op: 'in', values: form.exts });
  }
  if (form.authors.length > 0) {
    nodes.push({ field: 'authorId', op: 'in', values: form.authors });
  }
  if (form.series.length > 0) {
    nodes.push({ field: 'seriesId', op: 'in', values: form.series });
  }
  if (form.yearFrom !== null || form.yearTo !== null) {
    nodes.push({ field: 'year', op: 'range', from: form.yearFrom, to: form.yearTo });
  }

  // Пустая форма — это «показать всё»: предикат, который заведомо истинен.
  return nodes.length === 0
    ? { field: 'deleted', op: 'eq', value: false }
    : nodes.length === 1
      ? (nodes[0] as SearchNode)
      : { op: 'and', nodes };
}

/**
 * Запрос страницы выдачи. Без `withTotal` и без фасетов: и то, и другое — проход по
 * всему совпавшему множеству, а страница читает только свои строки.
 */
export function buildQuery(form: SearchForm): SearchQuery {
  return {
    where: buildWhere(form),
    sort: [{ field: form.sortField, dir: form.sortDir }],
    limit: form.perPage,
    // Страница берётся пропуском, а не курсором: по номерам страниц курсором не попасть.
    offset: (form.page - 1) * form.perPage,
  };
}

/**
 * Запрос счётчиков и общего числа совпадений.
 *
 * В нём осознанно нет ни сортировки, ни страницы: цифры от них не зависят. Отсюда и
 * выигрыш — ключ такого запроса не меняется при листании и смене сортировки, поэтому
 * ни клиентский кэш, ни сервер их не пересчитывают.
 */
export function buildFacetQuery(form: SearchForm): SearchQuery {
  return { where: buildWhere(form), facets: PANEL_FACETS };
}

const LIST_SEPARATOR = ',';

function toQueryParams(form: SearchForm): Record<string, string> {
  const params: Record<string, string> = {};
  const empty = createEmptyForm();

  if (form.title !== empty.title) params.title = form.title;
  // `by`, а не `author`: `author` уже занят списком идентификаторов авторов, выбранных
  // в панели уточнения, и переименовать его — сломать уже разосланные ссылки.
  if (form.author !== empty.author) params.by = form.author;
  if (form.languages.length > 0) params.lang = form.languages.join(LIST_SEPARATOR);
  if (form.genres.length > 0) params.genre = form.genres.join(LIST_SEPARATOR);
  if (form.exts.length > 0) params.ext = form.exts.join(LIST_SEPARATOR);
  if (form.authors.length > 0) params.author = form.authors.join(LIST_SEPARATOR);
  if (form.series.length > 0) params.series = form.series.join(LIST_SEPARATOR);
  if (form.yearFrom !== null) params.from = String(form.yearFrom);
  if (form.yearTo !== null) params.to = String(form.yearTo);
  if (form.sortField !== empty.sortField) params.sort = form.sortField;
  if (form.sortDir !== empty.sortDir) params.dir = form.sortDir;
  if (form.page !== empty.page) params.page = String(form.page);
  if (form.perPage !== empty.perPage) params.per = String(form.perPage);

  return params;
}

function fromQueryParams(query: Record<string, unknown>): SearchForm {
  const string = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' ? value : undefined;
  };
  const number = (key: string): number | null => {
    const raw = string(key);
    if (raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const list = (key: string): string[] => string(key)?.split(LIST_SEPARATOR).filter(Boolean) ?? [];
  // Идентификаторы из URL могут быть любым мусором: нечисловое просто игнорируем.
  const ids = (key: string): number[] =>
    list(key)
      .map(Number)
      .filter((value) => Number.isInteger(value));

  const form = createEmptyForm();
  const page = number('page');
  const perPage = number('per');

  // Ссылки со старой формой поиска («строка + где искать») открываться должны, поэтому
  // `q`/`in` продолжаем читать. `in=author` уходит в поле автора, всё остальное — в поле
  // названия: поиска по аннотации и ключевым словам в форме больше нет, и честнее сузить
  // запрос до названия, чем молча вернуть не то, что искали.
  const legacy = string('q');
  const legacyByAuthor = legacy !== undefined && string('in') === 'author';

  return {
    ...form,
    title: string('title') ?? (legacyByAuthor ? form.title : (legacy ?? form.title)),
    author: string('by') ?? (legacyByAuthor ? legacy : form.author),
    languages: list('lang'),
    genres: list('genre'),
    exts: list('ext'),
    authors: ids('author'),
    series: ids('series'),
    yearFrom: number('from'),
    yearTo: number('to'),
    sortField: (string('sort') as SortSpec['field'] | undefined) ?? form.sortField,
    sortDir: string('dir') === 'asc' ? 'asc' : form.sortDir,
    // Страница из URL — тоже пользовательский ввод: отрицательная или дробная дала бы
    // отрицательный offset и 400 от API.
    page: page !== null && Number.isInteger(page) && page > 0 ? page : form.page,
    perPage: perPage !== null && PER_PAGE_OPTIONS.includes(perPage) ? perPage : form.perPage,
  };
}

/** Канонический вид параметров — чтобы сравнивать URL, а не порядок ключей в нём. */
const canonical = (params: Record<string, string>): string =>
  JSON.stringify(Object.entries(params).sort());

export function useSearchState() {
  const route = useRoute();
  const router = useRouter();

  /** Черновик фильтров: правки в полях не дёргают сервер, пока не нажали «Найти». */
  const form = reactive<SearchForm>(fromQueryParams(route.query));

  /** Что реально отправлено. URL — источник истины и при навигации «назад/вперёд». */
  const applied = computed<SearchForm>(() => fromQueryParams(route.query));

  /** Последняя наша запись в URL: свои изменения черновик не перетирают. */
  let lastWritten: string | null = null;

  function write(next: SearchForm): void {
    const params = toQueryParams(next);
    lastWritten = canonical(params);
    // replace, чтобы правка фильтров и листание не забивали историю: «назад» должен
    // возвращать к предыдущему экрану, а не отматывать поиск по одному фильтру.
    void router.replace({ query: params });
  }

  watch(
    () => route.query,
    (query) => {
      // Синхронизируем черновик только с чужими изменениями URL — «назад», «вперёд»,
      // открытая ссылка. Иначе смена сортировки или страницы стёрла бы то, что
      // пользователь уже набрал в фильтрах, но ещё не отправил.
      if (canonical(toQueryParams(fromQueryParams(query))) === lastWritten) return;
      Object.assign(form, fromQueryParams(query));
    },
  );

  const query = computed<SearchQuery>(() => buildQuery(applied.value));
  const facetQuery = computed<SearchQuery>(() => buildFacetQuery(applied.value));

  /**
   * Применить черновик — всегда с первой страницы: на новой выдаче старый номер
   * страницы может оказаться за её концом.
   */
  function submit(): void {
    // Из черновика берём только фильтры: сортировка и размер страницы применяются
    // сразу и живут в применённом состоянии, копия в черновике была бы устаревшей.
    const { sortField, sortDir, perPage } = applied.value;
    write({ ...form, sortField, sortDir, perPage, page: 1 });
  }

  /**
   * Точечно поменять уже применённый запрос — сортировку или страницу. Черновик
   * фильтров при этом не применяется: смена сортировки не должна отправлять то,
   * что пользователь ещё набирает.
   */
  function apply(patch: Partial<SearchForm>): void {
    write({ ...applied.value, ...patch });
  }

  return { form, applied, query, facetQuery, submit, apply };
}
