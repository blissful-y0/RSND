# server.cjs Modularization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 3,108-line monolithic `server/node/server.cjs` into focused modules with clear boundaries, enabling testability, maintainability, and future Hono migration.

**Architecture:** Extract 7 modules from `server.cjs` using CJS factory functions for dependency injection. Each module exports a `mount(app, deps)` function (for route modules) or a `create(deps)` function (for utility modules). Shared mutable state lives in a dedicated `dbState.cjs` module. Extraction order follows dependency graph — leaf modules first (inlay, proxy helpers), then modules that depend on them (backup, routes).

**Tech Stack:** Node.js CJS modules, Express.js 4, better-sqlite3, existing `db.cjs` + `utils.cjs`

---

## File Structure

After all tasks are complete:

```
server/node/
├── db.cjs              (UNCHANGED — KV store)
├── utils.cjs           (UNCHANGED — serialization)
├── dbState.cjs         (NEW — database cache, ETag, backup rotation)
├── inlay.cjs           (NEW — inlay file I/O, MIME detection, migration)
├── auth.cjs            (NEW — JWT, sessions, password, middleware)
├── proxy.cjs           (NEW — reverse proxy, stream jobs, WebSocket)
├── backup.cjs          (NEW — backup export/import, asset serving)
├── migration.cjs       (NEW — hex file → SQLite migration)
├── dataRoutes.cjs      (NEW — CRUD: read/write/list/patch/bulk)
├── server.cjs          (MODIFIED — ~180 lines: app setup, middleware, startup)
└── ssl/                (UNCHANGED)
```

## Shared State Map

Before extracting, understand what state is shared across modules:

| State | Owner Module | Consumers |
|-------|-------------|-----------|
| `dbCache`, `saveTimers`, `dbEtag` | `dbState.cjs` | dataRoutes, backup |
| `storageOperationQueue` | `dbState.cjs` | dataRoutes |
| `lastBackupTime` | `dbState.cjs` | (internal) |
| `password` | `auth.cjs` | (internal to auth routes) |
| `jwtSecret` | `auth.cjs` | (internal to auth) |
| `sessions` (Map) | `auth.cjs` | (internal to auth) |
| `activeSessionId` | `auth.cjs` | dataRoutes, backup, migration |
| `proxyStreamJobs` (Map) | `proxy.cjs` | (internal to proxy) |
| `accessTokenCache` | `proxy.cjs` | (internal to proxy) |
| `importInProgress` | `backup.cjs` | migration (via `acquireImportLock`/`releaseImportLock`) |

## Dependency Injection Pattern

Each module uses a factory function that receives dependencies and returns public API:

```js
// Example: module pattern
'use strict';
function createFoo({ kvGet, kvSet }) {
    function doSomething() { /* uses kvGet */ }
    function mountRoutes(app) { app.get('/api/foo', handler); }
    return { doSomething, mountRoutes };
}
module.exports = { createFoo };
```

```js
// In server.cjs — wire everything together
const { createFoo } = require('./foo.cjs');
const foo = createFoo({ kvGet, kvSet });
foo.mountRoutes(app);
```

Why factory functions over module-level state:
- **Testable**: tests can inject mocks without monkey-patching
- **No circular deps**: dependencies flow one direction (server.cjs → modules)
- **Explicit**: every dependency is visible in the factory call

---

## Task 1: Create `dbState.cjs` — Database cache and backup rotation

This is the foundation. All other modules that touch `database.bin` depend on it.

**Files:**
- Create: `server/node/dbState.cjs`
- Create: `server/node/smoke-test.sh` (reused by all subsequent tasks)
- Modify: `server/node/server.cjs` (remove moved code, add require)

**Functions to move from `server.cjs`:**
- `computeBufferEtag()` (line 32)
- `computeDatabaseEtagFromObject()` (line 36)
- `queueStorageOperation()` (line 41)
- `createBackupAndRotate()` (line 54)
- `flushPendingDb()` (line 79)
- `invalidateDbCache()` (line 91)

**Constants to move:**
- `DB_HEX_KEY` (line 47)
- `SAVE_INTERVAL` (line 27)
- `BACKUP_BUDGET_BYTES`, `BACKUP_INTERVAL_MS` (lines 50-51)
- `enablePatchSync` (line 22)

- [ ] **Step 1: Create `server/node/dbState.cjs`**

```js
'use strict';
const nodeCrypto = require('crypto');

function createDbState({ kvGet, kvSet, kvCopyValue, kvList, kvSize, kvDel,
                         encodeRisuSaveLegacy, decodeRisuSave, calculateHash, normalizeJSON }) {
    const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');
    const SAVE_INTERVAL = 5000;
    const BACKUP_BUDGET_BYTES = 500 * 1024 * 1024;
    const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
    const enablePatchSync = true;

    let dbCache = {};
    let saveTimers = {};
    let dbEtag = null;
    let storageOperationQueue = Promise.resolve();
    let lastBackupTime = null;

    function computeBufferEtag(buffer) {
        return nodeCrypto.createHash('md5').update(buffer).digest('hex');
    }

    function computeDatabaseEtagFromObject(databaseObject) {
        return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
    }

    function queueStorageOperation(operation) {
        const operationRun = storageOperationQueue.then(operation, operation);
        storageOperationQueue = operationRun.catch(() => {});
        return operationRun;
    }

    function createBackupAndRotate() {
        const now = Date.now();
        if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
            return;
        }
        lastBackupTime = now;
        const backupKey = `database/dbbackup-${(now / 100).toFixed()}.bin`;
        kvCopyValue('database/database.bin', backupKey);
        const backupKeys = kvList('database/dbbackup-')
            .sort((a, b) => {
                const aTs = parseInt(a.slice(18, -4));
                const bTs = parseInt(b.slice(18, -4));
                return bTs - aTs;
            });
        const dbSize = kvSize('database/database.bin') || 1;
        const maxBackups = Math.min(20, Math.max(3, Math.floor(BACKUP_BUDGET_BYTES / dbSize)));
        while (backupKeys.length > maxBackups) {
            kvDel(backupKeys.pop());
        }
    }

    function flushPendingDb() {
        if (saveTimers[DB_HEX_KEY]) {
            clearTimeout(saveTimers[DB_HEX_KEY]);
            delete saveTimers[DB_HEX_KEY];
            if (dbCache[DB_HEX_KEY]) {
                const data = Buffer.from(encodeRisuSaveLegacy(dbCache[DB_HEX_KEY]));
                kvSet('database/database.bin', data);
                createBackupAndRotate();
            }
        }
    }

    function invalidateDbCache() {
        delete dbCache[DB_HEX_KEY];
        if (saveTimers[DB_HEX_KEY]) {
            clearTimeout(saveTimers[DB_HEX_KEY]);
            delete saveTimers[DB_HEX_KEY];
        }
        dbEtag = null;
    }

    return {
        DB_HEX_KEY,
        SAVE_INTERVAL,
        enablePatchSync,
        get dbEtag() { return dbEtag; },
        set dbEtag(v) { dbEtag = v; },
        get dbCache() { return dbCache; },
        get saveTimers() { return saveTimers; },
        computeBufferEtag,
        computeDatabaseEtagFromObject,
        queueStorageOperation,
        createBackupAndRotate,
        flushPendingDb,
        invalidateDbCache,
    };
}

module.exports = { createDbState };
```

