// Флаги языков: описание, из которого FlagIcon рисует SVG.
//
// Почему рисуем сами, а не берём готовое:
//   - emoji-флаги ('🇷🇺') не годятся: Windows их не рендерит и показывает буквы «RU»,
//     то есть ровно там, где мы обещали иконку, окажется мусор;
//   - пакеты вроде flag-icons — это мегабайт ассетов ради трёх десятков картинок
//     размером 16 пикселей, где всё равно видны только полосы.
// Большинство нужных флагов — две-три полосы, они задаются таблицей; сложные описаны
// разметкой поштучно.
//
// Флаг здесь — у ЯЗЫКА, а не у страны, поэтому соответствие местами условно и спорные
// случаи подписаны. Там, где однозначной страны нет (арабский, латынь), флага нет
// вовсе — лучше глобус, чем произвольно выбранная страна.

/** Система координат всех флагов: 3:2, как у большинства государственных. */
export const FLAG_VIEW_BOX = '0 0 30 20';

export type Flag =
  /** Горизонтальные полосы сверху вниз; `weights` — доли высоты, по умолчанию равные. */
  | { kind: 'h'; colors: string[]; weights?: number[] }
  /** Вертикальные полосы от древка; `weights` — доли ширины. */
  | { kind: 'v'; colors: string[]; weights?: number[] }
  /** Скандинавский крест со смещением к древку. */
  | { kind: 'nordic'; field: string; cross: string; inner?: string }
  /** Одноцветное поле с кругом. */
  | { kind: 'disc'; field: string; disc: string; cx?: number; cy?: number; r?: number }
  /** Всё остальное — разметкой. */
  | { kind: 'raw'; content: string };

/** Пятиконечная звезда: центр, внешний радиус. Нужна нескольким флагам. */
function star(cx: number, cy: number, radius: number): string {
  const inner = radius * 0.382;
  const points: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? radius : inner;
    const angle = (-90 + i * 36) * (Math.PI / 180);
    points.push(
      `${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`,
    );
  }
  return points.join(' ');
}

