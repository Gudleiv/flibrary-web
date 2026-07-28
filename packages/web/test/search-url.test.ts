// Поиск ⇄ URL: на этой паре функций держатся ссылки, которыми делятся, и кнопка «назад».
//
// Отдельно проверяется совместимость со старой формой поиска («строка + где искать»):
// такие ссылки уже разосланы, и открываться они должны.

import { describe, expect, it } from 'vitest';

import {
  buildQuery,
  createEmptyForm,
  fromQueryParams,
  toQueryParams,
} from '../src/composables/useSearchState';

describe('параметры URL поиска', () => {
  it('пустая форма не пишет в URL ничего', () => {
    expect(toQueryParams(createEmptyForm())).toEqual({});
  });

  it('название и автор ходят туда и обратно', () => {
    const form = { ...createEmptyForm(), title: 'Пикник', author: 'Стругацкий' };
    const params = toQueryParams(form);

    // `by`, а не `author`: `author` занят идентификаторами из панели уточнения.
    expect(params).toEqual({ title: 'Пикник', by: 'Стругацкий' });
    expect(fromQueryParams(params)).toMatchObject({ title: 'Пикник', author: 'Стругацкий' });
  });

  it('идентификаторы авторов остаются в `author` и не путаются с текстом', () => {
    const params = toQueryParams({ ...createEmptyForm(), author: 'Толстой', authors: [17, 42] });

    expect(params).toEqual({ by: 'Толстой', author: '17,42' });
    expect(fromQueryParams(params)).toMatchObject({ author: 'Толстой', authors: [17, 42] });
  });

  it('фильтры и листание переживают круг', () => {
    const form = {
      ...createEmptyForm(),
      languages: ['ru', 'en'],
      genres: ['001', '002.001'],
      refineGenres: ['003.002'],
      exts: ['fb2'],
      series: [5],
      yearFrom: 1960,
      yearTo: 1980,
      sortField: 'year' as const,
      sortDir: 'asc' as const,
      page: 3,
      perPage: 100,
    };

    expect(fromQueryParams(toQueryParams(form))).toEqual(form);
  });

  it('жанр уточнения не подмешивается к жанру формы', () => {
    // Один список означал бы «детское ИЛИ фэнтези» — уточнение вместо сужения
    // молча расширяло бы выдачу.
    const params = toQueryParams({
      ...createEmptyForm(),
      genres: ['007'],
      refineGenres: ['002.001'],
    });

    expect(params).toEqual({ genre: '007', refine: '002.001' });
    expect(fromQueryParams(params)).toMatchObject({
      genres: ['007'],
      refineGenres: ['002.001'],
    });
  });

  describe('старые ссылки', () => {
    it('`q` без `in` открывается как поиск по названию', () => {
      expect(fromQueryParams({ q: 'берег' })).toMatchObject({ title: 'берег', author: '' });
    });

    it('`in=author` уходит в поле автора', () => {
      expect(fromQueryParams({ q: 'Иванов', in: 'author' })).toMatchObject({
        title: '',
        author: 'Иванов',
      });
    });

    it('`in=annotation` сужается до названия, а не теряется', () => {
      // Поиска по аннотации в форме больше нет; честнее сузить запрос, чем молча
      // вернуть не то, что искали.
      expect(fromQueryParams({ q: 'дневник', in: 'annotation' })).toMatchObject({
        title: 'дневник',
      });
    });

    it('новые параметры сильнее старых', () => {
      expect(fromQueryParams({ q: 'старое', title: 'новое' })).toMatchObject({ title: 'новое' });
    });

    it('прочие параметры старых ссылок читаются как раньше', () => {
      expect(fromQueryParams({ q: 'берег', lang: 'ru', from: '1990', page: '2' })).toMatchObject({
        title: 'берег',
        languages: ['ru'],
        yearFrom: 1990,
        page: 2,
      });
    });
  });

  describe('мусор в URL', () => {
    it('дробная и отрицательная страница не уезжают в отрицательный offset', () => {
      for (const page of ['0', '-3', '1.5', 'что-то']) {
        expect(fromQueryParams({ page }).page).toBe(1);
      }
    });

    it('размер страницы вне допустимого набора игнорируется', () => {
      expect(fromQueryParams({ per: '1000' }).perPage).toBe(20);
      expect(fromQueryParams({ per: '100' }).perPage).toBe(100);
    });

    it('нечисловые идентификаторы отбрасываются', () => {
      expect(fromQueryParams({ author: '1,abc,3' }).authors).toEqual([1, 3]);
    });
  });
});

describe('форма → дерево предикатов', () => {
  it('пустая форма — это «показать всё», а не пустой запрос', () => {
    expect(buildQuery(createEmptyForm()).where).toEqual({
      field: 'deleted',
      op: 'eq',
      value: false,
    });
  });

  it('название и автор сходятся по `and`, а не объединяют выдачи', () => {
    const query = buildQuery({ ...createEmptyForm(), title: 'Пикник', author: 'Стругацкий' });

    expect(query.where).toEqual({
      op: 'and',
      nodes: [
        { field: 'title', op: 'prefix', value: 'Пикник' },
        { field: 'author', op: 'prefix', value: 'Стругацкий' },
      ],
    });
  });

  it('пробелы вместо запроса предиката не создают', () => {
    expect(buildQuery({ ...createEmptyForm(), title: '   ' }).where).toEqual({
      field: 'deleted',
      op: 'eq',
      value: false,
    });
  });

  it('жанр всегда с поддеревом: выбран корень — значит и поджанры', () => {
    expect(buildQuery({ ...createEmptyForm(), genres: ['001'] }).where).toEqual({
      field: 'genre',
      op: 'in',
      values: ['001'],
      includeChildren: true,
    });
  });

  it('жанр формы и жанр уточнения сходятся по И, а не в один список', () => {
    const query = buildQuery({
      ...createEmptyForm(),
      genres: ['007'],
      refineGenres: ['002.001'],
    });

    expect(query.where).toEqual({
      op: 'and',
      nodes: [
        { field: 'genre', op: 'in', values: ['007'], includeChildren: true },
        { field: 'genre', op: 'in', values: ['002.001'], includeChildren: true },
      ],
    });
  });

  it('страница считается пропуском от размера страницы', () => {
    const query = buildQuery({ ...createEmptyForm(), page: 3, perPage: 20 });
    expect(query).toMatchObject({ limit: 20, offset: 40 });
  });
});