- [ ] **Step 2: Update `server.cjs` to require `dbState.cjs`**

At the top of `server.cjs`, after the existing requires for `db.cjs` and `utils.cjs`, add:

```js
const { createDbState } = require('./dbState.cjs');
const dbState = createDbState({
    kvGet, kvSet, kvCopyValue, kvList, kvSize, kvDel,
    encodeRisuSaveLegacy, calculateHash, normalizeJSON,
    decodeRisuSave,
});
```

Then replace all direct references throughout `server.cjs`:
- `dbCache[...]` → `dbState.dbCache[...]`
- `saveTimers[...]` → `dbState.saveTimers[...]`
- `dbEtag` → `dbState.dbEtag`
- `DB_HEX_KEY` → `dbState.DB_HEX_KEY`
- `SAVE_INTERVAL` → `dbState.SAVE_INTERVAL`
- `enablePatchSync` → `dbState.enablePatchSync`
- `computeBufferEtag(...)` → `dbState.computeBufferEtag(...)`
- `computeDatabaseEtagFromObject(...)` → `dbState.computeDatabaseEtagFromObject(...)`
- `queueStorageOperation(...)` → `dbState.queueStorageOperation(...)`
- `createBackupAndRotate()` → `dbState.createBackupAndRotate()`
- `flushPendingDb()` → `dbState.flushPendingDb()`
- `invalidateDbCache()` → `dbState.invalidateDbCache()`

Delete the original function definitions and constants (lines 22-98).

- [ ] **Step 3: Create smoke test script** (first time only — reuse in later tasks)

Create `server/node/smoke-test.sh` as defined in the Smoke Test Script section above.

```bash
chmod +x server/node/smoke-test.sh
```

- [ ] **Step 4: Verify — module loads, server starts, smoke tests pass**

```bash
cd /Users/bliss/Documents/RSND && node -e "require('./server/node/dbState.cjs')" && echo "Module loads OK"
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh
pnpm test
kill $SERVER_PID 2>/dev/null || true
```

Expected: All smoke tests pass, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/node/dbState.cjs server/node/smoke-test.sh server/node/server.cjs
git commit -m "refactor: extract dbState.cjs from server.cjs

Move database cache state management (dbCache, saveTimers, dbEtag),
backup rotation, and storage operation queue into a dedicated module
with factory function for dependency injection.

Add smoke-test.sh for per-task regression verification."
```

---

## Task 2: Create `inlay.cjs` — Inlay file operations

Self-contained module — all inlay file I/O, MIME detection, data URI handling, and filesystem migration.

**Files:**
- Create: `server/node/inlay.cjs`
- Modify: `server/node/server.cjs` (remove moved code, add require)

**Functions to move (lines 190-518, 559-575):**
- `isSafeInlayId`, `normalizeInlayExt`, `assertInsideInlayDir`
- `getInlayFilePath`, `getInlaySidecarPath`
- `ensureInlayDir`, `ensureInlayDirSync`
- `getMimeFromExt`, `decodeDataUri`, `encodeDataUri`
- `detectMime`, `ASSET_EXT_MIME`
- `readInlaySidecar`, `resolveInlayFilePath`, `resolveInlayFilePathSync`
- `readInlayFile`, `writeInlaySidecar`, `writeInlaySidecarSync`
- `writeInlayFile`, `writeInlayFileSync`
- `deleteInlayRawFile`, `deleteInlayRawFileSync`, `deleteInlayFile`, `deleteInlayFileSync`
- `listInlayFiles`, `readInlayLegacyInfo`, `readInlayInfoPayload`, `readInlayAssetPayload`
- `migrateInlaysToFilesystem`

- [ ] **Step 1: Create `server/node/inlay.cjs`**

```js
'use strict';
const path = require('path');
const fs = require('fs/promises');
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } = require('fs');