export const FLAGS: Record<string, Flag> = {
  ru: { kind: 'h', colors: ['#ffffff', '#0039a6', '#d52b1e'] },
  uk: { kind: 'h', colors: ['#0057b7', '#ffd700'] },
  // Белорусский орнамент у древка в 16 пикселях неразличим — оставляем полосы.
  be: { kind: 'h', colors: ['#d22730', '#007c30'], weights: [2, 1] },
  de: { kind: 'h', colors: ['#000000', '#dd0000', '#ffce00'] },
  fr: { kind: 'v', colors: ['#002395', '#ffffff', '#ed2939'] },
  pl: { kind: 'h', colors: ['#ffffff', '#dc143c'] },
  // Испанский — язык не только Испании, но флаг Испании для него общепринят.
  es: { kind: 'h', colors: ['#aa151b', '#f1bf00', '#aa151b'], weights: [1, 2, 1] },
  it: { kind: 'v', colors: ['#009246', '#ffffff', '#ce2b37'] },
  pt: { kind: 'v', colors: ['#006600', '#ff0000'], weights: [2, 3] },
  nl: { kind: 'h', colors: ['#ae1c28', '#ffffff', '#21468b'] },
  sk: { kind: 'h', colors: ['#ffffff', '#0b4ea2', '#ee1c25'] },
  sl: { kind: 'h', colors: ['#ffffff', '#0000ff', '#ff0000'] },
  bg: { kind: 'h', colors: ['#ffffff', '#00966e', '#d62612'] },
  sr: { kind: 'h', colors: ['#c6363c', '#0c4076', '#ffffff'] },
  hr: { kind: 'h', colors: ['#ff0000', '#ffffff', '#171796'] },
  hu: { kind: 'h', colors: ['#ce2939', '#ffffff', '#477050'] },
  ro: { kind: 'v', colors: ['#002b7f', '#fcd116', '#ce1126'] },
  et: { kind: 'h', colors: ['#0072ce', '#000000', '#ffffff'] },
  lv: { kind: 'h', colors: ['#9e3039', '#ffffff', '#9e3039'], weights: [2, 1, 2] },
  lt: { kind: 'h', colors: ['#fdb913', '#006a44', '#c1272d'] },
  hy: { kind: 'h', colors: ['#d90012', '#0033a0', '#f2a800'] },
  az: { kind: 'h', colors: ['#00b5e2', '#ef3340', '#509e2f'] },
  uz: { kind: 'h', colors: ['#0099b5', '#ffffff', '#1eb53a'] },
  tt: { kind: 'h', colors: ['#00963c', '#ffffff', '#db2727'], weights: [4, 1, 4] },
  ba: { kind: 'h', colors: ['#0064b1', '#ffffff', '#00a04b'] },
  cv: { kind: 'h', colors: ['#ffdf00', '#a3132a'], weights: [3, 1] },

  sv: { kind: 'nordic', field: '#006aa7', cross: '#fecc00' },
  da: { kind: 'nordic', field: '#c8102e', cross: '#ffffff' },
  fi: { kind: 'nordic', field: '#ffffff', cross: '#003580' },
  no: { kind: 'nordic', field: '#ba0c2f', cross: '#ffffff', inner: '#00205b' },
  is: { kind: 'nordic', field: '#02529c', cross: '#ffffff', inner: '#dc1e35' },

  ja: { kind: 'disc', field: '#ffffff', disc: '#bc002d', r: 5.5 },
  kk: { kind: 'disc', field: '#00afca', disc: '#fec50c', cy: 9, r: 4 },

  // Английский — флаг Великобритании: языку принято давать флаг метрополии.
  en: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#012169"/>
      <path d="M0,0 30,20 M30,0 0,20" stroke="#ffffff" stroke-width="4"/>
      <path d="M0,0 30,20 M30,0 0,20" stroke="#c8102e" stroke-width="2"/>
      <path d="M15,0 V20 M0,10 H30" stroke="#ffffff" stroke-width="6"/>
      <path d="M15,0 V20 M0,10 H30" stroke="#c8102e" stroke-width="3.5"/>`,
  },
  cs: {
    kind: 'raw',
    content: `<rect width="30" height="10" fill="#ffffff"/>
      <rect y="10" width="30" height="10" fill="#d7141a"/>
      <path d="M0,0 15,10 0,20 Z" fill="#11457e"/>`,
  },
  el: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#0d5eaf"/>
      <path d="M0,3.33 H30 M0,8.89 H30 M0,14.44 H30" stroke="#ffffff" stroke-width="2.22"/>
      <rect width="12.22" height="12.22" fill="#0d5eaf"/>
      <path d="M6.11,0 V12.22 M0,6.11 H12.22" stroke="#ffffff" stroke-width="2.44"/>`,
  },
  tr: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#e30a17"/>
      <circle cx="11.5" cy="10" r="5" fill="#ffffff"/>
      <circle cx="13.2" cy="10" r="4" fill="#e30a17"/>
      <polygon points="${star(18.5, 10, 2.6)}" fill="#ffffff"/>`,
  },
  he: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#ffffff"/>
      <path d="M0,3.6 H30 M0,16.4 H30" stroke="#0038b8" stroke-width="2.4"/>
      <path d="M15,6.4 18.6,12.6 11.4,12.6 Z M15,13.6 18.6,7.4 11.4,7.4 Z"
        fill="none" stroke="#0038b8" stroke-width="1"/>`,
  },
  zh: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#ee1c25"/>
      <polygon points="${star(6, 6, 3.4)}" fill="#ffde00"/>
      <polygon points="${star(12.5, 3, 1.2)}" fill="#ffde00"/>
      <polygon points="${star(14.5, 6, 1.2)}" fill="#ffde00"/>
      <polygon points="${star(14.5, 9.5, 1.2)}" fill="#ffde00"/>
      <polygon points="${star(12.5, 12, 1.2)}" fill="#ffde00"/>`,
  },
  ko: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#ffffff"/>
      <path d="M15,5 a5,5 0 0 1 0,10 a2.5,2.5 0 0 1 0,-5 a2.5,2.5 0 0 0 0,-5" fill="#cd2e3a"/>
      <path d="M15,5 a5,5 0 0 0 0,10 a2.5,2.5 0 0 0 0,-5 a2.5,2.5 0 0 1 0,-5" fill="#0047a0"/>`,
  },
  ka: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#ffffff"/>
      <path d="M15,0 V20 M0,10 H30" stroke="#ff0000" stroke-width="4"/>`,
  },
  eo: {
    kind: 'raw',
    content: `<rect width="30" height="20" fill="#009900"/>
      <rect width="10" height="6.67" fill="#ffffff"/>
      <polygon points="${star(5, 3.33, 2.5)}" fill="#009900"/>`,
  },
};

/** Есть ли для языка флаг: без него FlagIcon рисует нейтральный глобус. */
export const flagFor = (code: string | null | undefined): Flag | undefined =>
  code === null || code === undefined ? undefined : FLAGS[code.trim().toLowerCase()];
