// Выполнение планов фасетов.
//
// Посчитать фасет — это пройти всё совпавшее множество, а не страницу выдачи,
// поэтому здесь два приёма против лишней работы.
//
// 1. Общее множество hits материализуется во временную таблицу, когда фасетов с
//    одним и тем же множеством больше одного (а так обычно и есть: разное
//    множество только у тех, чей собственный фильтр снят). Замер на фикстуре в
//    50 000 книг, шесть фасетов панели:
//
//                              подзапросом в каждом    общая таблица
//      вся коллекция (50 000)        322 мс             36 + 133 мс
//      текстовый запрос (1 901)       19 мс              3 +   6 мс
//
//    Временная таблица живёт в temp-БД соединения, а не в коллекции: флаг
//    READONLY её не запрещает, а коллекция остаётся нетронутой — попытка записи
//    в coll.* упала бы сразу.
//
// 2. Кэш в app.db. Ключ — сам запрос счётчиков, поэтому смена сортировки или
//    переход на следующую страницу попадают в уже посчитанное.

import type { Database as Db } from 'better-sqlite3';
import type { Facet, FacetField } from '@flibrary/contract';

import type { QueryCache } from '../cache/queries.js';
import { facetQuery, hitsSql, toFacet, type FacetPlan, type FacetRow } from './facets.js';

/** Имя без префикса temp. нужно для CREATE, с префиксом — для запросов. */
const HITS = 'facet_hits';

export function runFacets(db: Db, plans: FacetPlan[], userId: number, cache: QueryCache): Facet[] {
  if (plans.length === 0) return [];

  const computed = new Map<FacetField, Facet>();

  // Ключ кэша — всё, от чего зависит цифра: множество, закреплённые значения,
  // видимость и пользователь (у favorite/read/userRate данные свои у каждого).
  const cacheKeys = new Map<FacetField, string>(
    plans.map((plan) => [
      plan.field,
      cache.key([
        plan.field,
        plan.matched.sql,
        plan.matched.params,
        plan.pinned,
        plan.visibility,
        userId,
      ]),
    ]),
  );

  const pending: FacetPlan[] = [];
  for (const plan of plans) {
    const cached = cache.get<Facet>(cacheKeys.get(plan.field) as string);
    if (cached === null) pending.push(plan);
    else computed.set(plan.field, cached);
  }

  // Группируем по множеству книг: считать вместе имеет смысл только одинаковые.
  // Видимость входит в ключ, потому что она часть материализуемого множества.
  const groups = new Map<string, FacetPlan[]>();
  for (const plan of pending) {
    const key = JSON.stringify([plan.matched.sql, plan.matched.params, plan.visibility]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [plan]);
    else group.push(plan);
  }

  for (const group of groups.values()) {
    // Материализация окупается со второго фасета: для одного лишняя таблица —
    // это лишний проход.
    const shared = group.length > 1;
    const first = group[0] as FacetPlan;

    if (shared) materialize(db, first, userId);

    try {
      for (const plan of group) {
        const query = facetQuery(
          plan,
          shared ? { kind: 'table', name: `temp.${HITS}` } : { kind: 'inline' },
        );
        const rows = db.prepare(query.sql).all(query.params, { userId }) as FacetRow[];
        const facet = toFacet(plan, rows, missingSelected(db, plan, rows));
        computed.set(plan.field, facet);
        cache.set(cacheKeys.get(plan.field) as string, facet);
      }
    } finally {
      if (shared) db.exec(`DROP TABLE IF EXISTS temp.${HITS}`);
    }
  }

  // Порядок ответа — порядок запрошенных полей.
  return plans.map((plan) => computed.get(plan.field) as Facet);
}

/**
 * Выбранные значения, которых в счётчиках не оказалось, — со счётчиком 0.
 *
 * Уточнения не сбрасываются при новом поиске, и без этого выбранный автор
 * пропадал бы из панели ровно тогда, когда выдача из-за него и опустела: снять
 * фильтр стало бы нечем. Подписи приходится доставать отдельным запросом — в
 * счётчиках этих значений нет, а идентификатор пользователю ни о чём не говорит.
 */
function missingSelected(db: Db, plan: FacetPlan, rows: FacetRow[]): FacetRow[] {
  if (plan.pinned.length === 0) return [];

  // Сравниваем с тем, что переживёт обрезание по лимиту: закреплённые значения
  // стоят в начале, но их самих может оказаться больше лимита.
  const present = new Set(rows.slice(0, plan.spec.limit).map((row) => row.value));
  const missing = plan.pinned.filter((value) => !present.has(value));
  if (missing.length === 0) return [];

  const labels = new Map<string, string | null>();
  const lookup = plan.spec.lookup;
  if (lookup !== null) {
    for (const row of db.prepare(lookup(missing.length)).all(missing) as FacetRow[]) {
      if (row.value !== null) labels.set(row.value, row.label);
    }
  }

  return missing.map((value) => ({ value, label: labels.get(value) ?? null, count: 0 }));
}

function materialize(db: Db, plan: FacetPlan, userId: number): void {
  db.exec(`DROP TABLE IF EXISTS temp.${HITS}`);
  // Индекс таблице не нужен: по ней идут только полные проходы, а связки
  // ищутся по своим индексам (BookID, ключ).
  db.prepare(`CREATE TEMP TABLE ${HITS} AS ${hitsSql(plan)}`).run(plan.matched.params, { userId });
}
