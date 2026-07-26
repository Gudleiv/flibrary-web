// Единая точка входа контракта.
//
// Источник истины — openapi.yaml. Из него генерируются (`pnpm --filter @flibrary/contract build`):
//   src/generated/openapi.d.ts            — типы путей и схем
//   src/generated/search-query.schema.json — standalone JSON Schema для валидации в рантайме
// Сгенерированное не коммитится, поэтому перед typecheck-ом api и web соберите этот пакет.

import searchQuerySchema from './generated/search-query.schema.json' with { type: 'json' };
import type { components } from './generated/openapi.js';

export type { paths, components, operations } from './generated/openapi.js';

/** JSON Schema поискового запроса — для Ajv на сервере. */
export { searchQuerySchema };

type Schemas = components['schemas'];

// Удобные псевдонимы: в коде хочется писать SearchQuery, а не components['schemas']['SearchQuery'].
export type SearchQuery = Schemas['SearchQuery'];
export type SearchNode = Schemas['SearchNode'];
export type SearchGroup = Schemas['SearchGroup'];
export type SearchNot = Schemas['SearchNot'];
export type SearchPredicate = Schemas['SearchPredicate'];
export type TextPredicate = Schemas['TextPredicate'];
export type TermPredicate = Schemas['TermPredicate'];
export type NumberPredicate = Schemas['NumberPredicate'];
export type RangePredicate = Schemas['RangePredicate'];
export type IdPredicate = Schemas['IdPredicate'];
export type BoolPredicate = Schemas['BoolPredicate'];
export type TextField = Schemas['TextField'];
export type TermField = Schemas['TermField'];
export type NumberField = Schemas['NumberField'];
export type IdField = Schemas['IdField'];
export type BoolField = Schemas['BoolField'];
export type FacetField = Schemas['FacetField'];
export type SortSpec = Schemas['SortSpec'];

export type SearchResult = Schemas['SearchResult'];
export type SearchFacets = Schemas['SearchFacets'];
export type BookListItem = Schemas['BookListItem'];
export type BookDetail = Schemas['BookDetail'];
export type AuthorRef = Schemas['AuthorRef'];
export type SeriesRef = Schemas['SeriesRef'];
export type GenreRef = Schemas['GenreRef'];
export type Genre = Schemas['Genre'];
export type Facet = Schemas['Facet'];
export type FacetValue = Schemas['FacetValue'];
export type Suggestion = Schemas['Suggestion'];
export type CollectionInfo = Schemas['CollectionInfo'];
export type LanguageCount = Schemas['LanguageCount'];
export type User = Schemas['User'];
export type Problem = Schemas['Problem'];

export function isSearchGroup(node: SearchNode): node is SearchGroup {
  return node.op === 'and' || node.op === 'or';
}

export function isSearchNot(node: SearchNode): node is SearchNot {
  return node.op === 'not';
}

export function isSearchPredicate(node: SearchNode): node is SearchPredicate {
  return !isSearchGroup(node) && !isSearchNot(node);
}

/** Простой текстовый запрос — тот же контракт, что и у сложного. */
export function textQuery(value: string, overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    where: { field: 'any', op: 'match', value },
    ...overrides,
  };
}

/** Дефолты запроса. Схема их не задаёт, чтобы поля оставались необязательными для клиента. */
export const SEARCH_DEFAULTS = {
  limit: 50,
  sort: [{ field: 'relevance', dir: 'desc' }],
  withTotal: true,
} as const satisfies Partial<SearchQuery>;
