// Коды языков коллекции → то, что можно показать человеку.
//
// В коллекции язык лежит кодом ISO 639 (`Books.Lang`, до трёх символов): 'ru', 'en',
// 'uk'. Пользователю код ничего не говорит, поэтому везде, где язык виден, показываем
// название и флаг.

/**
 * Названия берёт браузер: свой словарь на полторы сотни языков мы бы только
 * поддерживали в неактуальном виде.
 *
 * `fallback: 'none'` важен: с ним неизвестный код даёт `undefined`, и мы показываем
 * сам код, а не подсунутый обратно 'xx', который выглядел бы как настоящее название.
 */
const DISPLAY_NAMES = new Intl.DisplayNames(['ru'], { type: 'language', fallback: 'none' });

/**
 * Коды, которых нет в CLDR или чей перевод бесполезен. `und` браузер не знает вовсе,
 * `mul` переводит как «языки разных семей» — в списке языков коллекции это загадка.
 */
const OVERRIDES: Record<string, string> = {
  mul: 'Несколько языков',
  und: 'Язык не указан',
  zxx: 'Без текста',
};

/** Название языка с большой буквы: CLDR отдаёт «русский», а в списке нужен «Русский». */
export function languageName(code: string | null | undefined): string {
  if (code === null || code === undefined || code.trim() === '') return 'Без языка';

  const normalized = code.trim().toLowerCase();
  const name = OVERRIDES[normalized] ?? safeDisplayName(normalized);

  // Неизвестный код показываем как есть, в верхнем регистре: это честнее выдумки
  // и по нему видно, что в коллекции лежит именно такое значение.
  if (name === undefined) return normalized.toUpperCase();

  return name.charAt(0).toUpperCase() + name.slice(1);
}

function safeDisplayName(code: string): string | undefined {
  try {
    return DISPLAY_NAMES.of(code) ?? undefined;
  } catch {
    // Ломаный код ('!!') Intl считает ошибкой аргумента, а не неизвестным языком.
    return undefined;
  }
}

/** Сравнение по названию для сортировки списка языков А-Я. */
export const compareByLanguageName = (a: string, b: string): number =>
  languageName(a).localeCompare(languageName(b), 'ru');
