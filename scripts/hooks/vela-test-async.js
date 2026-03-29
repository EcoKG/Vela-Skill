#!/usr/bin/env node
/**
 * Vela Async Test Runner Hook (PostToolUse)
 *
 * Runs related tests in the background after Write/Edit operations.
 * Results are delivered via systemMessage JSON on stdout.
 *
 * NOTE: This is a placeholder — T02 implements the full logic.
 */

'use strict';

try {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    // Placeholder: graceful no-op until T02 implements full logic
    process.exit(0);
  });
} catch (e) {
  // Hook must never crash (K004)
  process.exit(0);
}
