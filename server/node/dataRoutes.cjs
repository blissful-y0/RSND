'use strict';

const fs = require('fs/promises');

function createDataRoutes({
    auth,
    inlay,
    dbState,
    utils,
    applyPatch,
    kvGet,
    kvSet,
    kvDel,
    kvList,
    sqliteDb,
}) {
    const {
        checkAuth,
        checkActiveSession,
        sessionAuthMiddleware,
        isHex,
    } = auth;

    const {
        decodeRisuSave,
        encodeRisuSaveLegacy,
        calculateHash,
        normalizeJSON,
        applyPatch: utilsApplyPatch,
    } = utils || {};

    const patchApply = applyPatch || utilsApplyPatch;

    const {
        readInlayAssetPayload,
        readInlayInfoPayload,
        getInlaySidecarPath,
        deleteInlayFile,
        listInlayFiles,
        normalizeInlayExt,
        decodeDataUri,
        writeInlayFile,
        writeInlaySidecar,
    } = inlay;

    const BULK_BATCH = 50;

    async function readValueByKey(key) {
        let value = null;
        if (typeof key === 'string' && key.startsWith('inlay/')) {
            value = await readInlayAssetPayload(key.slice('inlay/'.length));
        } else if (typeof key === 'string' && key.startsWith('inlay_info/')) {
            value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
        }
        if (value === null) {
            value = kvGet(key);
        }
        return value;
    }

    function mountRoutes(app) {
        app.get('/api/read', async (req, res, next) => {
            if (!await checkAuth(req, res)) {
                return;
            }

            const filePath = req.headers['file-path'];
            if (!filePath) {
                console.log('no path');
                res.status(400).send({ error: 'File path required' });
                return;
            }
            if (!isHex(filePath)) {
                res.status(400).send({ error: 'Invaild Path' });
                return;
            }

            try {
                const key = Buffer.from(filePath, 'hex').toString('utf-8');
                if (key === 'database/database.bin') {
                    dbState.flushPendingDb();
                }

                const value = await readValueByKey(key);
                if (value === null) {
                    res.send();
                    return;
                }

                res.setHeader('Content-Type', 'application/octet-stream');
                if (key === 'database/database.bin') {
                    if (!dbState.getDbEtag()) {
                        dbState.setDbEtag(dbState.computeBufferEtag(value));
                    }
                    if (req.headers['if-none-match'] === dbState.getDbEtag()) {
                        return res.status(304).end();
                    }
                    res.setHeader('x-db-etag', dbState.getDbEtag());
                }
                res.send(value);
            } catch (error) {
                next(error);
            }
        });

        app.get('/api/remove', async (req, res, next) => {
            if (!await checkAuth(req, res)) {
                return;
            }

            const filePath = req.headers['file-path'];
            if (!filePath) {
                res.status(400).send({ error: 'File path required' });
                return;
            }
            if (!isHex(filePath)) {
                res.status(400).send({ error: 'Invaild Path' });
                return;
            }

            try {
                const key = Buffer.from(filePath, 'hex').toString('utf-8');
                if (key.startsWith('inlay/')) {
                    const id = key.slice('inlay/'.length);
                    await deleteInlayFile(id);
                    kvDel(key);
                    kvDel(`inlay_thumb/${id}`);
                    kvDel(`inlay_info/${id}`);
                    res.send({ success: true });
                    return;
                }
                if (key.startsWith('inlay_info/')) {
                    await fs.unlink(getInlaySidecarPath(key.slice('inlay_info/'.length))).catch(() => {});
                }
                kvDel(key);
                res.send({ success: true });
            } catch (error) {
                next(error);
            }
        });

        app.get('/api/list', async (req, res, next) => {
            if (!await checkAuth(req, res)) {
                return;
            }

            try {
                const keyPrefix = req.headers['key-prefix'] || '';
                let data;
                if (keyPrefix === 'inlay/') {
                    const fileKeys = (await listInlayFiles()).map((entry) => `inlay/${entry.id}`);
                    data = [...new Set([
                        ...fileKeys,
                        ...kvList('inlay/'),
                    ])];
                } else {
                    data = kvList(keyPrefix || undefined);
                }
                res.send({ success: true, content: data });
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/write', async (req, res, next) => {
            if (!await checkAuth(req, res)) {
                return;
            }
            if (!checkActiveSession(req, res)) return;

            const filePath = req.headers['file-path'];
            const fileContent = req.body;
            if (!filePath || !fileContent) {
                res.status(400).send({ error: 'File path required' });
                return;
            }
            if (!isHex(filePath)) {
                res.status(400).send({ error: 'Invaild Path' });
                return;
            }

            try {
                await dbState.queueStorageOperation(async () => {
                    const key = Buffer.from(filePath, 'hex').toString('utf-8');

                    if (key === 'database/database.bin') {
                        const ifMatch = req.headers['x-if-match'];
                        if (ifMatch && dbState.getDbEtag() && ifMatch !== dbState.getDbEtag()) {
                            res.status(409).send({
                                error: 'ETag mismatch - concurrent modification detected',
                                currentEtag: dbState.getDbEtag(),
                            });
                            return;
                        }
                    }

                    if (key.startsWith('inlay/')) {
                        const id = key.slice('inlay/'.length);
                        const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                        const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                        const ext = normalizeInlayExt(parsed?.ext);
                        const buffer = type === 'signature'
                            ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                            : decodeDataUri(parsed?.data).buffer;
                        await writeInlayFile(id, ext, buffer, {
                            ext,
                            name: typeof parsed?.name === 'string' ? parsed.name : id,
                            type,
                            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                        });
                        kvDel(key);
                        kvDel(`inlay_thumb/${id}`);
                        kvDel(`inlay_info/${id}`);
                    } else if (key.startsWith('inlay_info/')) {
                        const id = key.slice('inlay_info/'.length);
                        const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                        await writeInlaySidecar(id, parsed);
                        kvDel(key);
                    } else {
                        kvSet(key, fileContent);
                    }

                    if (key === 'database/database.bin') {
                        dbState.invalidateDbCache();
                        dbState.setDbEtag(dbState.computeBufferEtag(fileContent));
                        dbState.createBackupAndRotate();
                    }

                    res.send({
                        success: true,
                        etag: key === 'database/database.bin' ? dbState.getDbEtag() : undefined,
                    });
                });
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/db/flush', sessionAuthMiddleware, async (req, res, next) => {
            if (!checkActiveSession(req, res)) return;
            try {
                await dbState.queueStorageOperation(async () => {
                    dbState.flushPendingDb();
                    res.send({
                        success: true,
                        etag: dbState.getDbEtag() ?? undefined,
                    });
                });
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/patch', async (req, res) => {
            if (!dbState.enablePatchSync) {
                res.status(404).send({ error: 'Patch sync is not enabled' });
                return;
            }
            if (!await checkAuth(req, res)) {
                return;
            }
            if (!checkActiveSession(req, res)) return;

            const filePath = req.headers['file-path'];
            const patch = req.body.patch;
            const expectedHash = req.body.expectedHash;

            if (!filePath || !patch || !expectedHash) {
                res.status(400).send({ error: 'File path, patch, and expected hash required' });
                return;
            }
            if (!isHex(filePath)) {
                res.status(400).send({ error: 'Invaild Path' });
                return;
            }

            try {
                await dbState.queueStorageOperation(async () => {
                    const decodedKey = Buffer.from(filePath, 'hex').toString('utf-8');

                    if (!dbState.hasCacheEntry(filePath)) {
                        const fileContent = kvGet(decodedKey);
                        if (fileContent) {
                            dbState.setCacheEntry(filePath, normalizeJSON(await decodeRisuSave(fileContent)));
                        } else {
                            dbState.setCacheEntry(filePath, {});
                        }
                    }

                    const serverHash = calculateHash(dbState.getCacheEntry(filePath)).toString(16);
                    if (expectedHash !== serverHash) {
                        console.log(`[Patch] Hash mismatch for ${decodedKey}: expected=${expectedHash}, server=${serverHash}`);
                        let currentEtag;
                        if (decodedKey === 'database/database.bin') {
                            currentEtag = dbState.computeDatabaseEtagFromObject(dbState.getCacheEntry(filePath));
                            dbState.setDbEtag(currentEtag);
                        }
                        res.status(409).send({
                            error: 'Hash mismatch - data out of sync',
                            currentEtag,
                        });
                        return;
                    }

                    const snapshot = JSON.parse(JSON.stringify(dbState.getCacheEntry(filePath)));
                    let result;
                    try {
                        result = patchApply(snapshot, patch, true);
                    } catch (patchErr) {
                        dbState.deleteCacheEntry(filePath);
                        throw patchErr;
                    }
                    dbState.setCacheEntry(filePath, snapshot);

                    if (dbState.hasSaveTimer(filePath)) {
                        dbState.clearSaveTimer(filePath);
                    }
                    dbState.setSaveTimer(filePath, setTimeout(() => {
                        try {
                            const data = Buffer.from(encodeRisuSaveLegacy(dbState.getCacheEntry(filePath)));
                            kvSet(decodedKey, data);
                            if (decodedKey === 'database/database.bin') {
                                dbState.createBackupAndRotate();
                            }
                        } catch (error) {
                            console.error(`[Patch] Error saving ${decodedKey}:`, error);
                        } finally {
                            dbState.clearSaveTimer(filePath);
                        }
                    }, dbState.SAVE_INTERVAL));

                    if (decodedKey === 'database/database.bin') {
                        dbState.setDbEtag(dbState.computeDatabaseEtagFromObject(dbState.getCacheEntry(filePath)));
                    }

                    res.send({
                        success: true,
                        appliedOperations: result.length,
                        etag: decodedKey === 'database/database.bin' ? dbState.getDbEtag() : undefined,
                    });
                });
            } catch (error) {
                console.error(`[Patch] Error applying patch to ${filePath}:`, error.name);
                res.status(500).send({
                    error: 'Patch application failed: ' + (error && error.message ? error.message : error),
                });
            }
        });

        app.post('/api/assets/bulk-read', async (req, res, next) => {
            if (!await checkAuth(req, res)) {
                return;
            }
            try {
                const keys = req.body;
                if (!Array.isArray(keys)) {
                    res.status(400).send({ error: 'Body must be a JSON array of keys' });
                    return;
                }

                const acceptsBinary = (req.headers['accept'] || '').includes('application/octet-stream');
                if (acceptsBinary) {
                    const entries = [];
                    let totalSize = 4;
                    for (let i = 0; i < keys.length; i += BULK_BATCH) {
                        const batch = keys.slice(i, i + BULK_BATCH);
                        for (const key of batch) {
                            let value = null;
                            if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                                value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                            }
                            if (value === null) {
                                value = kvGet(key);
                            }
                            if (value !== null) {
                                const keyBuf = Buffer.from(key, 'utf-8');
                                const valBuf = Buffer.from(value);
                                entries.push({ keyBuf, valBuf });
                                totalSize += 4 + keyBuf.length + 4 + valBuf.length;
                            }
                        }
                    }

                    const out = Buffer.allocUnsafe(totalSize);
                    let offset = 0;
                    out.writeUInt32BE(entries.length, offset);
                    offset += 4;
                    for (const { keyBuf, valBuf } of entries) {
                        out.writeUInt32BE(keyBuf.length, offset);
                        offset += 4;
                        keyBuf.copy(out, offset);
                        offset += keyBuf.length;
                        out.writeUInt32BE(valBuf.length, offset);
                        offset += 4;
                        valBuf.copy(out, offset);
                        offset += valBuf.length;
                    }
                    res.set('Content-Type', 'application/octet-stream');
                    res.send(out);
                    return;
                }

                const results = [];
                for (let i = 0; i < keys.length; i += BULK_BATCH) {
                    const batch = keys.slice(i, i + BULK_BATCH);
                    for (const key of batch) {
                        let value = null;
                        if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                            value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                        }
                        if (value === null) {
                            value = kvGet(key);
                        }
                        if (value !== null) {
                            results.push({ key, value: Buffer.from(value).toString('base64') });
                        }
                    }
                }
                res.json(results);
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/assets/bulk-write', async (req, res, next) => {
            if (!await checkAuth(req, res)) {
                return;
            }
            if (!checkActiveSession(req, res)) return;
            try {
                const entries = req.body;
                if (!Array.isArray(entries)) {
                    res.status(400).send({ error: 'Body must be a JSON array of {key, value}' });
                    return;
                }
                for (let i = 0; i < entries.length; i += BULK_BATCH) {
                    const batch = entries.slice(i, i + BULK_BATCH);
                    const writeBatch = sqliteDb.transaction(() => {
                        for (const { key, value } of batch) {
                            kvSet(key, Buffer.from(value, 'base64'));
                        }
                    });
                    writeBatch();
                }
                res.json({ success: true, count: entries.length });
            } catch (error) {
                next(error);
            }
        });
    }

    return {
        mountRoutes,
    };
}

module.exports = { createDataRoutes };
