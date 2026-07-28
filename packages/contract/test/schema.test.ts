// Извлечённая из openapi.yaml схема поискового запроса.
//
// На ней держится инвариант «контракт — источник истины»: этой же схемой Fastify
// валидирует тело `POST /search` в рантайме. Если извлечение отстанет от спеки —
// сервер начнёт принимать не то, что описано, и разойдётся с клиентом молча.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { searchQuerySchema } from '../src/index.js';

const spec = parse(readFileSync(join(import.meta.dirname, '../openapi.yaml'), 'utf8')) as {
  components: { schemas: Record<string, unknown> };
};

/** Все `$ref` в поддереве — чтобы проверить, что схема замкнута сама на себе. */
function refsOf(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) refsOf(item, found);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else refsOf(value, found);
    }
  }
  return found;
}

describe('схема поискового запроса', () => {
  it('замкнута: все ссылки указывают внутрь самой схемы', () => {
    // Ajv на сервере грузит её одну, без остального openapi.yaml: ссылка наружу
    // означала бы падение на старте вместо валидации.
    const defs = new Set(Object.keys(searchQuerySchema.$defs ?? {}));

    for (const ref of refsOf(searchQuerySchema)) {
      expect(ref.startsWith('#/$defs/'), `ссылка наружу: ${ref}`).toBe(true);
      expect(defs.has(ref.slice('#/$defs/'.length)), `нет определения: ${ref}`).toBe(true);
    }
  });

  it('перенесла из спеки корень SearchQuery целиком', () => {
    const source = spec.components.schemas.SearchQuery as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };

    expect(searchQuerySchema.required).toEqual(source.required);
    expect(searchQuerySchema.additionalProperties).toBe(source.additionalProperties);
    expect(Object.keys(searchQuerySchema.properties)).toEqual(Object.keys(source.properties));
  });

  it('тянет за собой всё дерево предикатов', () => {
    // Дерево рекурсивное, и потерянная ветка проявилась бы не на старте, а на
    // первом же сложном запросе пользователя.
    const defs = Object.keys(searchQuerySchema.$defs ?? {});

    expect(defs).toEqual(
      expect.arrayContaining([
        'SearchNode',
        'SearchGroup',
        'SearchNot',
        'SearchPredicate',
        'TextPredicate',
        'TermPredicate',
        'NumberPredicate',
        'RangePredicate',
        'IdPredicate',
        'BoolPredicate',
        'TextField',
        'TermField',
        'NumberField',
        'IdField',
        'BoolField',
        'FacetField',
        'SortSpec',
      ]),
    );
  });

  it('объявлена как JSON Schema 2020-12', () => {
    // Не косметика: Fastify по умолчанию идёт с Ajv 8 и draft-07, и сервер
    // специально поднимает Ajv2020 ради этой схемы.
    expect(searchQuerySchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });
});
