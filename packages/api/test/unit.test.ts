import { describe, expect, it } from 'vitest';

import { buildFtsQuery, buildIndexQuery, buildLikePattern } from '../src/search/fts.js';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../src/search/cursor.js';
import { buildGenreTree } from '../src/routes/catalog.js';
import { displayAuthorName } from '../src/db/labels.js';
import { compileFacets } from '../src/search/compile.js';
import { facetQuery } from '../src/search/facets.js';

describe('buildFtsQuery', () => {
  it('оборачивает термы в кавычки, чтобы обезвредить синтаксис FTS5', () => {
    expect(buildFtsQuery('война и мир', 'match')).toBe('"война" "и" "мир"');
  });

  it('добавляет звёздочку в префиксном режиме', () => {
    expect(buildFtsQuery('берег', 'prefix')).toBe('"берег"*');
  });

  it('собирает фразу целиком', () => {
    expect(buildFtsQuery('тихий берег', 'phrase')).toBe('"тихий берег"');
  });

  it('нейтрализует операторы FTS5 и кавычки', () => {
    // Без экранирования такие строки роняют MATCH синтаксической ошибкой.
    expect(buildFtsQuery('foo" OR bar', 'match')).toBe('"foo" "OR" "bar"');
    expect(buildFtsQuery('NEAR(a b)', 'match')).toBe('"NEAR(a" "b)"');
  });

  it('возвращает null, когда после очистки ничего не осталось', () => {
    expect(buildFtsQuery('   ', 'match')).toBeNull();
    expect(buildFtsQuery('""', 'match')).toBeNull();
  });
});

describe('buildIndexQuery', () => {
  it('ищет слово и как исходную форму, и как основу', () => {
    expect(buildIndexQuery('гарри', 'match')).toBe('("гарри" OR "гарр")');
  });

  it('не заворачивает в скобки слово, у которого основа совпала с формой', () => {
    expect(buildIndexQuery('поттер', 'match')).toBe('"поттер"');
  });

  it('склеивает слова явным AND', () => {
    // Неявный AND у FTS5 работает только между фразами: без `AND` запрос со скобочной
    // группой падает с `fts5: syntax error near "("`. Ловилось на «гарри поттер», а на
    // латинице — нет: её стеммер не меняет, скобок не возникает.
    expect(buildIndexQuery('гарри поттер', 'match')).toBe('("гарри" OR "гарр") AND "поттер"');
    expect(buildIndexQuery('harry potter', 'match')).toBe('"harry" AND "potter"');
  });

  it('ограничивает поиск колонкой', () => {
    expect(buildIndexQuery('поттер', 'prefix', 'title')).toBe('title : ("поттер"*)');
  });

  it('фразу ищет по исходным формам', () => {
    expect(buildIndexQuery('гарри поттер', 'phrase')).toBe('"гарри поттер"');
  });
});

describe('buildLikePattern', () => {
  it('приводит к верхнему регистру: в коллекции SearchTitle нормализован', () => {
    expect(buildLikePattern('берег', 'prefix')).toBe('БЕРЕГ%');
    expect(buildLikePattern('берег', 'substring')).toBe('%БЕРЕГ%');
  });

  it('экранирует служебные символы LIKE', () => {
    expect(buildLikePattern('50%_a', 'prefix')).toBe('50\\%\\_A%');
  });
});