function createInlay({ inlayDir, kvGet, kvDel, kvList }) {
    const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs');
    const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

    // MIME detection by magic bytes
    function detectMime(buf) { /* move from server.cjs:559-568 unchanged */ }

    const ASSET_EXT_MIME = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp',
        mp4: 'video/mp4', webm: 'video/webm',
        mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    };

    function isSafeInlayId(id) { /* move from :190-198 */ }
    function normalizeInlayExt(ext) { /* move from :200-204 */ }
    function assertInsideInlayDir(filePath) { /* move from :208-211 */ }
    function getInlayFilePath(id, ext) { /* move from :214-218 */ }
    function getInlaySidecarPath(id) { /* move from :221-225 */ }
    async function ensureInlayDir() { /* move from :228-230 */ }
    function ensureInlayDirSync() { /* move from :232-236 */ }
    function getMimeFromExt(ext, buffer) { /* move from :238-240 */ }
    function decodeDataUri(dataUri) { /* move from :242-255 */ }
    function encodeDataUri(buffer, mime) { /* move from :257-259 */ }
    async function readInlaySidecar(id) { /* move from :261-275 */ }
    async function resolveInlayFilePath(id) { /* move from :277-296 */ }
    function resolveInlayFilePathSync(id) { /* move from :298-319 */ }
    async function readInlayFile(id) { /* move from :321-334 */ }
    async function writeInlaySidecar(id, info) { /* move from :336-346 */ }
    function writeInlaySidecarSync(id, info) { /* move from :348-358 */ }
    async function writeInlayFile(id, ext, buffer, info) { /* move from :360-369 */ }
    function writeInlayFileSync(id, ext, buffer, info) { /* move from :371-380 */ }
    async function deleteInlayRawFile(id) { /* move from :382-386 */ }
    function deleteInlayRawFileSync(id) { /* move from :388-396 */ }
    async function deleteInlayFile(id) { /* move from :398-401 */ }
    function deleteInlayFileSync(id) { /* move from :403-410 */ }
    async function listInlayFiles() { /* move from :412-427 */ }
    async function readInlayLegacyInfo(id) { /* move from :429-444 */ }
    async function readInlayInfoPayload(id) { /* move from :446-452 */ }
    async function readInlayAssetPayload(id) { /* move from :454-472 */ }
    async function migrateInlaysToFilesystem() { /* move from :474-518 */ }

    return {
        ASSET_EXT_MIME,
        isSafeInlayId, normalizeInlayExt,
        getInlayFilePath, getInlaySidecarPath,
        ensureInlayDir, ensureInlayDirSync,
        detectMime, getMimeFromExt, decodeDataUri, encodeDataUri,
        readInlaySidecar, resolveInlayFilePath, resolveInlayFilePathSync,
        readInlayFile, writeInlaySidecar, writeInlaySidecarSync,
        writeInlayFile, writeInlayFileSync,
        deleteInlayRawFile, deleteInlayRawFileSync,
        deleteInlayFile, deleteInlayFileSync,
        listInlayFiles, readInlayLegacyInfo,
        readInlayInfoPayload, readInlayAssetPayload,
        migrateInlaysToFilesystem,
    };
}

module.exports = { createInlay };
```

Each function body is moved verbatim from `server.cjs` — only the closure variables change (e.g., `inlayDir` comes from factory parameter instead of module-level `const`).

- [ ] **Step 2: Update `server.cjs`**

After the `dbState` creation, add:

```js
const { createInlay } = require('./inlay.cjs');
const inlay = createInlay({ inlayDir, kvGet, kvDel, kvList });
```

Replace all `readInlayFile(...)` → `inlay.readInlayFile(...)` etc. throughout `server.cjs`. Delete lines 190-518 and 559-575.

- [ ] **Step 3: Verify — module loads, smoke tests pass**

```bash
node -e "require('./server/node/inlay.cjs')" && echo "OK"
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh && pnpm test
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 5: Commit**

```bash
git add server/node/inlay.cjs server/node/server.cjs
git commit -m "refactor: extract inlay.cjs from server.cjs

Move all inlay file I/O operations (read/write/delete/list/migrate),
MIME detection, and data URI handling into dedicated module."
```

---

## Task 3: Create `auth.cjs` — Authentication and session management

**Files:**
- Create: `server/node/auth.cjs`
- Modify: `server/node/server.cjs`

**Functions/state to move:**
- `password` init (lines 139-150), `jwtSecret` init (lines 152-165)
- `sessions` Map (line 540), `activeSessionId` (line 593)
- `parseSessionCookie()` (line 542), `sessionAuthMiddleware()` (line 552)
- `checkActiveSession()` (line 595)
- `checkAuth()` (line 1204)
- `createServerJwt()` (line 638)
- `isHex()` (line 627), `hashJSON()` (line 631)
- `loginRouteLimiter` (line 618)
- Auth routes: `/api/test_auth`, `/api/login`, `/api/token/refresh`, `/api/session`, `/api/set_password`, `/api/crypto` (lines 1709-1910)

- [ ] **Step 1: Create `server/node/auth.cjs`**

```js
'use strict';
const nodeCrypto = require('crypto');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const rateLimit = require('express-rate-limit');

function createAuth({ savePath, passwordPath, jwtSecretPath }) {
    let password = '';
    if (existsSync(passwordPath)) {
        password = readFileSync(passwordPath, 'utf-8');
    }

    let jwtSecret;
    if (existsSync(jwtSecretPath)) {
        jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim();
    } else {
        jwtSecret = nodeCrypto.randomBytes(64).toString('hex');
        writeFileSync(jwtSecretPath, jwtSecret, 'utf-8');
    }

    const sessions = new Map();
    let activeSessionId = null;
    const hexRegex = /^[0-9a-fA-F]+$/;

    const loginRouteLimiter = rateLimit({
        windowMs: 30 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many attempts. Please wait and try again later.' },
        validate: { xForwardedForHeader: false },
    });

    function isHex(str) { /* move from :627-629 */ }
    async function hashJSON(json) { /* move from :631-635 */ }
    function createServerJwt() { /* move from :638-648 */ }
    function parseSessionCookie(req) { /* move from :542-550 */ }
    function sessionAuthMiddleware(req, res, next) { /* move from :552-556 */ }

    function checkActiveSession(req, res) { /* move from :595-602 */ }

    async function checkAuth(req, res, returnOnlyStatus = false, { allowExpired = false } = {}) {
        /* move from :1204-1287 — uses jwtSecret from closure */
    }

    function mountRoutes(app) {
        app.get('/api/test_auth', async (req, res) => { /* move from :1709-1726 */ });
        app.post('/api/login', loginRouteLimiter, async (req, res) => { /* move from :1728-1739 */ });
        app.post('/api/token/refresh', async (req, res) => { /* move from :1742-1745 */ });
        app.post('/api/session', async (req, res) => { /* move from :1750-1767 */ });
        app.post('/api/set_password', async (req, res) => { /* move from :1901-1910 */ });
        app.post('/api/crypto', async (req, res) => { /* move from :1890-1898 */ });
    }

    return {
        isHex, hashJSON,
        createServerJwt,
        parseSessionCookie,
        sessionAuthMiddleware,
        checkActiveSession,
        checkAuth,
        mountRoutes,
    };
}

module.exports = { createAuth };
```

