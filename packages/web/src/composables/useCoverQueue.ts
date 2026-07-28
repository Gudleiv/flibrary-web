// Загрузка обложки: не раньше, чем она понадобится, и не больше нескольких сразу.
//
// Обложку отдаёт C++-сервер FLibrary через ручку API, и одновременных запросов он
// выдерживает столько, сколько у машины ядер. Страница выдачи же просит их пачкой, а
// два читателя — двумя пачками; в очереди API это оборачивалось отказами, а в выдаче —
// заглушками «обложка недоступна» на ровном месте.
//
// Своё наблюдение за экраном, а не `loading="lazy"`: браузер не сообщает, когда решил
// начать загрузку, поэтому слот в очереди было бы некому вернуть — отложенная картинка
// держала бы его вечно.

import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

import { createSlots, type Slot } from '@/lib/slots';

/** Столько обложек одновременно переживает и очередь API, и content-service за ней. */
const AT_ONCE = 3;

/** Запас до края экрана: при спокойной прокрутке обложка приезжает заранее. */
const ROOT_MARGIN = '400px';

const slots = createSlots(AT_ONCE);

const watched = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;

function observe(element: Element, onVisible: () => void): void {
  // jsdom и старые браузеры: без наблюдателя грузим сразу — это хуже, но работает.
  if (typeof IntersectionObserver === 'undefined') {
    onVisible();
    return;
  }

  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        // Больше следить не за чем: обложка не меняется, а смена книги в карточке
        // видимости не меняет.
        observer?.unobserve(entry.target);
        watched.get(entry.target)?.();
        watched.delete(entry.target);
      }
    },
    { rootMargin: ROOT_MARGIN },
  );

  watched.set(element, onVisible);
  observer.observe(element);
}

function unobserve(element: Element | null): void {
  if (element === null) return;
  watched.delete(element);
  observer?.unobserve(element);
}

export interface CoverQueue {
  /** Элемент, за появлением которого на экране следим. */
  box: Ref<HTMLElement | null>;
  /** Адрес, который можно ставить в `src`; до своей очереди — null. */
  src: Ref<string | null>;
  ready: Ref<boolean>;
  failed: Ref<boolean>;
  /** Картинка загрузилась (`true`) или не смогла (`false`). */
  settle: (ok: boolean) => void;
}

export function useCoverQueue(url: Ref<string>): CoverQueue {
  const box = ref<HTMLElement | null>(null);
  const src = ref<string | null>(null);
  const ready = ref(false);
  const failed = ref(false);
  const visible = ref(false);

  let slot: Slot | null = null;

  const release = (): void => {
    if (slot === null) return;
    slots.done(slot);
    slot = null;
  };

  const settle = (ok: boolean): void => {
    ready.value = ok;
    failed.value = !ok;
    release();
  };

  // Карточка переиспользуется под другую книгу при листании выдачи, поэтому следим
  // не только за появлением на экране, но и за сменой адреса.
  watch([visible, url], () => {
    release();
    src.value = null;
    ready.value = false;
    failed.value = false;
    if (!visible.value) return;
    slot = slots.submit(() => (src.value = url.value));
  });

  onMounted(() => {
    const element = box.value;
    if (element === null) visible.value = true;
    else observe(element, () => (visible.value = true));
  });

  onBeforeUnmount(() => {
    unobserve(box.value);
    // Ушли со страницы, не дождавшись очереди, — слот отдаём тем, кто на экране.
    release();
  });

  return { box, src, ready, failed, settle };
}
