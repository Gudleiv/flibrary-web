import { describe, expect, it } from 'vitest';

import { indexText, stemRussian, stemText, tokenize } from '../src/search/stemmer.js';

describe('stemRussian', () => {
  it.each([
    ['город', ['города', 'городу', 'городом', 'городе', 'городов']],
    ['берег', ['берега', 'берегу', 'берегом', 'береге']],
    ['книг', ['книга', 'книги', 'книгу', 'книгой', 'книге']],
    ['красн', ['красный', 'красная', 'красного', 'красному', 'красными']],
    ['стругацк', ['стругацкий', 'стругацкого', 'стругацкому', 'стругацким']],
    ['чита', ['читать', 'читал', 'читала', 'читали', 'читает']],
    ['войн', ['война', 'войны', 'войну', 'войной', 'войне']],
  ])('приводит формы к основе «%s»', (stem, forms) => {
    for (const form of forms) {
      expect(stemRussian(form)).toBe(stem);
    }
  });

  it('не схлопывает разные слова', () => {
    expect(stemRussian('город')).not.toBe(stemRussian('горец'));
    expect(stemRussian('война')).not.toBe(stemRussian('вор'));
    expect(stemRussian('берег')).not.toBe(stemRussian('бор'));
  });

  it('не трогает латиницу и цифры', () => {
    expect(stemRussian('JavaScript')).toBe('javascript');
    expect(stemRussian('fb2')).toBe('fb2');
  });

  it('не портит короткие слова', () => {
    expect(stemRussian('дом')).toBe('дом');
    expect(stemRussian('я')).toBe('я');
  });

  it('считает ё за е', () => {
    expect(stemRussian('солёный')).toBe(stemRussian('соленый'));
  });
});

describe('tokenize', () => {
  it('режет по любым не-буквенным символам', () => {
    expect(tokenize('Город: Стеклянный сон!')).toEqual(['город', 'стеклянный', 'сон']);
  });

  it('оставляет цифры', () => {
    expect(tokenize('Дюна 2, часть 3')).toEqual(['дюна', '2', 'часть', '3']);
  });
});

describe('indexText', () => {
  it('хранит и основу, и исходную форму', () => {
    const indexed = indexText('городами').split(' ');
    expect(indexed).toContain('городами');
    expect(indexed).toContain('город');
  });

  it('решает проблему фамилий: «иванов» и «иванова» пересекаются по формам', () => {
    // Snowball даёт иванов→иван, но иванова→иванов. Пересечение множеств форм
    // обеспечивает совпадение с любой стороны.
    const one = new Set(indexText('иванов').split(' '));
    const other = new Set(indexText('иванова').split(' '));
    expect([...one].some((form) => other.has(form))).toBe(true);
  });

  it('не дублирует форму, если основа совпадает с исходной', () => {
    expect(indexText('город')).toBe('город');
  });
});

describe('stemText', () => {
  it('отдаёт только основы', () => {
    expect(stemText('Красные города')).toBe('красн город');
  });
});