- [ ] **Step 2: Update `server.cjs`**

```js
const { createAuth } = require('./auth.cjs');
const auth = createAuth({ savePath, passwordPath: passwordPath, jwtSecretPath });
auth.mountRoutes(app);
```

Replace throughout: `checkAuth` → `auth.checkAuth`, `sessionAuthMiddleware` → `auth.sessionAuthMiddleware`, etc.

Delete moved code from `server.cjs`.

- [ ] **Step 3: Verify — module loads, smoke tests pass**

```bash
node -e "require('./server/node/auth.cjs')" && echo "OK"
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh && pnpm test
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 5: Commit**

```bash
git add server/node/auth.cjs server/node/server.cjs
git commit -m "refactor: extract auth.cjs from server.cjs

Move JWT auth, session management, password handling, and all
authentication routes into dedicated module."
```

---

## Task 4: Create `proxy.cjs` — Reverse proxy and stream jobs

Largest extraction. All proxy-related code is self-contained once `checkAuth` is available via dependency injection.

**Files:**
- Create: `server/node/proxy.cjs`
- Modify: `server/node/server.cjs`

**Functions/state to move (lines 604-616, 650-999, 1004-1073, 1289-1630, 1460-1518, 1632-1695):**
- All `PROXY_STREAM_*` constants, `proxyStreamJobs` Map
- `getRequestTimeoutMs`, `createTimeoutController`
- `normalizeAuthHeader`, `isAuthorizedProxyRequest`, `checkProxyAuth`
- `isPrivateIPv4Host`, `isLocalNetworkHost`, `sanitizeTargetUrl`
- `normalizeForwardHeaders`, `normalizeProxyResponseHeaders`
- `normalizeProxyStreamTimeoutMs`, `normalizeHeartbeatSec`
- `requestLocalTargetStream`
- `createProxyStreamJob`, `pushJobEvent`, `markJobDone`, `cleanupJob`, `runProxyStreamJob`
- `setupProxyStreamWebSocket`
- `reverseProxyFunc`, `reverseProxyFunc_get`
- `getSionywAccessToken`, `accessTokenCache`, `hubProxyFunc`
- Stream job routes, all `/proxy*` and `/hub-proxy*` routes

- [ ] **Step 1: Create `server/node/proxy.cjs`**

Factory signature:

```js
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const nodeCrypto = require('crypto');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises');
const { pipeline } = require('stream/promises');
const { WebSocketServer } = require('ws');

function createProxy({ checkAuth, authCodePath, savePath, hubURL }) {
    // All PROXY_STREAM_* constants — move from :604-615
    const proxyStreamJobs = new Map();
    let accessTokenCache = { token: null, expiry: 0 };

    // Move all functions from server.cjs lines 650-999, 1004-1073,
    // 1289-1630, 1460-1518 verbatim into this closure.
    // hubProxyFunc (line 1522) uses hubURL from closure — passed via factory.

    function mountRoutes(app) {
        app.get('/proxy', reverseProxyFunc_get);
        app.get('/proxy2', reverseProxyFunc_get);
        app.get('/hub-proxy/*', hubProxyFunc);
        app.post('/proxy', reverseProxyFunc);
        app.post('/proxy2', reverseProxyFunc);
        app.put('/proxy', reverseProxyFunc);
        app.put('/proxy2', reverseProxyFunc);
        app.delete('/proxy', reverseProxyFunc);
        app.delete('/proxy2', reverseProxyFunc);
        app.post('/hub-proxy/*', hubProxyFunc);

        // Stream job endpoints — move from :1633-1695
        app.post('/proxy-stream-jobs', async (req, res) => { /* ... */ });
        app.delete('/proxy-stream-jobs/:jobId', async (req, res) => { /* ... */ });
    }

    function startGarbageCollection() {
        // Move GC interval from server.cjs :3083-3097
        setInterval(() => { /* ... */ }, 60000);
    }

    return {
        proxyStreamJobs,
        setupProxyStreamWebSocket,
        mountRoutes,
        startGarbageCollection,
    };
}

module.exports = { createProxy };
```

- [ ] **Step 2: Update `server.cjs`**

```js
const { createProxy } = require('./proxy.cjs');
const proxy = createProxy({ checkAuth: auth.checkAuth, authCodePath, savePath, hubURL });
proxy.mountRoutes(app);
// In startServer(): proxy.setupProxyStreamWebSocket(server);
// In main IIFE: proxy.startGarbageCollection();
```

Delete all proxy-related code from `server.cjs`.

- [ ] **Step 3: Verify — module loads, smoke tests pass**

```bash
node -e "require('./server/node/proxy.cjs')" && echo "OK"
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh && pnpm test
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 5: Commit**

```bash
git add server/node/proxy.cjs server/node/server.cjs
git commit -m "refactor: extract proxy.cjs from server.cjs

Move reverse proxy handlers, proxy stream jobs, WebSocket setup,
and all proxy-related utilities into dedicated module (~500 lines)."
```

---

## Task 5: Create `backup.cjs` — Backup export/import and asset serving

