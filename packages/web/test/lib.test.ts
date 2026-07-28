// Форматирование и дерево жанров — то, что видно пользователю в каждом списке.

import { describe, expect, it } from 'vitest';
import type { Genre } from '@flibrary/contract';

import { formatSize } from '../src/lib/format';
import { compareByLanguageName, languageName } from '../src/lib/lang';
import { fromSelection, toSelection } from '../src/lib/genres';

describe('размер книги', () => {
  it('растёт по единицам, а не считает всё в килобайтах', () => {
    // Раньше размер везде делился на 1024 один раз, и мегабайтная книга
    // выводилась как «12000 КБ».
    expect(formatSize(0)).toBe('0 Б');
    expect(formatSize(512)).toBe('512 Б');
    expect(formatSize(5120)).toBe('5 КБ');
    expect(formatSize(12 * 1024 * 1024)).toBe('12 МБ');
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe('3 ГБ');
  });

  it('размера может не быть — это не ноль', () => {
    expect(formatSize(null)).toBeNull();
    expect(formatSize(undefined)).toBeNull();
    expect(formatSize(Number.NaN)).toBeNull();
  });
});

describe('названия языков', () => {
  it('переводит коды и начинает с большой буквы', () => {
    expect(languageName('ru')).toBe('Русский');
    expect(languageName('uk')).toBe('Украинский');
  });

  it('неизвестный код показывает как есть, а не выдумывает язык', () => {
    expect(languageName('xx')).toBe('XX');
    expect(languageName('')).toBe('Без языка');
    expect(languageName(null)).toBe('Без языка');
  });

  it('сортирует по названию, а не по коду', () => {
    // По коду 'uk' стоял бы после 'ru', по названию «Украинский» — тоже, а вот
    // 'en' («Английский») по коду первый и по названию первый; проверяем пару,
    // где порядки расходятся: 'de' («Немецкий») против 'fr' («Французский»).
    expect([...['fr', 'de', 'ru']].sort(compareByLanguageName)).toEqual(['de', 'ru', 'fr']);
  });
});

describe('выбор жанров в дереве', () => {
  const tree: Genre[] = [
    {
      code: '001',
      title: 'Фантастика',
      books: 100,
      children: [
        { code: '001.001', title: 'Киберпанк', books: 40 },
        { code: '001.002', title: 'Фэнтези', books: 70 },
      ],
    },
    { code: '002', title: 'Детективы', books: 50, children: [] },
  ];

  it('выбранный корень отмечает и потомков', () => {
    const selection = toSelection(tree, ['001']);

    expect(selection['001']).toEqual({ checked: true, partialChecked: false });
    expect(selection['001.001']).toEqual({ checked: true, partialChecked: false });
    expect(selection['002']).toBeUndefined();
  });

  it('выбранный поджанр помечает родителя частично', () => {
    const selection = toSelection(tree, ['001.001']);

    expect(selection['001.001']).toEqual({ checked: true, partialChecked: false });
    expect(selection['001']).toEqual({ checked: false, partialChecked: true });
  });

  it('в запрос уходит только верхний выбранный узел', () => {
    // includeChildren и так включает поддерево: незачем уносить в URL все коды.
    const selection = toSelection(tree, ['001']);
    expect(fromSelection(tree, selection)).toEqual(['001']);
  });

  it('поджанры без родителя перечисляются поимённо', () => {
    const selection = toSelection(tree, ['001.002', '002']);
    expect(fromSelection(tree, selection).sort()).toEqual(['001.002', '002']);
  });

  it('пустой выбор — пустой список', () => {
    expect(fromSelection(tree, {})).toEqual([]);
    expect(toSelection(tree, [])).toEqual({});
  });
});
