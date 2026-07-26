#!/usr/bin/env node
// Извлекает из openapi.yaml standalone JSON Schema поискового запроса для валидации в рантайме.
//
// Зачем: контракт должен быть в одном месте. OpenAPI 3.1 — это JSON Schema 2020-12,
// поэтому схему достаточно описать в openapi.yaml, а здесь мы её просто вырезаем
// вместе с зависимостями и переписываем ссылки #/components/schemas/X → #/$defs/X.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_SCHEMA = 'SearchQuery';

const spec = parse(readFileSync(join(packageRoot, 'openapi.yaml'), 'utf8'));
const schemas = spec.components?.schemas;
if (!schemas?.[ROOT_SCHEMA]) {
  throw new Error(`В openapi.yaml нет components.schemas.${ROOT_SCHEMA}`);
}

const REF_PREFIX = '#/components/schemas/';

/** Собирает имена схем, достижимых из корневой по $ref. */
function collectDependencies(name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (!value.startsWith(REF_PREFIX)) {
          throw new Error(`Неожидаемая ссылка ${value}: поддерживаются только ${REF_PREFIX}*`);
        }
        collectDependencies(value.slice(REF_PREFIX.length), seen);
      } else {
        walk(value);
      }
    }
  };

  walk(schemas[name]);
  return seen;
}

/** Переписывает ссылки на локальные $defs. */
function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== 'object') return node;

  return Object.fromEntries(
    Object.entries(node).map(([key, value]) =>
      key === '$ref' && typeof value === 'string'
        ? [key, `#/$defs/${value.slice(REF_PREFIX.length)}`]
        : [key, rewriteRefs(value)],
    ),
  );
}

const used = collectDependencies(ROOT_SCHEMA);
used.delete(ROOT_SCHEMA);

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://flibrary.local/schemas/search-query.json',
  title: ROOT_SCHEMA,
  ...rewriteRefs(schemas[ROOT_SCHEMA]),
  $defs: Object.fromEntries([...used].sort().map((name) => [name, rewriteRefs(schemas[name])])),
};

const target = join(packageRoot, 'src/generated/search-query.schema.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
console.log(`${target}: корень ${ROOT_SCHEMA} + ${used.size} зависимостей`);
