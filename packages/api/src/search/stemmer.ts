// Стеммер русского языка (алгоритм Snowball/Porter).
//
// Зачем свой, а не библиотека: нужен один и тот же код для индексации и для разбора
// запроса, без нативных зависимостей и с предсказуемым поведением. Алгоритм
// стандартный и хорошо специфицирован — https://snowballstem.org/algorithms/russian/
//
// Что он даёт: «города», «городу», «городом» приводятся к одной основе, поэтому запрос
// находит книгу независимо от падежа. Именно этого не умеют FTS-индексы коллекции:
// они созданы с дефолтным токенизатором unicode61, без морфологии.
//
// Латиница и цифры не трогаются — для них стемминг тут был бы вреднее пользы.

const VOWELS = new Set(['а', 'е', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я']);

const PERFECTIVE_GERUND_1 = ['вшись', 'вши', 'в'];
const PERFECTIVE_GERUND_2 = ['ывшись', 'ившись', 'ывши', 'ивши', 'ыв', 'ив'];

const ADJECTIVE = [
  'ыми',
  'ими',
  'его',
  'ого',
  'ему',
  'ому',
  'ее',
  'ие',
  'ые',
  'ое',
  'ей',
  'ий',
  'ый',
  'ой',
  'ем',
  'им',
  'ым',
  'ом',
  'их',
  'ых',
  'ую',
  'юю',
  'ая',
  'яя',
  'ою',
  'ею',
];

const PARTICIPLE_1 = ['ющ', 'нн', 'вш', 'ем', 'щ'];
const PARTICIPLE_2 = ['ующ', 'ивш', 'ывш'];

const REFLEXIVE = ['ся', 'сь'];

const VERB_1 = [
  'ешь',
  'нно',
  'ете',
  'йте',
  'ла',
  'на',
  'ли',
  'ем',
  'ло',
  'но',
  'ет',
  'ют',
  'ны',
  'ть',
  'й',
  'л',
  'н',
];
const VERB_2 = [
  'уйте',
  'ейте',
  'ила',
  'ыла',
  'ена',
  'ите',
  'или',
  'ыли',
  'ило',
  'ыло',
  'ено',
  'ует',
  'уют',
  'ены',
  'ить',
  'ыть',
  'ишь',
  'ей',
  'уй',
  'ил',
  'ыл',
  'им',
  'ым',
  'ен',
  'ят',
  'ит',
  'ыт',
  'ую',
  'ю',
];

const NOUN = [
  'иями',
  'иях',
  'ями',
  'ами',
  'ией',
  'иям',
  'ием',
  'иях',
  'ях',
  'ах',
  'ев',
  'ов',
  'ие',
  'ье',
  'еи',
  'ии',
  'ей',
  'ой',
  'ий',
  'ям',
  'ем',
  'ам',
  'ом',
  'ию',
  'ью',
  'ия',
  'ья',
  'а',
  'е',
  'и',
  'й',
  'о',
  'у',
  'ы',
  'ь',
  'ю',
  'я',
];

const SUPERLATIVE = ['ейше', 'ейш'];
const DERIVATIONAL = ['ость', 'ост'];

/** Сначала самые длинные окончания: иначе «ившись» съест только «в». */
const byLengthDesc = (endings: string[]): string[] =>
  [...endings].sort((a, b) => b.length - a.length);

const PG1 = byLengthDesc(PERFECTIVE_GERUND_1);
const PG2 = byLengthDesc(PERFECTIVE_GERUND_2);
const ADJ = byLengthDesc(ADJECTIVE);
const PART1 = byLengthDesc(PARTICIPLE_1);
const PART2 = byLengthDesc(PARTICIPLE_2);
const V1 = byLengthDesc(VERB_1);
const V2 = byLengthDesc(VERB_2);
const N = byLengthDesc(NOUN);
const SUP = byLengthDesc(SUPERLATIVE);
const DER = byLengthDesc(DERIVATIONAL);

interface Regions {
  /** Позиция после первой гласной. */
  rv: number;
  /** Позиция после первой гласной, за которой следует согласная, внутри R1. */
  r2: number;
}

function computeRegions(word: string): Regions {
  let rv = word.length;
  for (let i = 0; i < word.length; i += 1) {
    if (VOWELS.has(word[i] as string)) {
      rv = i + 1;
      break;
    }
  }

  const regionAfter = (from: number): number => {
    for (let i = from; i < word.length - 1; i += 1) {
      if (VOWELS.has(word[i] as string) && !VOWELS.has(word[i + 1] as string)) {
        return i + 2;
      }
    }
    return word.length;
  };

  const r1 = regionAfter(0);
  const r2 = regionAfter(r1);

  return { rv, r2 };
}

/** Находит и отрезает окончание в пределах региона; null — ничего не подошло. */
function cut(word: string, endings: string[], regionStart: number): string | null {
  for (const ending of endings) {
    if (word.length - ending.length >= regionStart && word.endsWith(ending)) {
      return word.slice(0, word.length - ending.length);
    }
  }
  return null;
}

/**
 * Окончание из «группы 1» допустимо только после а или я — так алгоритм отличает
 * деепричастие «сказав» от существительного, оканчивающегося на те же буквы.
 */
function cutAfterAYa(word: string, endings: string[], regionStart: number): string | null {
  for (const ending of endings) {
    const start = word.length - ending.length;
    if (start - 1 >= regionStart && word.endsWith(ending)) {
      const previous = word[start - 1];
      if (previous === 'а' || previous === 'я') return word.slice(0, start);
    }
  }
  return null;
}

const CYRILLIC = /[а-яё]/;

/**
 * Кэш основ: слово → основа.
 *
 * Стеммер — чистая функция, а словарь каталога куда меньше числа слов в нём: на
 * фикстуре в 50 000 книг индексатор прогоняет через стеммер 1,2 млн токенов, и каждый
 * повторный — это заново весь разбор окончаний. Отсюда Map: считаем один раз на слово,
 * а не один раз на вхождение.
 *
 * Размер ограничен, потому что уникальных токенов на реальной коллекции (имена,
 * транслитерация, номера) сильно больше, чем на синтетической, а кэш живёт в процессе
 * API, а не только в индексаторе. При переполнении сбрасываем целиком, а не вытесняем
 * по LRU: учёт возраста стоил бы дороже самого стемминга, а частотные слова
 * возвращаются в кэш на ближайших же строках.
 */
const STEM_CACHE_LIMIT = 100_000;
const stemCache = new Map<string, string>();

/** Приводит слово к основе. Нерусские слова возвращаются как есть (в нижнем регистре). */
export function stemRussian(input: string): string {
  const cached = stemCache.get(input);
  if (cached !== undefined) return cached;

  const stem = computeStem(input);
  if (stemCache.size >= STEM_CACHE_LIMIT) stemCache.clear();
  stemCache.set(input, stem);
  return stem;
}

function computeStem(input: string): string {
  const lower = input.toLowerCase().replace(/ё/g, 'е');
  if (!CYRILLIC.test(lower)) return lower;
  // Короткие слова алгоритм только портит.
  if (lower.length <= 3) return lower;

  const { rv, r2 } = computeRegions(lower);
  let word = lower;

  // Шаг 1: деепричастие → возвратность + (прилагательное | глагол | существительное)
  const gerund = cutAfterAYa(word, PG1, rv) ?? cut(word, PG2, rv);
  if (gerund !== null) {
    word = gerund;
  } else {
    word = cut(word, REFLEXIVE, rv) ?? word;

    const adjective = cut(word, ADJ, rv);
    if (adjective !== null) {
      // Причастие перед прилагательным отрезается вместе с ним.
      word = cutAfterAYa(adjective, PART1, rv) ?? cut(adjective, PART2, rv) ?? adjective;
    } else {
      const verb = cutAfterAYa(word, V1, rv) ?? cut(word, V2, rv);
      word = verb ?? cut(word, N, rv) ?? word;
    }
  }

  // Шаг 2: и в RV
  if (word.length - 1 >= rv && word.endsWith('и')) word = word.slice(0, -1);

  // Шаг 3: словообразовательный суффикс в R2
  word = cut(word, DER, r2) ?? word;

  // Шаг 4: удвоенное н, превосходная степень, мягкий знак
  if (word.endsWith('нн')) {
    word = word.slice(0, -1);
  } else {
    const superlative = cut(word, SUP, rv);
    if (superlative !== null) {
      word = superlative.endsWith('нн') ? superlative.slice(0, -1) : superlative;
    } else if (word.endsWith('ь')) {
      word = word.slice(0, -1);
    }
  }

  return word;
}

/** Разбивает текст на токены так же, как это делает FTS5-токенизатор unicode61. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/** Текст → строка основ. */
export function stemText(text: string): string {
  return tokenize(text).map(stemRussian).join(' ');
}

/**
 * Текст для индекса: основы И исходные формы.
 *
 * Почему не только основы. Алгоритм Snowball на фамилиях даёт несогласованный результат:
 * «иванов» → «иван», но «иванова» → «иванов» (окончание -ов входит в список именных, а
 * -а отрезается раньше). Для каталога, где поиск по автору — основная ось, этого хватает,
 * чтобы «Иванов» не находил «Иванова». Храня обе формы и запрашивая их через OR, мы
 * получаем совпадение с любой стороны: у «иванова» в индексе есть {иванов, иванова},
 * и запрос «иванов» = («иван» OR «иванов») попадает по второму варианту.
 *
 * Цена — примерно вдвое больше токенов на русском тексте и небольшая потеря точности.
 * Для каталога это верный размен: терять книгу из-за падежа хуже, чем показать лишнюю.
 */
export function indexText(text: string): string {
  const forms = new Set<string>();
  for (const token of tokenize(text)) {
    forms.add(token);
    forms.add(stemRussian(token));
  }
  return [...forms].join(' ');
}
