#!/usr/bin/env node
// Перегенерирует fixtures/schema/collection.sql из исходников FLibrary.
//
// Схема коллекции принадлежит FLibrary, а не нам: она создаётся при импорте inpx
// и меняется миграциями. Здесь мы держим её копию только для генератора фикстур,
// чтобы разработка шла на БД, совпадающей с настоящей.
//
// Использование:
//   FLIBRARY_SRC=/path/to/books node scripts/sync-collection-schema.mjs
//   node scripts/sync-collection-schema.mjs /path/to/books

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flibrarySrc = process.argv[2] ?? process.env.FLIBRARY_SRC;

if (!flibrarySrc) {
  console.error(
    'Укажите путь к чекауту heimdallr/books: FLIBRARY_SRC=/path/to/books node scripts/sync-collection-schema.mjs',
  );
  process.exit(1);
}

const dataDir = join(flibrarySrc, 'src/home/inpx/resources/data');

const BOM = '﻿';

/**
 * Управляющие символы внутри строковых литералов JSON недопустимы по стандарту, но
 * в этих файлах встречаются табуляции. Экранируем их — но только внутри строк:
 * снаружи те же символы это структурные пробелы, и их трогать нельзя.
 */
function escapeControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    out += inString && code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }

  return out;
}

/** JSON у FLibrary — с BOM и табуляциями внутри строковых литералов. */
function loadStatements(fileName) {
  const raw = readFileSync(join(dataDir, fileName), 'utf8');
  const withoutBom = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const parsed = JSON.parse(escapeControlCharsInStrings(withoutBom));
  return parsed.map((item) => (Array.isArray(item) ? item.join('\n') : item));
}

const create = loadStatements('CreateCollection.json');
const update = loadStatements('UpdateCollection.json');

const header = `-- Схема коллекции FLibrary.
--
-- ВНИМАНИЕ: файл сгенерирован из FLibrary (heimdallr/books):
--   src/home/inpx/resources/data/CreateCollection.json
--   src/home/inpx/resources/data/UpdateCollection.json
-- Править руками не нужно: перегенерировать \`pnpm fixtures:schema\`.
-- Используется только генератором фикстур. Продовая коллекция создаётся
-- самой FLibrary при импорте inpx.

`;

const statement = (sql) => `${sql.trimEnd().replace(/;$/, '')};\n`;

const body = [
  '-- === Таблицы и FTS-индексы (CreateCollection.json) ===\n',
  ...create.filter((s) => !s.trimStart().toUpperCase().startsWith('PRAGMA')).map(statement),
  '-- === Индексы и представления (UpdateCollection.json) ===\n',
  ...update.map(statement),
].join('\n');

const target = join(repoRoot, 'fixtures/schema/collection.sql');
writeFileSync(target, header + body, 'utf8');
console.log(`${target}: ${create.length + update.length} инструкций`);
