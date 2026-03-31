/**
 * Vela HMAC Utility Module
 * Provides HMAC-SHA256 signing and verification for JSON objects and files.
 *
 * Used to protect delegation.json from forgery and review-*.md from tampering.
 * Key is stored at `.vela/state/hmac-key` (generated once per pipeline init).
 *
 * Exports: generateKey, signJSON, verifyJSON, signFile, verifyFile, readKey
 *
 * Design decisions:
 * - Canonical JSON: sorted keys, _hmac excluded before signing
 * - Timing-safe comparison for all verification to prevent timing attacks
 * - Companion .hmac files for file signing (keeps originals untouched)
 * - readKey returns null on any error (missing dir, missing file, permissions)
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Key Generation ───

/**
 * Generate a new 256-bit HMAC key as a hex string.
 * @returns {string} 64-character hex string
 */
function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── JSON Signing ───

/**
 * Compute HMAC-SHA256 over a canonical JSON representation of obj.
 * Keys are sorted alphabetically; the `_hmac` field is excluded.
 * @param {Object} obj - Object to sign
 * @param {string} keyHex - 64-char hex HMAC key
 * @returns {string} 64-char hex HMAC digest
 */
function signJSON(obj, keyHex) {
  const copy = Object.assign({}, obj);
  delete copy._hmac;

  const sortedKeys = Object.keys(copy).sort();
  const canonical = JSON.stringify(copy, sortedKeys);

  return crypto
    .createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(canonical)
    .digest('hex');
}

/**
 * Verify that obj._hmac matches the HMAC of the remaining fields.
 * Uses timing-safe comparison to prevent timing attacks.
 * @param {Object} obj - Object with `_hmac` field
 * @param {string} keyHex - 64-char hex HMAC key
 * @returns {boolean} true if signature is valid
 */
function verifyJSON(obj, keyHex) {
  if (!obj || !obj._hmac || !keyHex) return false;

  const expected = signJSON(obj, keyHex);

  // Both are hex strings of the same length (64 chars), safe for timingSafeEqual
  const a = Buffer.from(obj._hmac, 'hex');
  const b = Buffer.from(expected, 'hex');

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

// ─── File Signing ───

/**
 * Compute HMAC-SHA256 of a file's contents and write to a companion .hmac file.
 * @param {string} filePath - Path to the file to sign
 * @param {string} keyHex - 64-char hex HMAC key
 * @returns {string} 64-char hex HMAC digest
 */
function signFile(filePath, keyHex) {
  const content = fs.readFileSync(filePath, 'utf8');

  const hmac = crypto
    .createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(content)
    .digest('hex');

  fs.writeFileSync(filePath + '.hmac', hmac, 'utf8');
  return hmac;
}

/**
 * Verify a file against its companion .hmac file.
 * Uses timing-safe comparison to prevent timing attacks.
 * @param {string} filePath - Path to the file to verify
 * @param {string} keyHex - 64-char hex HMAC key
 * @returns {boolean} true if file content matches stored HMAC
 */
function verifyFile(filePath, keyHex) {
  if (!keyHex) return false;

  try {
    const storedHmac = fs.readFileSync(filePath + '.hmac', 'utf8').trim();
    const content = fs.readFileSync(filePath, 'utf8');

    const expected = crypto
      .createHmac('sha256', Buffer.from(keyHex, 'hex'))
      .update(content)
      .digest('hex');

    const a = Buffer.from(storedHmac, 'hex');
    const b = Buffer.from(expected, 'hex');

    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
  } catch (_err) {
    return false;
  }
}

// ─── Key Management ───

/**
 * Read the HMAC key from `.vela/state/hmac-key`.
 * @param {string} velaDir - Path to the .vela directory
 * @returns {string|null} Hex key string, or null if not found
 */
function readKey(velaDir) {
  try {
    return fs.readFileSync(path.join(velaDir, 'state', 'hmac-key'), 'utf8').trim();
  } catch (_err) {
    return null;
  }
}

module.exports = {
  generateKey,
  signJSON,
  verifyJSON,
  signFile,
  verifyFile,
  readKey,
};
