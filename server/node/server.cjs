const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const compression = require('compression');
const htmlparser = require('node-html-parser');
const { existsSync, mkdirSync, readFileSync } = require('fs');
const fs = require('fs/promises');
const {
    kvGet,
    kvSet,
    kvDel,
    kvList,
    kvDelPrefix,
    kvListWithSizes,
    kvSize,
    kvGetUpdatedAt,
    kvCopyValue,
    clearEntities,
    checkpointWal,
    db: sqliteDb,
} = require('./db.cjs');
const { applyPatch } = require('fast-json-patch');
const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    calculateHash,
    normalizeJSON,
} = require('./utils.cjs');
const { createDbState } = require('./dbState.cjs');
const { createInlay } = require('./inlay.cjs');
const { createAuth } = require('./auth.cjs');
const { createProxy } = require('./proxy.cjs');
const { createBackup } = require('./backup.cjs');
const { createMigration } = require('./migration.cjs');
const { createDataRoutes } = require('./dataRoutes.cjs');

const app = express();

const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz';
const savePath = path.join(process.cwd(), 'save');
const passwordPath = path.join(savePath, '__password');
const jwtSecretPath = path.join(savePath, '__jwt_secret');
const authCodePath = path.join(savePath, '__authcode');
const inlayDir = path.join(savePath, 'inlays');
const hexRegex = /^[0-9a-fA-F]+$/;
const BACKUP_IMPORT_MAX_BYTES = Number(process.env.RISU_BACKUP_IMPORT_MAX_BYTES ?? '0');
const BACKUP_ENTRY_NAME_MAX_BYTES = 1024;
const BACKUP_DISK_HEADROOM = 2;

const UPDATE_CHECK_DISABLED = process.env.RISU_UPDATE_CHECK === 'false';
const UPDATE_CHECK_URL =
    process.env.RISU_UPDATE_URL || 'https://risu-update-worker.nodridan.workers.dev/check';

const currentVersion = (() => {
    try {
        const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch {
        return '0.0.0';
    }
})();

if (!existsSync(savePath)) {
    mkdirSync(savePath);
}

const dbState = createDbState({
    kvSet,
    kvCopyValue,
    kvList,
    kvSize,
    kvDel,
    encodeRisuSaveLegacy,
});

const inlay = createInlay({ inlayDir, kvGet, kvDel, kvList });
const auth = createAuth({ passwordPath, jwtSecretPath });
const importState = { inProgress: false };

const proxy = createProxy({
    checkAuth: auth.checkAuth,
    authCodePath,
    savePath,
    hubURL,
});

const dataRoutes = createDataRoutes({
    auth,
    inlay,
    dbState,
    utils: {
        decodeRisuSave,
        encodeRisuSaveLegacy,
        calculateHash,
        normalizeJSON,
    },
    applyPatch,
    kvGet,
    kvSet,
    kvDel,
    kvList,
    sqliteDb,
});

const backup = createBackup({
    checkAuth: auth.checkAuth,
    checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware,
    inlay,
    dbState,
    importState,
    kvGet,
    kvSet,
    kvDel,
    kvDelPrefix,
    kvListWithSizes,
    kvSize,
    kvGetUpdatedAt,
    clearEntities,
    checkpointWal,
    sqliteDb,
    savePath,
    inlayDir,
    backupImportMaxBytes: BACKUP_IMPORT_MAX_BYTES,
    backupEntryNameMaxBytes: BACKUP_ENTRY_NAME_MAX_BYTES,
    backupDiskHeadroom: BACKUP_DISK_HEADROOM,
});

const migration = createMigration({
    checkAuth: auth.checkAuth,
    checkActiveSession: auth.checkActiveSession,
    sessionAuthMiddleware: auth.sessionAuthMiddleware,
    inlay,
    dbState,
    importState,
    kvDelPrefix,
    clearEntities,
    checkpointWal,
    sqliteDb,
    savePath,
    hexRegex,
    backupImportMaxBytes: BACKUP_IMPORT_MAX_BYTES,
});

function shouldCompress(req, res) {
    const url = req.originalUrl || req.url;
    if (url.startsWith('/proxy') || url.startsWith('/hub-proxy') || url.startsWith('/api/backup/export')) {
        return false;
    }

    const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
        return false;
    }
    if (
        contentType.startsWith('image/') ||
        contentType.startsWith('video/') ||
        contentType.startsWith('audio/')
    ) {
        return false;
    }
    if (contentType.includes('application/octet-stream')) {
        return true;
    }
    return compression.filter(req, res);
}

