#!/usr/bin/env node
// Пересборка поискового индекса.
//
//   pnpm --filter @flibrary/api reindex          — только изменения (доиндексация, если хватает)
//   pnpm --filter @flibrary/api reindex --force  — собрать заново целиком
//
// Запускать после обновления коллекции (импорт inpx) и по расписанию.

import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { buildIndex } from '../indexer/index.js';

const config = loadConfig();

// Тот же слой доступа, что и у сервера: коллекция подключена к read-only соединению,
// так что даже индексатор физически не может в неё записать.
const db = openDatabase(config, {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
});

let lastReported = 0;

try {
  const result = buildIndex(db, config.collectionDb, {
    force: process.argv.includes('--force'),
    onProgress: (done, total) => {
      // Не заваливаем лог: сообщаем примерно каждые 10%.
      const step = Math.max(1, Math.floor(total / 10));
      if (done - lastReported >= step) {
        lastReported = done;
        console.log(`  ${done} / ${total}`);
      }
    },
  });

  const what = result.mode === 'incremental' ? 'Индекс дополнен' : 'Индекс собран';
  console.log(
    result.built
      ? `${what}: ${result.books} книг за ${(result.tookMs / 1000).toFixed(1)} с (${result.reason})`
      : `Пересборка не нужна: ${result.reason}`,
  );
} finally {
  db.close();
}
