// Разбор fb2: то, чего нет в коллекционной БД.
//
// Издатель, язык оригинала, переводчики, содержание и объём текста в коллекцию не
// попадают вовсе — inpx их не переносит. FLibrary показывает их, разбирая сам файл
// книги на лету (`AnnotationController`), и здесь мы делаем то же самое.
//
// Файл при этом достаём только через content-service: распаковку zip/7z и
// восстановление картинок мы не переписываем (инвариант 5). Разбираем уже
// распакованный XML — это наша работа, C++ тут ничего не добавляет.
//
// Почему разбор свой, а не библиотекой: из всего документа нам нужны `<description>`
// в голове файла и заголовки секций; полный DOM пятимегабайтной книги ради десятка
// полей — лишняя память и лишняя зависимость.

/** Что удалось вытащить из файла. Всё необязательно: fb2 в дикой природе разные. */
export interface Fb2Details {
  annotation: string | null;
  publisher: string | null;
  publishYear: number | null;
  publishCity: string | null;
  isbn: string | null;
  /** Язык оригинала — есть только у переводных книг. */
  srcLang: string | null;
  translators: string[];
  /** Заголовки секций верхнего уровня — «Содержание» в интерфейсе FLibrary. */
  chapters: string[];
  /** Символов в тексте книги, без разметки. */
  letters: number;
  words: number;
  /**
   * Страниц примерно: FLibrary считает по 2000 символов на страницу
   * (`AnnotationController.cpp`, `GetTextSize() / 2000`). Цифра условная, но
   * сопоставимая с тем, что показывает десктопный клиент.
   */
  pages: number;
}

const CHARS_PER_PAGE = 2000;

/**
 * Кодировка из XML-декларации.
 *
 * Не роскошь: fb2 из старых библиотек сплошь в windows-1251, и прочитанные как UTF-8
 * они превращаются в мусор — вместе с аннотацией и оглавлением.
 */
export function decodeFb2(body: Buffer): string {
  // Декларация — ASCII в первых полутора сотнях байт при любой из поддерживаемых
  // кодировок, поэтому её можно прочитать до того, как выбрана кодировка.
  const head = body.subarray(0, 256).toString('latin1');
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();

  if (declared === undefined || declared === 'utf-8' || declared === 'utf8') {
    return body.toString('utf8');
  }

  try {
    return new TextDecoder(declared).decode(body);
  } catch {
    // Незнакомая кодировка — не повод не показать вообще ничего.
    return body.toString('utf8');
  }
}

/** Тег без учёта пространства имён: `<fb:book-title>` встречается наравне с `<book-title>`. */
const tag = (name: string): string => `(?:\\w+:)?${name}`;

function block(xml: string, name: string): string | null {
  const match = new RegExp(`<${tag(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag(name)}\\s*>`, 'i').exec(
    xml,
  );
  return match?.[1] ?? null;
}

function blocks(xml: string, name: string): string[] {
  const found = xml.matchAll(
    new RegExp(`<${tag(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag(name)}\\s*>`, 'gi'),
  );
  return [...found].map((match) => match[1] ?? '');
}

/** Содержимое тега как обычный текст: разметка выброшена, сущности раскрыты. */
function text(xml: string | null): string | null {
  if (xml === null) return null;
  const value = stripTags(xml);
  return value === '' ? null : value;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function stripTags(xml: string): string {
  return decodeEntities(
    xml
      // Абзацы и переводы строк разделяем пробелом, иначе «конец.Начало» слипается.
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}

/** Имя автора/переводчика из `<author>`: фамилия, имя, отчество или `<nickname>`. */
function personName(xml: string): string | null {
  const parts = ['last-name', 'first-name', 'middle-name']
    .map((name) => text(block(xml, name)))
    .filter((part): part is string => part !== null);

  if (parts.length > 0) {
    const [last, first, middle] = parts.length === 3 ? parts : [parts[0], parts[1], undefined];
    return [last, first, middle].filter(Boolean).join(' ');
  }

  return text(block(xml, 'nickname'));
}

export function parseFb2(body: Buffer): Fb2Details {
  const xml = decodeFb2(body);

  const description = block(xml, 'description') ?? '';
  const titleInfo = block(description, 'title-info') ?? '';
  const publishInfo = block(description, 'publish-info') ?? '';

  // Аннотация в fb2 размечена абзацами; в интерфейсе она показывается как текст,
  // поэтому абзацы разделяем переводом строки, а не склеиваем в одну простыню.
  const annotationXml = block(titleInfo, 'annotation');
  const annotation =
    annotationXml === null
      ? null
      : blocks(annotationXml, 'p')
          .map((paragraph) => stripTags(paragraph))
          .filter((paragraph) => paragraph !== '')
          .join('\n') || text(annotationXml);

  const publishYearRaw = text(block(publishInfo, 'year'));
  const publishYear =
    publishYearRaw === null || !/^\d{3,4}$/.test(publishYearRaw) ? null : Number(publishYearRaw);

  const translators = blocks(titleInfo, 'translator')
    .map((person) => personName(person))
    .filter((name): name is string => name !== null);

  const body_ = block(xml, 'body') ?? '';

  return {
    annotation,
    publisher: text(block(publishInfo, 'publisher')),
    publishYear,
    publishCity: text(block(publishInfo, 'city')),
    isbn: text(block(publishInfo, 'isbn')),
    srcLang: text(block(titleInfo, 'src-lang')),
    translators,
    chapters: chaptersOf(body_),
    ...sizeOf(body_),
  };
}

/**
 * Заголовки секций верхнего уровня — то, что FLibrary показывает как «Содержание».
 *
 * Берём только первый уровень вложенности: у книг с подсекциями полное дерево — это
 * сотни строк, а в карточке нужен обзор, а не оглавление до последнего параграфа.
 */
function chaptersOf(bodyXml: string): string[] {
  const chapters: string[] = [];
  const opening = /<(\/?)(?:\w+:)?section(?:\s[^>]*?)?(\/?)>/gi;

  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(bodyXml)) !== null) {
    const closing = match[1] === '/';
    const selfClosing = match[2] === '/';
    if (closing) {
      depth -= 1;
      continue;
    }
    if (selfClosing) continue;

    if (depth === 0) {
      // Заголовок секции — первый `<title>` сразу за её открывающим тегом; всё, что
      // дальше первой вложенной секции, к этому заголовку уже не относится.
      const rest = bodyXml.slice(match.index + match[0].length);
      const nested = rest.search(/<(?:\w+:)?section[\s>]/i);
      const head = nested === -1 ? rest : rest.slice(0, nested);
      const title = text(block(head, 'title'));
      if (title !== null) chapters.push(title);
    }
    depth += 1;
  }

  return chapters;
}

function sizeOf(bodyXml: string): { letters: number; words: number; pages: number } {
  const plain = stripTags(bodyXml);
  const letters = plain.length;
  const words = plain === '' ? 0 : plain.split(/\s+/).length;

  return {
    letters,
    words,
    pages: letters === 0 ? 0 : Math.max(1, Math.round(letters / CHARS_PER_PAGE)),
  };
}