app.use(
    compression({
        filter: shouldCompress,
    })
);

app.use(
    '/assets',
    express.static(path.join(process.cwd(), 'dist/assets'), {
        maxAge: '1y',
        immutable: true,
    })
);
app.use(express.static(path.join(process.cwd(), 'dist'), { index: false, maxAge: 0 }));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '2gb' }));
app.use(express.text({ limit: '100mb' }));

async function fetchLatestRelease() {
    if (UPDATE_CHECK_DISABLED) return null;
    try {
        const url = `${UPDATE_CHECK_URL}?v=${encodeURIComponent(currentVersion)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.hasUpdate) {
            console.log(
                `[Update] New version available: v${data.latestVersion} (current: v${currentVersion}, ${data.severity})`
            );
        }
        return data;
    } catch (error) {
        console.error('[Update] Failed to check for updates:', error.message);
        return null;
    }
}

app.get('/', async (req, res, next) => {
    const clientIP = req.ip || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);

    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'));
        const root = htmlparser.parse(mainIndex);
        const head = root.querySelector('head');
        head.innerHTML =
            `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${dbState.enablePatchSync}</script>` +
            head.innerHTML;

        res.send(root.toString());
    } catch (error) {
        console.log(error);
        next(error);
    }
});

proxy.mountRoutes(app);
auth.mountRoutes(app);
dataRoutes.mountRoutes(app);
backup.mountRoutes(app);
migration.mountRoutes(app);

app.get('/api/update-check', async (req, res) => {
    if (UPDATE_CHECK_DISABLED) {
        res.json({ currentVersion, hasUpdate: false, severity: 'none', disabled: true });
        return;
    }
    const result = await fetchLatestRelease();
    res.json(result || { currentVersion, hasUpdate: false, severity: 'none' });
});

async function getHttpsOptions() {
    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
        return { key, cert };
    } catch (error) {
        console.error('[Server] SSL setup errors:', error.message);
        console.log('[Server] Start the server with HTTP instead of HTTPS...');
        return null;
    }
}

async function startServer() {
    const port = process.env.PORT || 6001;
    const httpsOptions = await getHttpsOptions();
    const server = httpsOptions
        ? https.createServer(httpsOptions, app)
        : http.createServer(app);

    proxy.setupProxyStreamWebSocket(server);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
            if (httpsOptions) {
                console.log('[Server] HTTPS server is running.');
                console.log(`[Server] https://localhost:${port}/`);
            } else {
                console.log('[Server] HTTP server is running.');
                console.log(`[Server] http://localhost:${port}/`);
            }
            resolve();
        });
    });

    return server;
}

let shuttingDown = false;
let walCheckpointTimer = null;

async function shutdown(sig, server) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[Server] Received ${sig}, flushing pending data...`);

    if (walCheckpointTimer) {
        clearInterval(walCheckpointTimer);
        walCheckpointTimer = null;
    }

    try {
        dbState.flushPendingDb();
    } catch (error) {
        console.error('[Server] Flush error:', error);
    }

    try {
        checkpointWal('TRUNCATE');
    } catch {}

    if (server?.listening) {
        await new Promise((resolve) => {
            server.close(() => resolve());
        });
    }

    process.exit(0);
}

function registerShutdownHandlers(server) {
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => {
            shutdown(sig, server).catch((error) => {
                console.error('[Server] Shutdown failed:', error);
                process.exit(1);
            });
        });
    }
}

async function main() {
    try {
        proxy.startGarbageCollection();
        await inlay.migrateInlaysToFilesystem();
        const server = await startServer();
        registerShutdownHandlers(server);

        walCheckpointTimer = setInterval(() => {
            try {
                checkpointWal('RESTART');
            } catch {}
        }, 5 * 60 * 1000);
        walCheckpointTimer.unref?.();
    } catch (error) {
        console.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

main();