**Files:**
- Create: `server/node/backup.cjs`
- Modify: `server/node/server.cjs`

**Functions to move:**
- `encodeBackupEntry` (:1075), `isInvalidBackupPathSegment` (:1084)
- `parseInlayBackupName` (:1097), `parseInlaySidecarBackupName` (:1111)
- `resolveBackupStorageKey` (:1118), `parseBackupChunk` (:1160)
- `checkDiskSpace` (:577)
- `resolveAssetPayload` (:1782), `generateThumbnail` (:1815)
- `THUMB_*` constants (:1811-1813)
- `BACKUP_IMPORT_MAX_BYTES`, `BACKUP_ENTRY_NAME_MAX_BYTES`, `BACKUP_DISK_HEADROOM` (:171-174)
- `importInProgress` flag (:176)
- Routes: `/api/asset/:hexKey` (:1822), `/api/backup/export` (:2302), `/api/backup/import/prepare` (:2408), `/api/backup/import` (:2441)

- [ ] **Step 1: Create `server/node/backup.cjs`**

Factory signature:

```js
function createBackup({ 
    checkAuth, checkActiveSession, sessionAuthMiddleware,
    inlay, dbState, 
    kvGet, kvSet, kvDel, kvDelPrefix, kvList, kvListWithSizes, kvSize, kvGetUpdatedAt,
    clearEntities, checkpointWal, sqliteDb,
    savePath, inlayDir,
}) {
    let importInProgress = false;

    // Move all backup functions from server.cjs into this closure.
    //
    // IMPORTANT — inlay dependency for staging helpers and asset serving:
    // The backup import route (server.cjs:2491-2564) uses normalizeInlayExt,
    // isSafeInlayId, and decodeDataUri in its staging helpers. After extraction
    // these live in inlay.cjs, so staging code must call them via the injected
    // `inlay` dep: inlay.normalizeInlayExt(), inlay.isSafeInlayId(),
    // inlay.decodeDataUri(). Do NOT copy these functions into backup.cjs.
    //
    // Similarly, resolveAssetPayload (server.cjs:1782) uses detectMime and
    // ASSET_EXT_MIME — call via inlay.detectMime(), inlay.ASSET_EXT_MIME.
    //
    // IMPORTANT — queue drain before bulk import:
    // Before starting any bulk SQLite writes (import or migration), call
    // dbState.flushPendingDb() to drain the storageOperationQueue's debounced
    // writes. This prevents a race where a pending PATCH timer fires mid-import.
    // The original code already does this (server.cjs:2733, 2306), but after
    // modularization it must go through dbState explicitly.

    /**
     * Shared import lock — both backup import and migration routes must
     * acquire this before starting, and release in `finally`.
     * Returns true if lock acquired, false if another import is running.
     */
    function acquireImportLock() {
        if (importInProgress) return false;
        importInProgress = true;
        return true;
    }

    function releaseImportLock() {
        importInProgress = false;
    }

    function mountRoutes(app) {
        app.get('/api/asset/:hexKey', sessionAuthMiddleware, async (req, res) => { /* :1822-1888 */ });
        app.get('/api/backup/export', async (req, res, next) => { /* :2302-2405 */ });
        app.post('/api/backup/import/prepare', async (req, res, next) => { /* :2408-2439 */ });
        app.post('/api/backup/import', async (req, res, next) => {
            // 1. if (!acquireImportLock()) { res.status(409)...; return; }
            // 2. dbState.flushPendingDb() — drain pending PATCH writes before bulk SQLite ops
            // 3. ... import logic (server.cjs:2441-2692) ...
            //    Staging helpers must use inlay.normalizeInlayExt(), inlay.isSafeInlayId(),
            //    inlay.decodeDataUri() — NOT local copies.
            // 4. dbState.invalidateDbCache() — prevent stale timer writes after import
            // 5. In finally: releaseImportLock();
        });
    }

    return { mountRoutes, acquireImportLock, releaseImportLock };
}

module.exports = { createBackup };
```

- [ ] **Step 2: Update `server.cjs`**

```js
const { createBackup } = require('./backup.cjs');
const backup = createBackup({
    checkAuth: auth.checkAuth,
    checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware,
    inlay, dbState,
    kvGet, kvSet, kvDel, kvDelPrefix, kvList, kvListWithSizes, kvSize, kvGetUpdatedAt,
    clearEntities, checkpointWal, sqliteDb,
    savePath, inlayDir,
});
backup.mountRoutes(app);
```

- [ ] **Step 3: Verify — module loads, smoke tests pass**

```bash
node -e "require('./server/node/backup.cjs')" && echo "OK"
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh && pnpm test
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 5: Commit**

```bash
git add server/node/backup.cjs server/node/server.cjs
git commit -m "refactor: extract backup.cjs from server.cjs

