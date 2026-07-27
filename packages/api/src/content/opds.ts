// Клиент внутреннего C++-сервера FLibrary (`opds`).
//
// Это единственное место, которое знает его контракт (`/Images/*`). Всё, что связано с
// распаковкой архивов, восстановлением картинок в fb2, извлечением обложек и внешними
// конвертерами, уже реализовано там и переписывать это незачем.
//
// Контракт внутренний и может поехать при обновлении upstream — поэтому он изолирован
// здесь и должен быть закрыт контрактным тестом.
//
// ГЛАВНОЕ ПРО ЭТОТ СЕРВЕР: он выдерживает ровно столько одновременных запросов, сколько
// у машины ядер, и не больше. Каждый его обработчик — это `QtConcurrent::run`, то есть
// задача в глобальном QThreadPool, а обработчик обложки (`Server.cpp::RouteGetBook`)
// вдобавок блокирует свой поток вложенным `QEventLoop`, пока AnnotationController не
// распакует архив и не разберёт книгу. Всё, что не поместилось в пул, просто стоит в
// очереди без ответа — для клиента это неотличимо от зависшего сервера.
//
// Отсюда два следствия, ради которых здесь есть ограничитель:
//   1. Страница выдачи просит до сотни обложек сразу. Без ограничителя undici открывает
//      столько же соединений (у Agent по умолчанию их число не ограничено), пул на той
//      стороне забивается, и следующий запрос — скачивание книги — висит до таймаута.
//   2. AnnotationController в C++ один на процесс, и обложка запрашивается у него через
//      `SetCurrentBookId`. Параллельные запросы затирают друг другу текущую книгу, так что
//      сериализация — это ещё и защита от чужой обложки в ответе.
//
// Поэтому запросы идут через свой Pool с фиксированным числом соединений и через
// ограничитель с резервом: скачивание файла не может встать в очередь за обложками.

import { Pool, errors } from 'undici';
import type { Readable } from 'node:stream';

import type { Config } from '../config.js';

/** Заголовки ответа content-service. */
export type ContentHeaders = Record<string, string | string[] | undefined>;

/**
 * Тело есть только у успешного ответа: неуспешное вычитывается и отбрасывается здесь же,
 * иначе занятый им слот ограничителя никто бы не освободил.
 */
export type ContentResponse =
  | { ok: true; status: number; headers: ContentHeaders; body: Readable }
  | { ok: false; status: number; headers: ContentHeaders; body: null };

/** Не достучались: сервера нет, соединение отвергнуто или разорвано. */
export class ContentServiceUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Внутренний content-service недоступен');
    this.name = 'ContentServiceUnavailableError';
    this.cause = cause;
  }
}

/**
 * Достучались, но ответа не дождались. Отдельный тип, потому что снаружи это другой
 * диагноз: сервер жив и, скорее всего, перегружен — повторять запрос имеет смысл.
 */
export class ContentServiceTimeoutError extends Error {
  constructor(cause: unknown) {
    super('Внутренний content-service не ответил вовремя');
    this.name = 'ContentServiceTimeoutError';
    this.cause = cause;
  }
}

/** Слот в ограничителе не освободился: очередь к content-service переполнена. */
export class ContentServiceBusyError extends Error {
  constructor() {
    super('Внутренний content-service перегружен');
    this.name = 'ContentServiceBusyError';
  }
}

/** Формат, в котором отдаётся книга. */
export type BookFormat = 'original' | 'fb2' | 'zip' | 'epub' | 'mobi';

/** Обложка ждёт слот недолго: лучше показать заглушку, чем держать соединение. */
const COVER_QUEUE_TIMEOUT_MS = 5_000;
/** Файл книги — единственное, ради чего пользователь готов ждать. */
const FILE_QUEUE_TIMEOUT_MS = 30_000;

// Таймауты самих запросов оставлены щедрыми намеренно: `opds` падает по segfault, когда
// клиент обрывает соединение на середине выдачи, а срабатывание таймаута — это ровно
// обрыв. Ждать вместо клиента должна очередь (она отвечает 503, ни разу не постучавшись),
// а таймаут остаётся страховкой на случай, когда сервер уже завис.
const COVER_HEADERS_TIMEOUT_MS = 30_000;
const COVER_BODY_TIMEOUT_MS = 60_000;
/** Распаковка большой книги с восстановлением картинок бывает небыстрой. */
const FILE_HEADERS_TIMEOUT_MS = 30_000;
const FILE_BODY_TIMEOUT_MS = 120_000;

type Lane = 'cover' | 'file';

interface Waiter {
  lane: Lane;
  grant: (release: () => void) => void;
  timer: NodeJS.Timeout;
}

/**
 * Ограничитель числа одновременных запросов с резервом под скачивание.
 *
 * Обложек в полёте не больше `limit - 1`, поэтому хотя бы один слот всегда достаётся
 * файлу; в очереди файлы встают перед обложками по той же причине.
 */
export class ContentLimiter {
  private inFlight = 0;
  private coversInFlight = 0;
  private readonly queue: Waiter[] = [];
  private readonly coverLimit: number;

  constructor(private readonly limit: number) {
    // При limit = 1 резервировать нечего: обложки и файлы идут строго по очереди.
    this.coverLimit = Math.max(1, limit - 1);
  }

