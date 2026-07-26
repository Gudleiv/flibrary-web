#!/usr/bin/env node
// Управление пользователями. Регистрации в приложении нет — аккаунты создаются здесь.
//
//   pnpm --filter @flibrary/api users add <логин> <пароль> [имя]
//   pnpm --filter @flibrary/api users passwd <логин> <пароль>
//   pnpm --filter @flibrary/api users list
//   pnpm --filter @flibrary/api users disable <логин>
//   pnpm --filter @flibrary/api users enable <логин>

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrations.js';
import { createUser, listUsers, setActive, setPassword } from '../auth/users.js';

const config = loadConfig();
mkdirSync(dirname(config.appDb), { recursive: true });

const db = new Database(config.appDb);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
runMigrations(db);

const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.error(
    [
      'Использование:',
      '  users add <логин> <пароль> [имя]',
      '  users passwd <логин> <пароль>',
      '  users list',
      '  users disable <логин>',
      '  users enable <логин>',
    ].join('\n'),
  );
  process.exit(1);
}

try {
  switch (command) {
    case 'add': {
      const [login, password, displayName] = args;
      if (!login || !password) usage();
      await createUser(db, login, password, displayName);
      console.log(`Пользователь ${login} создан`);
      break;
    }
    case 'passwd': {
      const [login, password] = args;
      if (!login || !password) usage();
      if (!(await setPassword(db, login, password))) {
        console.error(`Пользователь ${login} не найден`);
        process.exit(1);
      }
      console.log(`Пароль пользователя ${login} изменён`);
      break;
    }
    case 'list': {
      const users = listUsers(db);
      if (users.length === 0) {
        console.log('Пользователей нет. Создайте: users add <логин> <пароль>');
        break;
      }
      for (const user of users) {
        console.log(
          `${user.login.padEnd(20)} ${user.display_name.padEnd(24)} ${
            user.is_active ? 'активен' : 'отключён'
          }`,
        );
      }
      break;
    }
    case 'disable':
    case 'enable': {
      const [login] = args;
      if (!login) usage();
      if (!setActive(db, login, command === 'enable')) {
        console.error(`Пользователь ${login} не найден`);
        process.exit(1);
      }
      console.log(`Пользователь ${login} ${command === 'enable' ? 'включён' : 'отключён'}`);
      break;
    }
    default:
      usage();
  }
} finally {
  db.close();
}
