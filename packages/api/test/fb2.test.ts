// Разбор fb2: то, чего нет в коллекционной БД.
//
// Тесты на настоящих файлах из генератора фикстур, а не на выдуманных строках: он
// собирает fb2 по той же схеме, что и реальные книги, и его же разбирает C++-сервер.

import { describe, expect, it } from 'vitest';

import { buildFb2, type Fb2Book } from '../../../fixtures/src/fb2.js';
import { decodeEntities, decodeFb2, parseFb2 } from '../src/content/fb2.js';

const base: Fb2Book = {
  title: 'Пикник на обочине',
  authors: [{ firstName: 'Аркадий', middleName: '', lastName: 'Стругацкий' }],
  genres: ['sf_social'],
  lang: 'ru',
  year: 1972,
  annotation: null,
  series: null,
  keywords: [],
  srcLang: null,
  translators: [],
  publisher: null,
  chapters: [],
  paragraphs: ['Первый абзац.', 'Второй абзац.'],
  cover: null,
};

const parse = (book: Partial<Fb2Book>) => parseFb2(Buffer.from(buildFb2({ ...base, ...book })));

describe('разбор fb2', () => {
  it('читает издателя, город, год и ISBN', () => {
    const details = parse({
      publisher: { name: 'Азбука', city: 'Санкт-Петербург', year: 2015, isbn: '978-5-389-01234-5' },
    });

    expect(details.publisher).toBe('Азбука');
    expect(details.publishCity).toBe('Санкт-Петербург');
    expect(details.publishYear).toBe(2015);
    expect(details.isbn).toBe('978-5-389-01234-5');
  });

  it('читает язык оригинала и переводчиков', () => {
    const details = parse({
      srcLang: 'en',
      translators: [{ firstName: 'Нора', lastName: 'Галь' }],
    });

    expect(details.srcLang).toBe('en');
    expect(details.translators).toEqual(['Галь Нора']);
  });

  it('обходится без publish-info и переводчиков', () => {
    const details = parse({});

    expect(details.publisher).toBeNull();
    expect(details.srcLang).toBeNull();
    expect(details.translators).toEqual([]);
  });

  it('собирает содержание из заголовков секций', () => {
    const details = parse({
      chapters: [
        { title: 'Пролог', paragraphs: ['Раз.'] },
        { title: 'Часть первая', paragraphs: ['Два.'] },
        { title: 'Эпилог', paragraphs: ['Три.'] },
      ],
    });

    expect(details.chapters).toEqual(['Пролог', 'Часть первая', 'Эпилог']);
  });

  it('не поднимает в содержание заголовки вложенных секций', () => {
    // Глава с подглавами — обычное дело; в карточке нужен обзор, а не оглавление
    // до последнего параграфа.
    const xml = buildFb2(base).replace(
      '<body>',
      `<body>
    <section>
      <title><p>Часть первая</p></title>
      <section><title><p>Глава 1</p></title><p>Текст.</p></section>
      <section><title><p>Глава 2</p></title><p>Текст.</p></section>
    </section>`,
    );

    expect(parseFb2(Buffer.from(xml)).chapters).toEqual(['Часть первая']);
  });

  it('считает буквы, слова и страницы по тексту, а не по разметке', () => {
    const details = parse({ chapters: [], paragraphs: ['Раз два три', 'четыре пять'] });

    // Пять слов текста плюс заголовок книги в <body>; разметка в счёт не идёт.
    expect(details.words).toBeGreaterThanOrEqual(5);
    expect(details.letters).toBeGreaterThan(0);
    expect(details.letters).toBeLessThan(100);
    // Страница — 2000 символов, как у FLibrary: короткий текст это одна страница.
    expect(details.pages).toBe(1);
  });

  it('разбирает аннотацию по абзацам', () => {
    const details = parse({ annotation: 'Аннотация книги.' });
    expect(details.annotation).toBe('Аннотация книги.');
  });

  it('не путается в пространствах имён', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<fb:FictionBook xmlns:fb="http://www.gribuser.ru/xml/fictionbook/2.0">
  <fb:description>
    <fb:publish-info><fb:publisher>Наука</fb:publisher></fb:publish-info>
  </fb:description>
  <fb:body><fb:section><fb:title><fb:p>Глава</fb:p></fb:title><fb:p>Текст.</fb:p></fb:section></fb:body>
</fb:FictionBook>`;

    const details = parseFb2(Buffer.from(xml));
    expect(details.publisher).toBe('Наука');
    expect(details.chapters).toEqual(['Глава']);
  });

  it('раскрывает сущности и не оставляет их в тексте', () => {
    const details = parse({ annotation: 'Кавычки «ёлочки» и амперсанд & конец' });
    expect(details.annotation).toBe('Кавычки «ёлочки» и амперсанд & конец');
  });
});

describe('кодировка fb2', () => {
  it('читает windows-1251 по объявлению в декларации', () => {
    // Половина старых fb2 в cp1251; прочитанные как UTF-8, они превращаются в мусор
    // вместе с аннотацией и оглавлением.
    const cyrillic = 'Аннотация';
    const bytes = Buffer.from([...cyrillic].map((char) => 0xc0 + (char.codePointAt(0)! - 0x410)));
    const body = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="windows-1251"?><p>', 'latin1'),
      bytes,
      Buffer.from('</p>', 'latin1'),
    ]);

    expect(decodeFb2(body)).toContain(cyrillic);
  });

  it('без объявления считает содержимое UTF-8', () => {
    expect(decodeFb2(Buffer.from('<p>Текст</p>', 'utf8'))).toContain('Текст');
  });

  it('незнакомую кодировку не роняет', () => {
    const body = Buffer.from('<?xml version="1.0" encoding="x-unknown-42"?><p>Текст</p>', 'utf8');
    expect(() => decodeFb2(body)).not.toThrow();
  });
});

describe('сущности XML', () => {
  it('раскрывает именованные, десятичные и шестнадцатеричные', () => {
    expect(decodeEntities('&amp;&lt;&gt;&#1040;&#x410;')).toBe('&<>АА');
  });

  it('неизвестную сущность оставляет как есть', () => {
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });
});