describe('курсор', () => {
  it('переживает round-trip', () => {
    const cursor = { key: 'ТИХИЙ БЕРЕГ', bookId: 42 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('поддерживает числовой ключ сортировки', () => {
    const cursor = { key: 1984, bookId: 7 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('отвергает мусор', () => {
    expect(() => decodeCursor('не-курсор')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });
});

describe('displayAuthorName', () => {
  it('переводит служебную запись справочника «автор неизвестен»', () => {
    // В коллекции это реальный автор с 887 книгами, а не пропуск данных.
    expect(displayAuthorName('Unknown author')).toBe('Неизвестный автор');
    expect(displayAuthorName('unknown')).toBe('Неизвестный автор');
    expect(displayAuthorName('  ')).toBe('Неизвестный автор');
    expect(displayAuthorName(null)).toBe('Неизвестный автор');
  });

  it('обычное имя не трогает', () => {
    expect(displayAuthorName('Стругацкий Аркадий Натанович')).toBe('Стругацкий Аркадий Натанович');
  });
});

describe('buildGenreTree', () => {
  it('собирает дерево по ParentCode', () => {
    const tree = buildGenreTree([
      { code: 'sf', parentCode: null, title: 'Фантастика', books: 10, ownBooks: 0 },
      { code: 'sf_space', parentCode: 'sf', title: 'Космическая', books: 4, ownBooks: 4 },
      { code: 'sf_cyber', parentCode: 'sf', title: 'Киберпанк', books: 6, ownBooks: 6 },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.code).toBe('sf');
    expect(tree[0]?.children?.map((child) => child.code)).toEqual(['sf_space', 'sf_cyber']);
  });

  it('поднимает сироту в корень, а не теряет её', () => {
    const tree = buildGenreTree([
      { code: 'orphan', parentCode: 'missing', title: 'Сирота', books: 1, ownBooks: 1 },
    ]);

    expect(tree.map((node) => node.code)).toEqual(['orphan']);
  });
});

describe('компиляция фасетов', () => {
  const context = { userId: 1, hideDeleted: true, useIndex: false };

  it('не сужает фасет его собственным фильтром', () => {
    const [plan] = compileFacets(
      {
        where: {
          op: 'and',
          nodes: [
            { field: 'lang', op: 'in', values: ['ru'] },
            { field: 'year', op: 'range', from: 2000, to: 2010 },
          ],
        },
        facets: ['lang'],
      },
      context,
    );

    // Предикат по языку из подсчёта языкового фасета убран, остальные — на месте.
    expect(plan?.matched.sql).not.toContain('Lang IN');
    expect(plan?.matched.sql).toContain('Year >=');
    // Выбранное значение не пропало: оно закрепляется в начале списка.
    expect(plan?.pinned).toEqual(['ru']);
    expect(facetQuery(plan!, { kind: 'inline' }).sql).toContain('CASE WHEN h.lang IN (?)');
  });

  it('оставляет фильтр целиком, если предикат внутри OR', () => {
    // Убрать «или на английском» из OR — значит получить другое множество,
    // а не расширенное, поэтому такой фасет считается по полному фильтру.
    const [plan] = compileFacets(
      {
        where: {
          op: 'or',
          nodes: [
            { field: 'lang', op: 'in', values: ['ru'] },
            { field: 'lang', op: 'in', values: ['en'] },
          ],
        },
        facets: ['lang'],
      },
      context,
    );

    expect(plan?.matched.sql).toContain('Lang IN');
    expect(plan?.pinned).toEqual([]);
  });

  it('считает по всей коллекции, когда кроме своего фильтра ничего нет', () => {
    const [plan] = compileFacets(
      { where: { field: 'lang', op: 'in', values: ['ru'] }, facets: ['lang'] },
      context,
    );

    expect(plan?.matched.sql).toBe('SELECT BookID FROM coll.Books');
    expect(plan?.pinned).toEqual(['ru']);
  });

  it('жанр — единственный фасет, который сужает сам себя', () => {
    // Жанров у книги несколько, и выбранные складываются по AND: «какие ещё жанры
    // есть у найденного» надо считать по уже отфильтрованному множеству, иначе
    // счётчик обещает одно, а щелчок по нему даёт совсем другое число.
    const [plan] = compileFacets(
      { where: { field: 'genre', op: 'in', values: ['sf'] }, facets: ['genre'] },
      context,
    );

    expect(plan?.matched.sql).toContain('Genre_List');
    expect(plan?.pinned).toEqual([]);
  });

  it('дедуплицирует множество: у книги может быть два подходящих автора', () => {
    const [plan] = compileFacets(
      { where: { field: 'author', op: 'prefix', value: 'ив' }, facets: ['lang'] },
      context,
    );

    // Без DISTINCT такая книга попала бы в счётчик дважды.
    expect(plan?.matched.sql).toContain('SELECT DISTINCT BookID FROM');
  });

  it('без запрошенных полей не строит ничего', () => {
    expect(compileFacets({ where: { field: 'lang', op: 'in', values: ['ru'] } }, context)).toEqual(
      [],
    );
  });
});
