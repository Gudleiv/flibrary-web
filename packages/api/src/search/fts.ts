// Подготовка строки для FTS5 MATCH.
//
// Пользовательский ввод нельзя отдавать во MATCH как есть: кавычки, звёздочки, скобки,
// NEAR/AND/OR/NOT — это синтаксис FTS5, и «войну и мир» или `foo(bar` уронят запрос
// синтаксической ошибкой. Поэтому каждый терм оборачиваем в двойные кавычки: внутри них
// FTS5 трактует содержимое буквально, а операторы обезвреживаются.

import { stemRussian, tokenize } from './stemmer.js';

const TERM_SEPARATOR = /[\s,;]+/;

/** Символы, которые внутри кавычек всё равно проблемны. */
function sanitizeTerm(term: string): string {
  return term.replace(/"/g, ' ').trim();
}

function quote(term: string): string {
  return `"${sanitizeTerm(term)}"`;
}

export type FtsMode = 'match' | 'prefix' | 'phrase';

/**
 * Собирает выражение FTS5.
 *   match  — все слова обязательны (неявный AND у FTS5)
 *   prefix — то же, но каждое слово как префикс
 *   phrase — точная фраза
 * Возвращает null, если после очистки ничего не осталось.
 */
export function buildFtsQuery(value: string, mode: FtsMode): string | null {
  const terms = value
    .split(TERM_SEPARATOR)
    .map(sanitizeTerm)
    .filter((term) => term.length > 0);

  if (terms.length === 0) return null;

  if (mode === 'phrase') return quote(terms.join(' '));

  const suffix = mode === 'prefix' ? '*' : '';
  return terms.map((term) => `${quote(term)}${suffix}`).join(' ');
}

/** Шаблон для LIKE по нормализованным (uppercase) полям коллекции. */
export function buildLikePattern(value: string, position: 'prefix' | 'substring'): string {
  const escaped = value.toUpperCase().replace(/[\\%_]/g, (char) => `\\${char}`);
  return position === 'prefix' ? `${escaped}%` : `%${escaped}%`;
}

/**
 * Выражение для собственного индекса (books_fts).
 *
 * Каждое слово ищется и как основа, и как исходная форма — так же, как оно попало в
 * индекс (см. indexText). Формы объединяются через OR, слова между собой — через AND.
 *
 * AND именно явный: неявный AND у FTS5 работает только между фразами, а группа форм —
 * это скобочное выражение, и `("гарри" OR "гарр") "поттер"` падает с
 * `fts5: syntax error near "("`. Одиночное слово в скобки не заворачивается, поэтому
 * латиница (её стеммер не меняет, форма одна) до этой ошибки не доходила.
 *
 * `column` ограничивает поиск одним полем индекса синтаксисом FTS5 `col : выражение`.
 */
export function buildIndexQuery(value: string, mode: FtsMode, column?: string): string | null {
  const words = tokenize(value);
  if (words.length === 0) return null;

  const suffix = mode === 'prefix' ? '*' : '';

  const expression =
    mode === 'phrase'
      ? // Фразу ищем по исходным формам: основы порядок слов не сохраняют осмысленно.
        `"${words.join(' ')}"`
      : words
          .map((word) => {
            const forms = new Set([word, stemRussian(word)]);
            const variants = [...forms].map((form) => `"${form}"${suffix}`);
            return variants.length === 1 ? variants[0] : `(${variants.join(' OR ')})`;
          })
          .join(' AND ');

  return column === undefined ? expression : `${column} : (${expression})`;
}

/** Подстрока для триграммного индекса. Меньше трёх символов триграммы не ловят. */
export function buildTrigramQuery(value: string, column?: string): string | null {
  const normalized = tokenize(value).join(' ');
  if (normalized.length < 3) return null;

  const phrase = `"${normalized}"`;
  return column === undefined ? phrase : `${column} : ${phrase}`;
}