  acquire(lane: Lane, timeoutMs: number): Promise<() => void> {
    if (this.canStart(lane)) return Promise.resolve(this.start(lane));

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        grant: resolve,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new ContentServiceBusyError());
        }, timeoutMs),
      };
      // Таймер очереди не должен держать процесс живым.
      waiter.timer.unref?.();

      const firstCover = this.queue.findIndex((item) => item.lane === 'cover');
      if (lane === 'file' && firstCover !== -1) this.queue.splice(firstCover, 0, waiter);
      else this.queue.push(waiter);
    });
  }

  /** Сколько запросов в полёте — для логов и тестов. */
  get busy(): number {
    return this.inFlight;
  }

  private canStart(lane: Lane): boolean {
    if (this.inFlight >= this.limit) return false;
    return lane === 'file' || this.coversInFlight < this.coverLimit;
  }

  private start(lane: Lane): () => void {
    this.inFlight += 1;
    if (lane === 'cover') this.coversInFlight += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      if (lane === 'cover') this.coversInFlight -= 1;
      this.pump();
    };
  }

  /**
   * Первый в очереди может быть обложкой, упёршейся в свой лимит, — тогда пропускаем
   * следующего за ней, иначе освободившийся слот простаивал бы.
   */
  private pump(): void {
    while (this.inFlight < this.limit) {
      const index = this.queue.findIndex((item) => this.canStart(item.lane));
      if (index === -1) return;
      const [waiter] = this.queue.splice(index, 1);
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      waiter.grant(this.start(waiter.lane));
    }
  }
}

export class ContentService {
  private readonly pool: Pool;
  private readonly basePath: string;
  private readonly limiter: ContentLimiter;

  constructor(
    private readonly config: Config,
    private readonly log: { warn(object: unknown, message: string): void },
  ) {
    const base = new URL(config.contentServiceUrl);
    this.basePath = base.pathname.replace(/\/$/, '');
    this.pool = new Pool(base.origin, {
      connections: config.contentServiceConcurrency,
      // QHttpServer отдаёт `Keep-Alive: timeout=5`; закрываем раньше него, иначе
      // запрос уезжает в соединение, которое та сторона уже закрывает.
      keepAliveTimeout: 4_000,
      // Конвейеризацию не включаем: медленная книга задержала бы всё за ней.
      pipelining: 1,
    });
    this.limiter = new ContentLimiter(config.contentServiceConcurrency);
  }

  /** Обложка в оригинальном виде, как её извлёк FLibrary. */
  cover(bookId: number): Promise<ContentResponse> {
    return this.get(`/Images/covers/${bookId}`, 'cover');
  }

  /**
   * Файл книги. `zip` — исходник в архиве, `fb2` — с восстановленными картинками,
   * epub/mobi требуют настроенных в FLibrary конвертеров (параметр профиля).
   */
  book(bookId: number, format: BookFormat): Promise<ContentResponse> {
    switch (format) {
      case 'zip':
        return this.get(`/Images/zip/${bookId}`, 'file');
      case 'epub':
      case 'mobi':
        // У FLibrary конвертер выбирается профилем в настройках; имя профиля совпадает
        // с расширением в дефолтной конфигурации.
        return this.get(`/Images/fb2/${bookId}`, 'file', { profile: format });
      case 'fb2':
      case 'original':
      default:
        return this.get(`/Images/fb2/${bookId}`, 'file');
    }
  }

  /** Закрыть пул соединений: без этого процесс не завершится. */
  close(): Promise<void> {
    return this.pool.close();
  }

  private async get(
    path: string,
    lane: Lane,
    query?: Record<string, string>,
  ): Promise<ContentResponse> {
    const url = new URL(this.basePath + path, this.config.contentServiceUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const release = await this.limiter.acquire(
      lane,
      lane === 'cover' ? COVER_QUEUE_TIMEOUT_MS : FILE_QUEUE_TIMEOUT_MS,
    );

    let response;
    try {
      response = await this.pool.request({
        method: 'GET',
        path: url.pathname + url.search,
        headers: {
          // Сервер жмёт ответ, только если его об этом попросили, а мы отдаём наружу
          // его content-length: пусть тело и длина остаются согласованными.
          'accept-encoding': 'identity',
        },
        headersTimeout: lane === 'cover' ? COVER_HEADERS_TIMEOUT_MS : FILE_HEADERS_TIMEOUT_MS,
        bodyTimeout: lane === 'cover' ? COVER_BODY_TIMEOUT_MS : FILE_BODY_TIMEOUT_MS,
      });
    } catch (error) {
      release();
      this.log.warn({ err: error, url: url.toString() }, 'запрос к content-service не удался');
      throw isTimeout(error)
        ? new ContentServiceTimeoutError(error)
        : new ContentServiceUnavailableError(error);
    }

    if (response.statusCode !== 200) {
      // Тело неуспешного ответа никто не читает — вычитываем сами, иначе соединение
      // останется занятым до таймаута, а с ним и слот ограничителя.
      await response.body.dump().catch(() => undefined);
      release();
      return { ok: false, status: response.statusCode, headers: response.headers, body: null };
    }

    // Слот держим, пока тело не дочитано или не выброшено: иначе одновременных
    // передач стало бы больше, чем соединений в пуле.
    response.body.on('close', release);

    return {
      ok: true,
      status: response.statusCode,
      headers: response.headers,
      body: response.body,
    };
  }
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof errors.HeadersTimeoutError ||
    error instanceof errors.BodyTimeoutError ||
    error instanceof errors.ConnectTimeoutError
  );
}
