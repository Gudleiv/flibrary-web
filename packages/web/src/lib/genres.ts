// Дерево жанров: перекладка между формой поиска (список кодов) и деревом PrimeVue.
//
// В запросе жанр — это список кодов с `includeChildren: true`, то есть выбранный
// «001» значит «Фантастика со всеми поджанрами». Дерево PrimeVue с галочками устроено
// иначе: выбор родителя оно раскрывает в галочки на всех потомках. Перекладка нужна
// в обе стороны и именно поэтому — иначе в URL уезжали бы два десятка кодов там, где
// достаточно одного.

import type { Genre } from '@flibrary/contract';

/** Узел дерева в форме, которую понимает PrimeVue Tree/TreeSelect. */
export interface GenreTreeNode {
  key: string;
  label: string;
  /** Число книг с поджанрами — рисуется рядом с названием. */
  books: number;
  children?: GenreTreeNode[];
}

/** Состояние галочек TreeSelect: ключ узла → отмечен / отмечен частично. */
export type GenreSelection = Record<string, { checked: boolean; partialChecked: boolean }>;

export function toTreeNodes(items: Genre[]): GenreTreeNode[] {
  return items.map((item) => ({
    key: item.code,
    label: item.title,
    books: item.books ?? 0,
    children: item.children?.length ? toTreeNodes(item.children) : undefined,
  }));
}

/** Плоский обход дерева — код узла и цепочка его предков. */
function walk(
  items: Genre[],
  parents: string[],
  visit: (node: Genre, parents: string[]) => void,
): void {
  for (const item of items) {
    visit(item, parents);
    if (item.children?.length) walk(item.children, [...parents, item.code], visit);
  }
}

/** Коды из запроса → галочки в дереве: выбранный родитель отмечает и всех потомков. */
export function toSelection(items: Genre[], codes: string[]): GenreSelection {
  const chosen = new Set(codes);
  const selection: GenreSelection = {};

  // Первый проход: отмечены сами выбранные и всё под ними.
  const checked = new Set<string>();
  walk(items, [], (node, parents) => {
    if (chosen.has(node.code) || parents.some((parent) => checked.has(parent))) {
      checked.add(node.code);
    }
  });

  // Второй: предок отмеченного узла — «частично», если сам не отмечен целиком.
  const partial = new Set<string>();
  walk(items, [], (node, parents) => {
    if (!checked.has(node.code)) return;
    for (const parent of parents) if (!checked.has(parent)) partial.add(parent);
  });

  for (const code of checked) selection[code] = { checked: true, partialChecked: false };
  for (const code of partial) selection[code] = { checked: false, partialChecked: true };

  return selection;
}

/**
 * Галочки → коды для запроса, свёрнутые до верхних узлов.
 *
 * Потомки отмеченного узла отбрасываются: `includeChildren` их и так включает, а без
 * свёртки выбор «Фантастики» уносил бы в URL все её поджанры поимённо.
 */
export function fromSelection(items: Genre[], selection: GenreSelection): string[] {
  const checked = new Set(
    Object.entries(selection)
      .filter(([, state]) => state.checked)
      .map(([code]) => code),
  );

  const codes: string[] = [];
  walk(items, [], (node, parents) => {
    if (!checked.has(node.code)) return;
    if (parents.some((parent) => checked.has(parent))) return;
    codes.push(node.code);
  });

  return codes;
}

/** Название жанра по коду — для подписи фильтра, когда дерева под рукой нет. */
export function genreTitles(items: Genre[]): Map<string, string> {
  const titles = new Map<string, string>();
  walk(items, [], (node) => titles.set(node.code, node.title));
  return titles;
}