Move backup export/import, asset serving, backup binary encoding,
and disk space checking into dedicated module."
```

---

## Task 6: Create `migration.cjs` — Hex file migration

**Files:**
- Create: `server/node/migration.cjs`
- Modify: `server/node/server.cjs`

**Functions to move (lines 2694-2937, 2941-3004):**
- `scanHexFilesInDir`, `clearExistingData`, `importHexFilesFromDir`, `importHexEntries`
- Migration routes: `/api/migrate/save-folder/*` (5 routes)
- `/api/inlays/compress` route (:2943-3004)

- [ ] **Step 1: Create `server/node/migration.cjs`**

```js
function createMigration({
    checkAuth, checkActiveSession, sessionAuthMiddleware,
    inlay, dbState,
    acquireImportLock, releaseImportLock,
    kvDelPrefix, clearEntities, sqliteDb,
    savePath,
}) {
    const migrationMarkerPath = path.join(savePath, '.migrated_to_sqlite');

    // importHexFilesFromDir and importHexEntries must call
    // dbState.flushPendingDb() before bulk SQLite writes and
    // dbState.invalidateDbCache() after — same as original (server.cjs:2733-2736).

    function scanHexFilesInDir(dirPath) { /* move from :2697-2717 */ }
    function clearExistingData() { /* move from :2719-2726 */ }
    function importHexFilesFromDir(dirPath) { /* move from :2728-2754 */ }
    function importHexEntries(entries) { /* move from :2756-2780 */ }

    function mountRoutes(app) {
        app.post('/api/migrate/save-folder/scan', ...);      // :2782-2803
        app.post('/api/migrate/save-folder/execute', async (req, res, next) => {
            // 1. if (!acquireImportLock()) { res.status(409)...; return; }
            // 2. dbState.flushPendingDb() — drain before bulk writes
            // 3. importHexFilesFromDir(resolved)
            // 4. In finally: releaseImportLock();
            // :2805-2833
        });
        app.post('/api/migrate/save-folder/upload', async (req, res, next) => {
            // 1. if (!acquireImportLock()) { res.status(409)...; return; }
            // 2. dbState.flushPendingDb() — drain before bulk writes
            // 3. importHexEntries(entries)
            // 4. In finally: releaseImportLock();
            // :2835-2897
        });
        app.post('/api/migrate/save-folder/cleanup/scan', ...);    // :2899-2912
        app.post('/api/migrate/save-folder/cleanup/execute', ...); // :2914-2937
        app.post('/api/inlays/compress', sessionAuthMiddleware, ...); // :2943-3004
    }

    return { mountRoutes };
}

module.exports = { createMigration };
```

- [ ] **Step 2: Update `server.cjs`**

```js
const { createMigration } = require('./migration.cjs');
const migration = createMigration({
    checkAuth: auth.checkAuth,
    checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware,
    inlay, dbState,
    acquireImportLock: backup.acquireImportLock,
    releaseImportLock: backup.releaseImportLock,
    kvDelPrefix, clearEntities, sqliteDb,
    savePath,
});
migration.mountRoutes(app);
```

- [ ] **Step 3: Verify — module loads, smoke tests pass**

```bash
node -e "require('./server/node/migration.cjs')" && echo "OK"
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh && pnpm test
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 5: Commit**

```bash
git add server/node/migration.cjs server/node/server.cjs
git commit -m "refactor: extract migration.cjs from server.cjs

Move hex file migration, save-folder import, and inlay compression
into dedicated module."
```

---

## Task 7: Create `dataRoutes.cjs` — Data CRUD routes

**Files:**
- Create: `server/node/dataRoutes.cjs`
- Modify: `server/node/server.cjs`

**Routes to move:**
- `/api/read` (:1912), `/api/remove` (:1962), `/api/list` (:1995)
- `/api/write` (:2017), `/api/db/flush` (:2092), `/api/patch` (:2108)
- `/api/assets/bulk-read` (:2212), `/api/assets/bulk-write` (:2280)
- `BULK_BATCH` constant (:2210)

- [ ] **Step 1: Create `server/node/dataRoutes.cjs`**

```js
function createDataRoutes({
    checkAuth, checkActiveSession, sessionAuthMiddleware, isHex,
    inlay, dbState,
    kvGet, kvSet, kvDel, kvList, sqliteDb,
    decodeRisuSave, encodeRisuSaveLegacy, calculateHash, normalizeJSON,
    applyPatch,
}) {
    const BULK_BATCH = 50;
    // isHex comes from deps (injected from auth.cjs) — no direct require

    function mountRoutes(app) {
        app.get('/api/read', async (req, res, next) => { /* :1912-1960 */ });
        app.get('/api/remove', async (req, res, next) => { /* :1962-1993 */ });
        app.get('/api/list', async (req, res, next) => { /* :1995-2015 */ });
        app.post('/api/write', async (req, res, next) => { /* :2017-2090 */ });
        app.post('/api/db/flush', sessionAuthMiddleware, async (req, res, next) => { /* :2092-2105 */ });
        app.post('/api/patch', async (req, res, next) => { /* :2108-2207 */ });
        app.post('/api/assets/bulk-read', async (req, res, next) => { /* :2212-2278 */ });
        app.post('/api/assets/bulk-write', async (req, res, next) => { /* :2280-2300 */ });
    }

    return { mountRoutes };
}

module.exports = { createDataRoutes };
```

Note: `isHex` moves to `auth.cjs` in Task 3. `dataRoutes.cjs` receives it **only** via deps — no `require('./auth.cjs')` inside the module (keeps the factory injection pattern consistent and avoids potential circular deps).

- [ ] **Step 2: Update `server.cjs`**

```js
const { createDataRoutes } = require('./dataRoutes.cjs');
const dataRoutes = createDataRoutes({
    checkAuth: auth.checkAuth,
    checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware,
    isHex: auth.isHex,
    inlay, dbState,
    kvGet, kvSet, kvDel, kvList, sqliteDb,
    decodeRisuSave, encodeRisuSaveLegacy, calculateHash, normalizeJSON,
    applyPatch,
});
dataRoutes.mountRoutes(app);
```

- [ ] **Step 3: Verify — module loads, smoke tests pass**

```bash
node -e "require('./server/node/dataRoutes.cjs')" && echo "OK"
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh && pnpm test
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 5: Commit**

```bash
git add server/node/dataRoutes.cjs server/node/server.cjs
git commit -m "refactor: extract dataRoutes.cjs from server.cjs

