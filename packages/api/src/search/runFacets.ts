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
        const facet = toFacet(plan, rows);
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

function materialize(db: Db, plan: FacetPlan, userId: number): void {
  db.exec(`DROP TABLE IF EXISTS temp.${HITS}`);
  // Индекс таблице не нужен: по ней идут только полные проходы, а связки
  // ищутся по своим индексам (BookID, ключ).
  db.prepare(`CREATE TEMP TABLE ${HITS} AS ${hitsSql(plan)}`).run(plan.matched.params, { userId });
}
