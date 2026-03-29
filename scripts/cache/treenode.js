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
 * Requires: better-sqlite3 (npm) or sqlite3 CLI
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CWD = process.cwd();
const VELA_DIR = path.join(CWD, '.vela');
const CACHE_DIR = path.join(VELA_DIR, 'cache');
const DB_PATH = path.join(CACHE_DIR, 'vela-cache.db');
const PENDING_PATH = path.join(CACHE_DIR, 'pending-paths.jsonl');

const args = process.argv.slice(2);
const command = args[0] || 'ingest';

// Check if sqlite3 CLI is available
let sqliteAvailable = false;
try {
  execSync('which sqlite3', { stdio: 'pipe' });
  sqliteAvailable = true;
} catch (e) {
  // Will try better-sqlite3 npm package
}

const commands = {
  ingest: cmdIngest,
  query: cmdQuery,
  stats: cmdStats,
  clear: cmdClear,
  export: cmdExport
};

if (!commands[command]) {
  output({ ok: false, error: `Unknown command: ${command}`, available: Object.keys(commands) });
  process.exit(1);
}

commands[command]();

// ─── Commands ───

function cmdIngest() {
  ensureDb();

  if (!fs.existsSync(PENDING_PATH)) {
    return output({ ok: true, command: 'ingest', ingested: 0, message: 'No pending paths.' });
  }

  const lines = fs.readFileSync(PENDING_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  let ingested = 0;
  const insertStmts = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const filePath = entry.path;
      const dir = path.dirname(filePath);
      const name = path.basename(filePath);
      const ext = path.extname(filePath);
      const relativePath = path.relative(CWD, filePath);

      insertStmts.push(
        `INSERT OR REPLACE INTO treenode (path, dir, name, ext, relative_path, last_seen, access_count) ` +
        `VALUES ('${esc(filePath)}', '${esc(dir)}', '${esc(name)}', '${esc(ext)}', '${esc(relativePath)}', ` +
        `${entry.timestamp || Date.now()}, COALESCE((SELECT access_count FROM treenode WHERE path='${esc(filePath)}'), 0) + 1);`
      );
      ingested++;
    } catch (e) {
      continue;
    }
  }

  if (insertStmts.length > 0) {
    const sql = `BEGIN TRANSACTION;\n${insertStmts.join('\n')}\nCOMMIT;`;
    runSql(sql);
  }

  // Clear pending file after ingestion
  try {
    fs.writeFileSync(PENDING_PATH, '');
  } catch (e) {}

  output({
    ok: true,
    command: 'ingest',
    ingested: ingested,
    message: `Ingested ${ingested} paths into TreeNode cache.`
  });
}

function cmdQuery() {
  ensureDb();

  const prefix = args[1] || CWD;
  const sql = `SELECT path, relative_path, last_seen, access_count FROM treenode WHERE path LIKE '${esc(prefix)}%' ORDER BY path;`;
  const result = runSqlQuery(sql);

  output({
    ok: true,
    command: 'query',
    prefix: prefix,
    count: result.length,
    paths: result
  });
}

function cmdStats() {
  ensureDb();

  const totalSql = `SELECT COUNT(*) as total FROM treenode;`;
  const dirsSql = `SELECT COUNT(DISTINCT dir) as dirs FROM treenode;`;
  const extsSql = `SELECT ext, COUNT(*) as count FROM treenode GROUP BY ext ORDER BY count DESC LIMIT 10;`;

  const total = runSqlQuery(totalSql);
  const dirs = runSqlQuery(dirsSql);
  const exts = runSqlQuery(extsSql);

  output({
    ok: true,
    command: 'stats',
    total_files: total[0] ? total[0].total : 0,
    unique_dirs: dirs[0] ? dirs[0].dirs : 0,
    top_extensions: exts
  });
}

function cmdClear() {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }
  if (fs.existsSync(PENDING_PATH)) {
    fs.writeFileSync(PENDING_PATH, '');
  }

  output({ ok: true, command: 'clear', message: 'TreeNode cache cleared.' });
}

function cmdExport() {
  ensureDb();

  const sql = `SELECT path, relative_path, dir, name, ext, last_seen, access_count FROM treenode ORDER BY path;`;
  const result = runSqlQuery(sql);

  output({
    ok: true,
    command: 'export',
    count: result.length,
    entries: result
  });
}

// ─── SQLite Helpers ───

function ensureDb() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_PATH)) {
    const createSql = `
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
`;
    runSql(createSql);
  }
}

function runSql(sql) {
  if (sqliteAvailable) {
    try {
      execSync(`sqlite3 "${DB_PATH}" "${sql.replace(/"/g, '\\"')}"`, {
        stdio: 'pipe',
        timeout: 10000
      });
    } catch (e) {
      // Fallback: write SQL to temp file
      const tmpSql = path.join(CACHE_DIR, '_tmp.sql');
      fs.writeFileSync(tmpSql, sql);
      try {
        execSync(`sqlite3 "${DB_PATH}" < "${tmpSql}"`, { stdio: 'pipe', timeout: 10000 });
      } catch (e2) {}
      try { fs.unlinkSync(tmpSql); } catch (e3) {}
    }
  } else {
    // Write SQL for later execution
    const batchPath = path.join(CACHE_DIR, 'pending-sql.sql');
    fs.appendFileSync(batchPath, sql + '\n');
  }
}

function runSqlQuery(sql) {
  if (!sqliteAvailable) return [];

  try {
    const tmpSql = path.join(CACHE_DIR, '_query.sql');
    fs.writeFileSync(tmpSql, `.mode json\n${sql}`);
    const result = execSync(`sqlite3 "${DB_PATH}" < "${tmpSql}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    }).toString().trim();
    try { fs.unlinkSync(tmpSql); } catch (e) {}
    return result ? JSON.parse(result) : [];
  } catch (e) {
    return [];
  }
}

function esc(str) {
  return (str || '').replace(/'/g, "''");
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2));
}
