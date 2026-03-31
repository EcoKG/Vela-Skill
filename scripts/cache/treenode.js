#!/usr/bin/env node
/**
 * Vela TreeNode Cache — SQLite-based file path memory
 *
 * Prevents redundant file scanning by remembering explored paths
 * across sessions. When read-only mode explores files, the tracker
 * appends paths to pending-paths.jsonl. This script ingests those
 * entries into a SQLite database organized as a tree structure.
 *
 * Usage:
 *   treenode ingest              — Ingest pending paths into SQLite
 *   treenode query <path-prefix> — Find cached paths under a prefix
 *   treenode stats               — Show cache statistics
 *   treenode clear               — Clear the cache
 *   treenode export              — Export all paths as JSON
 *
 * SQLite backend priority:
 *   1. better-sqlite3 (npm, native — fastest, synchronous)
 *   2. sql.js (npm, pure WASM — no native compilation needed)
 *   3. sqlite3 CLI (system binary)
 *   4. JSON file fallback (no SQLite at all)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CWD = process.cwd();
const VELA_DIR = path.join(CWD, '.vela');
const CACHE_DIR = path.join(VELA_DIR, 'cache');
const DB_PATH = path.join(CACHE_DIR, 'vela-cache.db');
const JSON_PATH = path.join(CACHE_DIR, 'vela-cache.json');
const PENDING_PATH = path.join(CACHE_DIR, 'pending-paths.jsonl');

const args = process.argv.slice(2);
const command = args[0] || 'ingest';

// ─── SQLite Backend Detection (priority order) ───

let backend = null; // 'better-sqlite3' | 'sql.js' | 'cli' | 'json'
let betterSqlite3 = null;
let sqlJsInit = null;

// 1. Try better-sqlite3 (native, fastest)
try {
  betterSqlite3 = require('better-sqlite3');
  backend = 'better-sqlite3';
} catch (e) {
  // Not available — try next
}

// 2. Try sql.js (WASM, works everywhere)
if (!backend) {
  try {
    sqlJsInit = require('sql.js');
    backend = 'sql.js';
  } catch (e) {
    // Not available — try next
  }
}

// 3. Try sqlite3 CLI
if (!backend) {
  try {
    execSync('which sqlite3', { stdio: 'pipe' });
    backend = 'cli';
  } catch (e) {
    // Not available — fallback to JSON
  }
}

// 4. JSON file fallback
if (!backend) {
  backend = 'json';
}

// ─── Commands ───

const commands = {
  ingest: cmdIngest,
  query: cmdQuery,
  stats: cmdStats,
  clear: cmdClear,
  export: cmdExport,
  backend: cmdBackend
};

if (!commands[command]) {
  output({ ok: false, error: `Unknown command: ${command}`, available: Object.keys(commands) });
  process.exit(1);
}

// sql.js is async, so wrap everything
if (backend === 'sql.js') {
  (async () => {
    try {
      await commands[command]();
    } catch (e) {
      output({ ok: false, error: e.message });
      process.exit(1);
    }
  })();
} else {
  commands[command]();
}

// ─── Command Implementations ───

async function cmdBackend() {
  output({ ok: true, backend, db_path: backend === 'json' ? JSON_PATH : DB_PATH });
}

async function cmdIngest() {
  await ensureDb();

  if (!fs.existsSync(PENDING_PATH)) {
    return output({ ok: true, command: 'ingest', ingested: 0, backend, message: 'No pending paths.' });
  }

  const lines = fs.readFileSync(PENDING_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  let ingested = 0;
  const entries = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const filePath = entry.path;
      const dir = path.dirname(filePath);
      const name = path.basename(filePath);
      const ext = path.extname(filePath);
      const relativePath = path.relative(CWD, filePath);
      entries.push({ filePath, dir, name, ext, relativePath, timestamp: entry.timestamp || Date.now() });
      ingested++;
    } catch (e) {
      continue;
    }
  }

  if (entries.length > 0) {
    await dbIngest(entries);
  }

  // Clear pending file after ingestion
  try { fs.writeFileSync(PENDING_PATH, ''); } catch (e) {}

  output({ ok: true, command: 'ingest', ingested, backend, message: `Ingested ${ingested} paths into TreeNode cache.` });
}

async function cmdQuery() {
  await ensureDb();
  const prefix = args[1] || CWD;
  const rows = await dbQuery(prefix);
  output({ ok: true, command: 'query', prefix, count: rows.length, backend, paths: rows });
}

async function cmdStats() {
  await ensureDb();
  const stats = await dbStats();
  output({ ok: true, command: 'stats', backend, ...stats });
}

async function cmdClear() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  if (fs.existsSync(JSON_PATH)) fs.unlinkSync(JSON_PATH);
  if (fs.existsSync(PENDING_PATH)) fs.writeFileSync(PENDING_PATH, '');
  output({ ok: true, command: 'clear', message: 'TreeNode cache cleared.' });
}

async function cmdExport() {
  await ensureDb();
  const rows = await dbExportAll();
  output({ ok: true, command: 'export', count: rows.length, backend, entries: rows });
}

// ─── Backend: better-sqlite3 ───

function betterSqliteEnsure() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const db = new betterSqlite3(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS treenode (
      path TEXT PRIMARY KEY,
      dir TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT,
      relative_path TEXT,
      last_seen INTEGER,
      access_count INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_treenode_dir ON treenode(dir);
    CREATE INDEX IF NOT EXISTS idx_treenode_ext ON treenode(ext);
  `);
  return db;
}

function betterSqliteIngest(entries) {
  const db = betterSqliteEnsure();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO treenode (path, dir, name, ext, relative_path, last_seen, access_count)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT access_count FROM treenode WHERE path=?), 0) + 1)
  `);
  const tx = db.transaction((items) => {
    for (const e of items) {
      insert.run(e.filePath, e.dir, e.name, e.ext, e.relativePath, e.timestamp, e.filePath);
    }
  });
  tx(entries);
  db.close();
}

function betterSqliteQuery(prefix) {
  const db = betterSqliteEnsure();
  const rows = db.prepare('SELECT path, relative_path, last_seen, access_count FROM treenode WHERE path LIKE ? ORDER BY path')
    .all(prefix + '%');
  db.close();
  return rows;
}

function betterSqliteStats() {
  const db = betterSqliteEnsure();
  const total = db.prepare('SELECT COUNT(*) as total FROM treenode').get();
  const dirs = db.prepare('SELECT COUNT(DISTINCT dir) as dirs FROM treenode').get();
  const exts = db.prepare('SELECT ext, COUNT(*) as count FROM treenode GROUP BY ext ORDER BY count DESC LIMIT 10').all();
  db.close();
  return { total_files: total.total, unique_dirs: dirs.dirs, top_extensions: exts };
}

function betterSqliteExportAll() {
  const db = betterSqliteEnsure();
  const rows = db.prepare('SELECT path, relative_path, dir, name, ext, last_seen, access_count FROM treenode ORDER BY path').all();
  db.close();
  return rows;
}

// ─── Backend: sql.js (WASM) ───

async function sqlJsOpen() {
  const SQL = await sqlJsInit();
  let db;
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS treenode (
      path TEXT PRIMARY KEY,
      dir TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT,
      relative_path TEXT,
      last_seen INTEGER,
      access_count INTEGER DEFAULT 1
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_treenode_dir ON treenode(dir)'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_treenode_ext ON treenode(ext)'); } catch (e) {}
  return { SQL, db };
}

function sqlJsSave(db) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buf);
}

async function sqlJsIngest(entries) {
  const { db } = await sqlJsOpen();
  db.run('BEGIN TRANSACTION');
  for (const e of entries) {
    // Get current count — parameterized query (AUDIT-031)
    const stmt = db.prepare('SELECT access_count FROM treenode WHERE path=?');
    stmt.bind([e.filePath]);
    const count = stmt.step() ? stmt.get()[0] : 0;
    stmt.free();
    db.run(
      `INSERT OR REPLACE INTO treenode (path, dir, name, ext, relative_path, last_seen, access_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e.filePath, e.dir, e.name, e.ext, e.relativePath, e.timestamp, count + 1]
    );
  }
  db.run('COMMIT');
  sqlJsSave(db);
  db.close();
}

async function sqlJsQuery(prefix) {
  const { db } = await sqlJsOpen();
  // Parameterized LIKE query (AUDIT-031) — bind prefix with wildcard appended
  const stmt = db.prepare('SELECT path, relative_path, last_seen, access_count FROM treenode WHERE path LIKE ? ORDER BY path');
  stmt.bind([prefix + '%']);
  const rows = [];
  while (stmt.step()) {
    const r = stmt.get();
    rows.push({ path: r[0], relative_path: r[1], last_seen: r[2], access_count: r[3] });
  }
  stmt.free();
  db.close();
  return rows;
}

async function sqlJsStats() {
  const { db } = await sqlJsOpen();
  const total = db.exec('SELECT COUNT(*) FROM treenode');
  const dirs = db.exec('SELECT COUNT(DISTINCT dir) FROM treenode');
  const exts = db.exec('SELECT ext, COUNT(*) as count FROM treenode GROUP BY ext ORDER BY count DESC LIMIT 10');
  db.close();
  return {
    total_files: total.length > 0 ? total[0].values[0][0] : 0,
    unique_dirs: dirs.length > 0 ? dirs[0].values[0][0] : 0,
    top_extensions: exts.length > 0 ? exts[0].values.map(r => ({ ext: r[0], count: r[1] })) : []
  };
}

async function sqlJsExportAll() {
  const { db } = await sqlJsOpen();
  const result = db.exec('SELECT path, relative_path, dir, name, ext, last_seen, access_count FROM treenode ORDER BY path');
  db.close();
  if (result.length === 0) return [];
  return result[0].values.map(r => ({
    path: r[0], relative_path: r[1], dir: r[2], name: r[3], ext: r[4], last_seen: r[5], access_count: r[6]
  }));
}

// ─── Backend: sqlite3 CLI ───

function cliRunSql(sql) {
  try {
    execSync(`sqlite3 "${DB_PATH}" "${sql.replace(/"/g, '\\"')}"`, { stdio: 'pipe', timeout: 10000 });
  } catch (e) {
    const tmpSql = path.join(CACHE_DIR, '_tmp.sql');
    fs.writeFileSync(tmpSql, sql);
    try { execSync(`sqlite3 "${DB_PATH}" < "${tmpSql}"`, { stdio: 'pipe', timeout: 10000 }); } catch (e2) {}
    try { fs.unlinkSync(tmpSql); } catch (e3) {}
  }
}

function cliRunQuery(sql) {
  try {
    const tmpSql = path.join(CACHE_DIR, '_query.sql');
    fs.writeFileSync(tmpSql, `.mode json\n${sql}`);
    const result = execSync(`sqlite3 "${DB_PATH}" < "${tmpSql}"`, {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000
    }).toString().trim();
    try { fs.unlinkSync(tmpSql); } catch (e) {}
    return result ? JSON.parse(result) : [];
  } catch (e) {
    return [];
  }
}

function cliEnsure() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    cliRunSql(`
      CREATE TABLE IF NOT EXISTS treenode (
        path TEXT PRIMARY KEY, dir TEXT NOT NULL, name TEXT NOT NULL,
        ext TEXT, relative_path TEXT, last_seen INTEGER, access_count INTEGER DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_treenode_dir ON treenode(dir);
      CREATE INDEX IF NOT EXISTS idx_treenode_ext ON treenode(ext);
    `);
  }
}

function cliIngest(entries) {
  cliEnsure();
  const stmts = entries.map(e =>
    `INSERT OR REPLACE INTO treenode (path, dir, name, ext, relative_path, last_seen, access_count) ` +
    `VALUES ('${esc(e.filePath)}', '${esc(e.dir)}', '${esc(e.name)}', '${esc(e.ext)}', '${esc(e.relativePath)}', ` +
    `${e.timestamp}, COALESCE((SELECT access_count FROM treenode WHERE path='${esc(e.filePath)}'), 0) + 1);`
  );
  cliRunSql(`BEGIN TRANSACTION;\n${stmts.join('\n')}\nCOMMIT;`);
}

function cliQuery(prefix) {
  cliEnsure();
  return cliRunQuery(`SELECT path, relative_path, last_seen, access_count FROM treenode WHERE path LIKE '${esc(prefix)}%' ORDER BY path;`);
}

function cliStats() {
  cliEnsure();
  const total = cliRunQuery('SELECT COUNT(*) as total FROM treenode;');
  const dirs = cliRunQuery('SELECT COUNT(DISTINCT dir) as dirs FROM treenode;');
  const exts = cliRunQuery('SELECT ext, COUNT(*) as count FROM treenode GROUP BY ext ORDER BY count DESC LIMIT 10;');
  return {
    total_files: total[0] ? total[0].total : 0,
    unique_dirs: dirs[0] ? dirs[0].dirs : 0,
    top_extensions: exts
  };
}

function cliExportAll() {
  cliEnsure();
  return cliRunQuery('SELECT path, relative_path, dir, name, ext, last_seen, access_count FROM treenode ORDER BY path;');
}

// ─── Backend: JSON file fallback ───

function jsonLoad() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (fs.existsSync(JSON_PATH)) {
    try { return JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8')); } catch (e) {}
  }
  return {};
}

function jsonSave(data) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(data));
}

function jsonIngest(entries) {
  const data = jsonLoad();
  for (const e of entries) {
    const existing = data[e.filePath];
    data[e.filePath] = {
      path: e.filePath, dir: e.dir, name: e.name, ext: e.ext,
      relative_path: e.relativePath, last_seen: e.timestamp,
      access_count: (existing ? existing.access_count : 0) + 1
    };
  }
  jsonSave(data);
}

function jsonQuery(prefix) {
  const data = jsonLoad();
  return Object.values(data)
    .filter(e => e.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(e => ({ path: e.path, relative_path: e.relative_path, last_seen: e.last_seen, access_count: e.access_count }));
}

function jsonStats() {
  const data = jsonLoad();
  const entries = Object.values(data);
  const dirs = new Set(entries.map(e => e.dir));
  const extMap = {};
  entries.forEach(e => { extMap[e.ext] = (extMap[e.ext] || 0) + 1; });
  const exts = Object.entries(extMap).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, count]) => ({ ext, count }));
  return { total_files: entries.length, unique_dirs: dirs.size, top_extensions: exts };
}

function jsonExportAll() {
  const data = jsonLoad();
  return Object.values(data).sort((a, b) => a.path.localeCompare(b.path));
}

// ─── Dispatch to active backend ───

async function ensureDb() {
  if (backend === 'better-sqlite3') betterSqliteEnsure();
  else if (backend === 'sql.js') await sqlJsOpen();
  else if (backend === 'cli') cliEnsure();
  // json needs no init
}

async function dbIngest(entries) {
  if (backend === 'better-sqlite3') return betterSqliteIngest(entries);
  if (backend === 'sql.js') return await sqlJsIngest(entries);
  if (backend === 'cli') return cliIngest(entries);
  return jsonIngest(entries);
}

async function dbQuery(prefix) {
  if (backend === 'better-sqlite3') return betterSqliteQuery(prefix);
  if (backend === 'sql.js') return await sqlJsQuery(prefix);
  if (backend === 'cli') return cliQuery(prefix);
  return jsonQuery(prefix);
}

async function dbStats() {
  if (backend === 'better-sqlite3') return betterSqliteStats();
  if (backend === 'sql.js') return await sqlJsStats();
  if (backend === 'cli') return cliStats();
  return jsonStats();
}

async function dbExportAll() {
  if (backend === 'better-sqlite3') return betterSqliteExportAll();
  if (backend === 'sql.js') return await sqlJsExportAll();
  if (backend === 'cli') return cliExportAll();
  return jsonExportAll();
}

// ─── Utilities ───

function esc(str) {
  return (str || '')
    .replace(/\0/g, '')       // Strip NULL bytes
    .replace(/\\/g, '\\\\')   // Double backslashes
    .replace(/'/g, "''");     // Escape single quotes
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2));
}
