const fs = require('fs');
const path = require('path');

/**
 * Postgres (Railway). Se DATABASE_URL nao estiver definido, o banco fica
 * desligado e a automacao continua funcionando como antes (sem painel).
 */
let pool = null;

function enabled() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    pool.on('error', (err) => console.error('[db] Erro no pool:', err.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function migrate() {
  if (!enabled()) return;
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
  console.log('[db] Schema OK.');
}

module.exports = { enabled, query, migrate };