Move data CRUD routes (read/write/list/remove/patch/flush) and
bulk asset endpoints into dedicated module."
```

---

## Task 8: Final `server.cjs` cleanup

After all extractions, `server.cjs` should be ~180 lines containing only:

1. Express app creation and middleware
2. `shouldCompress()` function
3. Index route (`/`)
4. Module wiring (require + create + mountRoutes)
5. `fetchLatestRelease()` + `/api/update-check` route
6. `getHttpsOptions()`, `startServer()`
7. Graceful shutdown handlers
8. Main IIFE (GC, startup, WAL checkpoint interval)

**Files:**
- Modify: `server/node/server.cjs`

- [ ] **Step 1: Verify final `server.cjs` structure**

The file should look like:

```js
'use strict';
const express = require('express');
const app = express();
const http = require('http');
const https = require('https');
const path = require('path');
const compression = require('compression');
const htmlparser = require('node-html-parser');
const fs = require('fs/promises');
const { existsSync, mkdirSync, readFileSync } = require('fs');

// --- DB and utils ---
const { kvGet, kvSet, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvSize,
        kvGetUpdatedAt, kvCopyValue, clearEntities, checkpointWal,
        db: sqliteDb } = require('./db.cjs');
const { applyPatch } = require('fast-json-patch');
const { decodeRisuSave, encodeRisuSaveLegacy, calculateHash, normalizeJSON } = require('./utils.cjs');

// --- Paths ---
const savePath = path.join(process.cwd(), 'save');
if (!existsSync(savePath)) mkdirSync(savePath);
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const inlayDir = path.join(savePath, 'inlays');
const passwordPath = path.join(savePath, '__password');
const jwtSecretPath = path.join(savePath, '__jwt_secret');
const authCodePath = path.join(savePath, '__authcode');
const hubURL = 'https://sv.risuai.xyz';

// --- Create modules ---
const { createDbState } = require('./dbState.cjs');
const dbState = createDbState({ kvGet, kvSet, kvCopyValue, kvList, kvSize, kvDel,
                                encodeRisuSaveLegacy, decodeRisuSave, calculateHash, normalizeJSON });

const { createInlay } = require('./inlay.cjs');
const inlay = createInlay({ inlayDir, kvGet, kvDel, kvList });

const { createAuth } = require('./auth.cjs');
const auth = createAuth({ savePath, passwordPath, jwtSecretPath });

const { createProxy } = require('./proxy.cjs');
const proxy = createProxy({ checkAuth: auth.checkAuth, authCodePath, savePath, hubURL });

const { createBackup } = require('./backup.cjs');
const backup = createBackup({
    checkAuth: auth.checkAuth, checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware,
    inlay, dbState, kvGet, kvSet, kvDel, kvDelPrefix, kvList, kvListWithSizes,
    kvSize, kvGetUpdatedAt, clearEntities, checkpointWal, sqliteDb,
    savePath, inlayDir,
});

const { createMigration } = require('./migration.cjs');
const migration = createMigration({
    checkAuth: auth.checkAuth, checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware,
    inlay, dbState,
    acquireImportLock: backup.acquireImportLock,
    releaseImportLock: backup.releaseImportLock,
    kvDelPrefix, clearEntities, sqliteDb, savePath,
});

const { createDataRoutes } = require('./dataRoutes.cjs');
const dataRoutes = createDataRoutes({
    checkAuth: auth.checkAuth, checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware, isHex: auth.isHex,
    inlay, dbState, kvGet, kvSet, kvDel, kvList, sqliteDb,
    decodeRisuSave, encodeRisuSaveLegacy, calculateHash, normalizeJSON, applyPatch,
});

// --- Middleware ---
function shouldCompress(req, res) { /* stays here — ~20 lines */ }
app.use(compression({ filter: shouldCompress }));
app.use('/assets', express.static(path.join(process.cwd(), 'dist/assets'), { maxAge: '1y', immutable: true }));
app.use(express.static(path.join(process.cwd(), 'dist'), { index: false, maxAge: 0 }));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '2gb' }));
app.use(express.text({ limit: '100mb' }));

// --- Mount routes ---
app.get('/', async (req, res, next) => { /* index.html injection — stays here */ });
auth.mountRoutes(app);
proxy.mountRoutes(app);
backup.mountRoutes(app);
dataRoutes.mountRoutes(app);
migration.mountRoutes(app);

// --- Update check ---
// fetchLatestRelease() + /api/update-check — stays here (~25 lines)

// --- Server startup ---
// getHttpsOptions() and startServer() stay here (~30 lines).
// startServer() ONLY handles HTTP/HTTPS creation and listen() —
// it does NOT call migrateInlaysToFilesystem(). That lives in main IIFE below.

// --- Graceful shutdown ---
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        console.log(`[Server] Received ${sig}, flushing pending data...`);
        try { dbState.flushPendingDb(); } catch (e) { console.error('[Server] Flush error:', e); }
        try { checkpointWal('TRUNCATE'); } catch { /* non-fatal */ }
        process.exit(0);
    });
}

// --- Main ---
// Inlay migration runs here (NOT inside startServer) to keep startup logic
// in one place and avoid double-call risk. Matches original server.cjs:3043.
(async () => {
    proxy.startGarbageCollection();
    await inlay.migrateInlaysToFilesystem();
    await startServer();
    setInterval(() => { try { checkpointWal('RESTART'); } catch {} }, 5 * 60 * 1000);
})();
```

- [ ] **Step 2: Count lines — target ~180 lines**

```bash
wc -l server/node/server.cjs
```

Expected: ~150-200 lines.

- [ ] **Step 3: Full verification — smoke tests + unit tests**

```bash
node server/node/server.cjs &
SERVER_PID=$!; sleep 2
bash server/node/smoke-test.sh && pnpm test
kill $SERVER_PID 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
git add server/node/server.cjs
git commit -m "refactor: slim server.cjs to ~180 lines

