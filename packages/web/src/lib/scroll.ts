// Прокрутка к нужному месту после смены страницы или выбора в справочнике.
//
// На телефоне раскладка одноколоночная: справочник и выдача идут друг под другом, и
// «следующая страница» без прокрутки оставляет экран там же, где он был, — посреди
// предыдущей.

/** Системная настройка «уменьшить движение» — это в том числе и про плавную прокрутку. */
function behavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/**
 * `scrollIntoView`, а не `scrollTo` у контейнера: прокручиваемых предков бывает
 * несколько — страница прокручивается в `.app-body`, а справочник авторов на десктопе
 * ещё и внутри своей карточки. Браузер разбирается со всеми сам.
 */
export function scrollToElement(target: Element | null | undefined): void {
  target?.scrollIntoView({ behavior: behavior(), block: 'start' });
}
