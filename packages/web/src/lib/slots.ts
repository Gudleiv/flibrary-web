// Ограничитель числа одновременных задач.
//
// Нужен обложкам: за ними стоит C++-сервер FLibrary с пулом обработчиков на число ядер,
// и всё сверх пула ждёт в очереди API. Браузер про это не знает и выпускает столько
// запросов, сколько влезет в соединения, — очередь переполняется, и часть обложек
// оборачивается заглушками. Дешевле выпускать их по нескольку за раз.

/** Заявка на слот. Снаружи непрозрачна: нужна только чтобы её вернуть или отменить. */
export interface Slot {
  readonly run: () => void;
  started: boolean;
}

export interface Slots {
  /** Запускает задачу сразу или ставит в очередь; возвращённое отдать в `done`. */
  submit(run: () => void): Slot;
  /** Задача закончилась или отменена — слот уходит следующему в очереди. */
  done(slot: Slot): void;
  /** Сколько задач в полёте — для тестов. */
  readonly busy: number;
}

export function createSlots(limit: number): Slots {
  let inFlight = 0;
  const waiting: Slot[] = [];

  const start = (slot: Slot): void => {
    slot.started = true;
    slot.run();
  };

  return {
    submit(run) {
      const slot: Slot = { run, started: false };
      if (inFlight < limit) {
        inFlight += 1;
        start(slot);
      } else {
        waiting.push(slot);
      }
      return slot;
    },

    done(slot) {
      if (!slot.started) {
        // Заявка не дождалась своей очереди — просто убираем её из неё.
        const index = waiting.indexOf(slot);
        if (index !== -1) waiting.splice(index, 1);
        return;
      }

      slot.started = false;
      const next = waiting.shift();
      // Слот не освобождается, а передаётся следующему: иначе между «отпустил» и
      // «занял» успел бы влезть кто-то мимо очереди.
      if (next === undefined) inFlight -= 1;
      else start(next);
    },

    get busy() {
      return inFlight;
    },
  };
}