All domain logic extracted into modules. server.cjs now only handles
Express setup, middleware, module wiring, and server lifecycle."
```

---

## Smoke Test Script

Create `server/node/smoke-test.sh` early (Task 1) and run it after every extraction. This catches wiring regressions that `pnpm test` (frontend-only) cannot.

```bash
#!/usr/bin/env bash
# server/node/smoke-test.sh — Quick regression check for server modularization
# Usage: Start server in background, then run this script.
#
# TLS note: The real server starts HTTPS when ssl/certificate/ exists.
# This script auto-detects the protocol by trying HTTP first, falling back
# to HTTPS with -k (accept self-signed). To force HTTP-only during dev,
# temporarily move server/node/ssl/certificate/ aside, or pass an explicit
# base URL: bash smoke-test.sh https://localhost:6001
set -euo pipefail

PORT="${PORT:-6001}"
BASE="${1:-}"

if [ -z "$BASE" ]; then
    # Auto-detect: try HTTP, fall back to HTTPS
    if curl -sf --max-time 2 "http://localhost:$PORT/" -o /dev/null 2>/dev/null; then
        BASE="http://localhost:$PORT"
        CURL="curl -sf"
    else
        BASE="https://localhost:$PORT"
        CURL="curl -sfk"   # -k for self-signed certs
    fi
else
    if [[ "$BASE" == https://* ]]; then
        CURL="curl -sfk"
    else
        CURL="curl -sf"
    fi
fi

fail() { echo "FAIL: $1"; exit 1; }
pass() { echo "  OK: $1"; }

echo "=== Smoke test against $BASE ==="

# 1. Server responds
$CURL "$BASE/" -o /dev/null || fail "GET / — server not responding"
pass "GET / — index.html served"

# 2. Auth — no password set returns 'unset'
STATUS=$($CURL "$BASE/api/test_auth" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).status))")
[ "$STATUS" = "unset" ] || [ "$STATUS" = "success" ] || [ "$STATUS" = "incorrect" ] || fail "GET /api/test_auth — unexpected status: $STATUS"
pass "GET /api/test_auth — responded with status=$STATUS"

# 3. Data route — /api/list responds (auth may block, 400 is OK — means route is wired)
HTTP=$($CURL -o /dev/null -w "%{http_code}" "$BASE/api/list" 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "200" ] || fail "GET /api/list — unexpected HTTP $HTTP"
pass "GET /api/list — route wired (HTTP $HTTP)"

# 4. Proxy route exists (400 = no URL param, means route is registered)
HTTP=$($CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/proxy" -H "Content-Type: application/json" 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "401" ] || fail "POST /proxy — unexpected HTTP $HTTP"
pass "POST /proxy — route wired (HTTP $HTTP)"

# 5. Backup prepare — wired (auth may block)
HTTP=$($CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/api/backup/import/prepare" -H "Content-Type: application/json" -d '{}' 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "200" ] || [ "$HTTP" = "401" ] || fail "POST /api/backup/import/prepare — unexpected HTTP $HTTP"
pass "POST /api/backup/import/prepare — route wired (HTTP $HTTP)"

# 6. Migration scan — wired
HTTP=$($CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/api/migrate/save-folder/scan" -H "Content-Type: application/json" -d '{}' 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "200" ] || [ "$HTTP" = "401" ] || fail "POST /api/migrate/save-folder/scan — unexpected HTTP $HTTP"
pass "POST /api/migrate/save-folder/scan — route wired (HTTP $HTTP)"

# 7. Update check
HTTP=$($CURL -o /dev/null -w "%{http_code}" "$BASE/api/update-check" 2>/dev/null || true)
[ "$HTTP" = "200" ] || fail "GET /api/update-check — unexpected HTTP $HTTP"
pass "GET /api/update-check — responded OK"

echo "=== All smoke tests passed ==="
```

**Per-task verification procedure:**

```bash
# 1. Start server in background
node server/node/server.cjs &
SERVER_PID=$!
sleep 2

# 2. Run smoke tests (auto-detects HTTP vs HTTPS)
bash server/node/smoke-test.sh

# 3. Run existing tests
pnpm test

# 4. Kill server
kill $SERVER_PID 2>/dev/null || true
```

---

## Execution Notes

**Order matters:** Tasks must be executed sequentially (1 → 2 → 3 → 4 → 5 → 6 → 7 → 8) because each task depends on the previous one reducing `server.cjs`.

**Key risk:** The `/api/backup/import` route (Task 5) is the most complex extraction — it has inline helper functions (`stagingInlayFilePath`, `writeStagingInlayFileSync`) and uses `sqliteDb` directly for transactions. Move these helpers into the `backup.cjs` closure.

**Import lock pattern:** `backup.cjs` owns the `importInProgress` flag and exports `acquireImportLock()`/`releaseImportLock()`. Both `backup.cjs` import route and `migration.cjs` execute/upload routes use this same lock via dependency injection. The pattern:
```js
if (!acquireImportLock()) {
    res.status(409).json({ error: 'Another import is already in progress' });
    return;
}
try {
    dbState.flushPendingDb();  // drain pending PATCH/WRITE debounced timers
    // ... bulk SQLite writes ...
    dbState.invalidateDbCache();  // prevent stale timer writes
} finally {
    releaseImportLock();
}
```

**Queue drain before bulk writes:** The original server.cjs already calls `flushPendingDb()` before imports (line 2733, 2306) and `invalidateDbCache()` after (line 2670, 2736). After modularization these must go through `dbState.flushPendingDb()` and `dbState.invalidateDbCache()` explicitly. This prevents a race where the 5-second debounced PATCH timer fires during a streaming import and writes stale data to SQLite.

**Inlay dep for backup staging:** The backup import route's staging helpers (server.cjs:2491-2564) call `normalizeInlayExt`, `isSafeInlayId`, `decodeDataUri` directly. After extraction to `inlay.cjs`, backup must call these through its injected `inlay` dep — do NOT duplicate the functions. Same applies to `resolveAssetPayload` using `inlay.detectMime` and `inlay.ASSET_EXT_MIME`.

**What NOT to change:**
- No behavior changes — every route must respond identically
- No API changes — no new/removed/renamed endpoints
- No dependency changes — no new npm packages
- Keep all files as `.cjs` — matching existing convention
