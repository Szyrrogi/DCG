// Zapis danych: plik JSON (domyślnie) albo Postgres, gdy ustawiono DATABASE_URL
// (np. darmowa baza Neon/Supabase – przydatne na hostingu bez trwałego dysku, jak Render Free).
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

class FileStore {
  async load() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
  }
  async save(data) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, DATA_FILE);
  }
  describe() { return `plik ${DATA_FILE}`; }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: url, ssl });
  }
  async init() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS dcg_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())');
  }
  async load() {
    await this.init();
    const r = await this.pool.query('SELECT data FROM dcg_state WHERE id = 1');
    return r.rows[0] ? r.rows[0].data : null;
  }
  async save(data) {
    await this.pool.query(
      'INSERT INTO dcg_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [JSON.stringify(data)]);
  }
  describe() { return 'baza Postgres (DATABASE_URL)'; }
}

function createStore() {
  return process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new FileStore();
}

module.exports = { createStore };
