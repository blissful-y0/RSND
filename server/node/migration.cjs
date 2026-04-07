'use strict';

const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');
const { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } = require('fs');

function createMigration({
    checkAuth,
    checkActiveSession,
    sessionAuthMiddleware,
    inlay,
    dbState,
    importState,
    kvDelPrefix,
    clearEntities,
    checkpointWal,
    sqliteDb,
    savePath,
    hexRegex,
    backupImportMaxBytes,
}) {
    const migrationMarkerPath = path.join(savePath, '.migrated_to_sqlite');
    const { listInlayFiles, readInlaySidecar, writeInlayFile } = inlay;
    const COMPRESS_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp']);

    function acquireImportLock() {
        if (importState.inProgress) return false;
        importState.inProgress = true;
        return true;
    }

    function releaseImportLock() {
        importState.inProgress = false;
    }

    function scanHexFilesInDir(dirPath) {
        let files;
        try {
            files = readdirSync(dirPath);
        } catch {
            return { hexFiles: [], count: 0, totalSize: 0, hasDatabase: false };
        }

        const hexFiles = files.filter((fileName) => hexRegex.test(fileName));
        let totalSize = 0;
        let hasDatabase = false;

        for (const fileName of hexFiles) {
            try {
                totalSize += statSync(path.join(dirPath, fileName)).size;
            } catch {}
            try {
                if (Buffer.from(fileName, 'hex').toString('utf-8') === 'database/database.bin') {
                    hasDatabase = true;
                }
            } catch {}
        }

        return { hexFiles, count: hexFiles.length, totalSize, hasDatabase };
    }

    function clearExistingData() {
        kvDelPrefix('assets/');
        kvDelPrefix('inlay/');
        kvDelPrefix('inlay_thumb/');
        kvDelPrefix('inlay_meta/');
        kvDelPrefix('inlay_info/');
        clearEntities();
    }

    function importHexFilesFromDir(dirPath) {
        const { hexFiles, hasDatabase } = scanHexFilesInDir(dirPath);
        if (hexFiles.length === 0) return { imported: 0 };
        if (!hasDatabase) throw new Error('Save folder does not contain database/database.bin');

        dbState.flushAllPendingSaves();
        dbState.createBackupAndRotate();
        dbState.clearAllPendingState();
        clearExistingData();
        dbState.invalidateDbCache();

        const insert = sqliteDb.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)'
        );
        const now = Date.now();
        const run = sqliteDb.transaction(() => {
            for (const hexFile of hexFiles) {
                const key = Buffer.from(hexFile, 'hex').toString('utf-8');
                const value = readFileSync(path.join(dirPath, hexFile));
                insert.run(key, value, now);
            }
        });
        run();

        writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
        try {
            checkpointWal('TRUNCATE');
        } catch {}
        return { imported: hexFiles.length };
    }

    function importHexEntries(entries) {
        if (entries.length === 0) return { imported: 0 };
        const hasDatabase = entries.some((entry) => entry.key === 'database/database.bin');
        if (!hasDatabase) throw new Error('Data does not contain database/database.bin');

        dbState.flushAllPendingSaves();
        dbState.createBackupAndRotate();
        dbState.clearAllPendingState();
        clearExistingData();
        dbState.invalidateDbCache();

        const insert = sqliteDb.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)'
        );
        const now = Date.now();
        const run = sqliteDb.transaction(() => {
            for (const { key, value } of entries) {
                insert.run(key, value, now);
            }
        });
        run();

        writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
        try {
            checkpointWal('TRUNCATE');
        } catch {}
        return { imported: entries.length };
    }

    function mountRoutes(app) {
        app.post('/api/migrate/save-folder/scan', async (req, res, next) => {
            if (!await checkAuth(req, res)) return;
            if (!checkActiveSession(req, res)) return;
            try {
                const folderPath = req.body?.path || savePath;
                const resolved = path.resolve(folderPath);
                try {
                    const stat = statSync(resolved);
                    if (!stat.isDirectory()) {
                        res.status(400).json({ error: 'Path is not a directory' });
                        return;
                    }
                } catch {
                    res.status(400).json({ error: 'Cannot access directory' });
                    return;
                }

                const { count, totalSize, hasDatabase } = scanHexFilesInDir(resolved);
                res.json({ count, totalSize, hasDatabase });
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/migrate/save-folder/execute', async (req, res) => {
            if (!await checkAuth(req, res)) return;
            if (!checkActiveSession(req, res)) return;
            if (!acquireImportLock()) {
                res.status(409).json({ error: 'Another import is already in progress' });
                return;
            }

            try {
                const folderPath = req.body?.path || savePath;
                const resolved = path.resolve(folderPath);
                try {
                    const stat = statSync(resolved);
                    if (!stat.isDirectory()) {
                        res.status(400).json({ error: 'Path is not a directory' });
                        return;
                    }
                } catch {
                    res.status(400).json({ error: 'Cannot access directory' });
                    return;
                }

                let result = null;
                await dbState.queueStorageOperation(async () => {
                    result = importHexFilesFromDir(resolved);
                });
                res.json({ ok: true, imported: result?.imported ?? 0 });
            } catch (error) {
                res.status(400).json({ error: error.message || 'Import failed' });
            } finally {
                releaseImportLock();
            }
        });

        app.post('/api/migrate/save-folder/upload', async (req, res) => {
            if (!await checkAuth(req, res)) return;
            if (!checkActiveSession(req, res)) return;
            if (!acquireImportLock()) {
                res.status(409).json({ error: 'Another import is already in progress' });
                return;
            }

            req.socket.setTimeout(0);
            req.socket.setKeepAlive(true);
            const prevRequestTimeout = req.socket.server?.requestTimeout;
            if (req.socket.server) req.socket.server.requestTimeout = 0;

            try {
                const chunks = [];
                let totalSize = 0;
                for await (const chunk of req) {
                    totalSize += chunk.length;
                    if (backupImportMaxBytes > 0 && totalSize > backupImportMaxBytes) {
                        res.status(413).json({ error: 'Zip file exceeds max allowed size' });
                        return;
                    }
                    chunks.push(chunk);
                }

                const zipBuffer = Buffer.concat(chunks);
                let unzipped;
                try {
                    const fflate = require('fflate');
                    unzipped = fflate.unzipSync(new Uint8Array(zipBuffer));
                } catch {
                    res.status(400).json({ error: 'Invalid or corrupted zip file' });
                    return;
                }

                const entries = [];
                for (const [entryPath, data] of Object.entries(unzipped)) {
                    if (data.length === 0) continue;
                    const basename = path.basename(entryPath);
                    if (!hexRegex.test(basename)) continue;
                    try {
                        const key = Buffer.from(basename, 'hex').toString('utf-8');
                        entries.push({ key, value: Buffer.from(data) });
                    } catch {}
                }

                if (entries.length === 0) {
                    res.status(400).json({ error: 'No compatible hex files found in zip' });
                    return;
                }

                let result = null;
                await dbState.queueStorageOperation(async () => {
                    result = importHexEntries(entries);
                });
                res.json({ ok: true, imported: result?.imported ?? 0 });
            } catch (error) {
                res.status(400).json({ error: error.message || 'Import failed' });
            } finally {
                releaseImportLock();
                if (req.socket.server && prevRequestTimeout !== undefined) {
                    req.socket.server.requestTimeout = prevRequestTimeout;
                }
            }
        });

        app.post('/api/migrate/save-folder/cleanup/scan', async (req, res, next) => {
            if (!await checkAuth(req, res)) return;
            if (!checkActiveSession(req, res)) return;
            try {
                if (!existsSync(migrationMarkerPath)) {
                    res.status(400).json({ error: 'Migration has not been completed yet' });
                    return;
                }
                const { count, totalSize } = scanHexFilesInDir(savePath);
                res.json({ count, totalSize });
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/migrate/save-folder/cleanup/execute', async (req, res, next) => {
            if (!await checkAuth(req, res)) return;
            if (!checkActiveSession(req, res)) return;
            try {
                if (!existsSync(migrationMarkerPath)) {
                    res.status(400).json({ error: 'Migration has not been completed yet' });
                    return;
                }

                const { hexFiles } = scanHexFilesInDir(savePath);
                let removed = 0;
                let freedBytes = 0;
                for (const fileName of hexFiles) {
                    try {
                        const filePath = path.join(savePath, fileName);
                        const stat = statSync(filePath);
                        unlinkSync(filePath);
                        freedBytes += stat.size;
                        removed++;
                    } catch {}
                }
                res.json({ ok: true, removed, freedBytes });
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/inlays/compress', sessionAuthMiddleware, async (req, res) => {
            if (!checkActiveSession(req, res)) return;
            const quality = typeof req.body?.quality === 'number' ? req.body.quality : 85;

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });

            const send = (data) => {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            try {
                const files = await listInlayFiles();
                const imageFiles = [];

                for (const entry of files) {
                    if (!COMPRESS_IMAGE_EXTS.has(entry.ext)) continue;
                    const sidecar = await readInlaySidecar(entry.id);
                    if (sidecar && sidecar.type !== 'image') continue;
                    imageFiles.push(entry);
                }

                const total = imageFiles.length;
                let compressed = 0;
                let skipped = 0;
                let totalSaved = 0;

                for (let i = 0; i < imageFiles.length; i++) {
                    const entry = imageFiles[i];
                    try {
                        const original = await fs.readFile(entry.filePath);
                        const webpBuf = await sharp(original).webp({ quality }).toBuffer();

                        if (webpBuf.length < original.length) {
                            const sidecar = await readInlaySidecar(entry.id);
                            const info = sidecar || {};
                            await writeInlayFile(entry.id, 'webp', webpBuf, { ...info, ext: 'webp' });
                            kvDelPrefix(`inlay_thumb/${entry.id}`);
                            const saved = original.length - webpBuf.length;
                            totalSaved += saved;
                            compressed++;
                        } else {
                            skipped++;
                        }
                    } catch {
                        skipped++;
                    }

                    send({ type: 'progress', current: i + 1, total, compressed, skipped, totalSaved });
                }

                send({ type: 'done', total, compressed, skipped, totalSaved });
            } catch (err) {
                send({ type: 'error', message: err?.message || 'Unknown error' });
            }

            res.end();
        });
    }

    return {
        mountRoutes,
    };
}

module.exports = { createMigration };
