/**
 * Vela Global Require Helper
 *
 * Node.js require()/import()는 로컬 node_modules만 탐색한다.
 * npm install -g로 설치한 패키지를 심링크 없이 해석하려면
 * 글로벌 npm root 경로를 fallback으로 사용해야 한다.
 *
 * Usage:
 *   const { globalRequire, globalImport } = require('./shared/global-require');
 *   const playwright = globalRequire('playwright');
 *   const sdk = await globalImport('@anthropic-ai/claude-agent-sdk');
 */

const path = require("path");
const { execSync } = require("child_process");

let _globalRoot = null;

/** npm root -g 결과를 캐시하여 반환 */
function getGlobalRoot() {
  if (_globalRoot) return _globalRoot;
  try {
    _globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch {
    _globalRoot = null;
  }
  return _globalRoot;
}

/**
 * require() with global fallback.
 * 1. 로컬 require() 시도
 * 2. 실패 시 글로벌 npm root에서 require()
 * @param {string} pkgName - 패키지 이름 (e.g. 'playwright', 'better-sqlite3')
 * @returns {any} 모듈
 */
function globalRequire(pkgName) {
  try {
    return require(pkgName);
  } catch {
    const root = getGlobalRoot();
    if (!root) throw new Error(`Cannot find module '${pkgName}' (local and global)`);
    return require(path.join(root, pkgName));
  }
}

/**
 * import() with global fallback (for ESM packages).
 * 1. 로컬 import() 시도
 * 2. 실패 시 글로벌 npm root에서 createRequire().resolve()로 엔트리포인트 해석 후 import()
 *    — ESM import()는 디렉토리 경로를 거부(ERR_UNSUPPORTED_DIR_IMPORT)하므로
 *      createRequire를 사용하여 package.json exports 맵을 해석한 실제 파일 경로를 얻는다.
 * @param {string} pkgName - 패키지 이름
 * @returns {Promise<any>} 모듈
 */
async function globalImport(pkgName) {
  try {
    return await import(pkgName);
  } catch {
    const root = getGlobalRoot();
    if (!root) throw new Error(`Cannot find module '${pkgName}' (local and global)`);
    const { createRequire } = require("module");
    const req = createRequire(path.join(root, "noop.js"));
    const resolved = req.resolve(pkgName);
    return await import(resolved);
  }
}

module.exports = { globalRequire, globalImport, getGlobalRoot };
