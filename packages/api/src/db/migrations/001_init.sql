-- Схема app.db: всё, что принадлежит нам.
--
-- В коллекционную БД мы не пишем ничего: её пересоздаёт и миграцирует FLibrary,
-- любые наши таблицы там были бы снесены при обновлении коллекции.

CREATE TABLE users (
    user_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    login        TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    password_hash TEXT   NOT NULL,
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
    session_id TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL,
    user_agent TEXT
);

CREATE INDEX ix_sessions_user ON sessions (user_id);
CREATE INDEX ix_sessions_expires ON sessions (expires_at);

-- Пользовательские данные. book_id ссылается в коллекционную БД, поэтому без FK:
-- коллекция может быть пересоздана, и висячие строки мы чистим отдельной задачей.
CREATE TABLE book_user_data (
    user_id    INTEGER NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    book_id    INTEGER NOT NULL,
    favorite   INTEGER NOT NULL DEFAULT 0,
    read       INTEGER NOT NULL DEFAULT 0,
    rate       INTEGER,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, book_id)
);

CREATE INDEX ix_book_user_data_favorite ON book_user_data (user_id, favorite) WHERE favorite = 1;
CREATE INDEX ix_book_user_data_read ON book_user_data (user_id, read) WHERE read = 1;

CREATE TABLE saved_searches (
    search_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    title      TEXT    NOT NULL,
    query      TEXT    NOT NULL, -- JSON запроса (SearchQuery)
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, title)
);

-- Состояние собственного поискового индекса: по нему понимаем, изменилась ли коллекция.
CREATE TABLE index_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    collection_mtime TEXT,
    collection_size  INTEGER,
    books_count      INTEGER,
    max_update_id    INTEGER,
    indexed_at       TEXT
);

-- Кэш дорогих агрегатов (счётчики фасетов и total) по хешу запроса.
CREATE TABLE query_cache (
    query_hash TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ix_query_cache_created ON query_cache (created_at);
