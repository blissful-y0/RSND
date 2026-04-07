'use strict';

const path = require('path');
const fs = require('fs/promises');
const { existsSync, writeFileSync } = require('fs');
const sharp = require('sharp');

function createBackup({
    checkAuth,
    checkActiveSession,
    sessionAuthMiddleware,
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
    backupImportMaxBytes,
    backupEntryNameMaxBytes,
    backupDiskHeadroom,
}) {
    const {
        ASSET_EXT_MIME,
        detectMime,
        decodeDataUri,
        ensureInlayDir,
        getInlaySidecarPath,
        isSafeInlayId,
        listInlayFiles,
        normalizeInlayExt,
        readInlayFile,
        readInlaySidecar,
        writeInlayFile,
    } = inlay;

    const THUMB_MAX_SIDE = 320;
    const THUMB_QUALITY = 75;
    const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
    const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs');

    function acquireImportLock() {
        if (importState.inProgress) return false;
        importState.inProgress = true;
        return true;
    }

    function releaseImportLock() {
        importState.inProgress = false;
    }

    async function checkDiskSpace(requiredBytes) {
        try {
            const stats = await fs.statfs(savePath);
            const availableBytes = stats.bavail * stats.bsize;
            return { ok: availableBytes >= requiredBytes, available: availableBytes };
        } catch {
            return { ok: true, available: -1 };
        }
    }

    function resolveAssetPayload(key, rawValue) {
        if (key.startsWith('inlay/') || key.startsWith('inlay_thumb/')) {
            try {
                const json = JSON.parse(rawValue.toString('utf-8'));
                const dataUri = json.data;
                if (typeof dataUri === 'string' && dataUri.startsWith('data:')) {
                    const commaIdx = dataUri.indexOf(',');
                    const meta = dataUri.substring(5, commaIdx);
                    const mime = meta.split(';')[0];
                    const binary = Buffer.from(dataUri.substring(commaIdx + 1), 'base64');
                    return { binary, contentType: mime || 'application/octet-stream' };
                }
                const ext = (json.ext || '').toLowerCase();
                const mime = ASSET_EXT_MIME[ext] || 'application/octet-stream';
                return { binary: rawValue, contentType: mime };
            } catch {}
        }

        const ext = key.split('.').pop()?.toLowerCase();
        const contentType = ASSET_EXT_MIME[ext] || detectMime(rawValue);
        return { binary: rawValue, contentType };
    }

    async function generateThumbnail(buffer) {
        return sharp(buffer)
            .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: THUMB_QUALITY })
            .toBuffer();
    }

    function encodeBackupEntry(name, data) {
        const encodedName = Buffer.from(name, 'utf-8');
        const nameLength = Buffer.allocUnsafe(4);
        nameLength.writeUInt32LE(encodedName.length, 0);
        const dataLength = Buffer.allocUnsafe(4);
        dataLength.writeUInt32LE(data.length, 0);
        return Buffer.concat([nameLength, encodedName, dataLength, data]);
    }

    function isInvalidBackupPathSegment(name) {
        return (
            !name ||
            name.includes('\0') ||
            name.includes('\\') ||
            name.startsWith('/') ||
            name.includes('../') ||
            name.includes('/..') ||
            name === '.' ||
            name === '..'
        );
    }

    function parseInlayBackupName(name) {
        if (!name.startsWith('inlay/')) return null;
        const suffix = name.slice('inlay/'.length);
        if (!suffix || suffix.includes('/')) return null;
        const dotIdx = suffix.lastIndexOf('.');
        if (dotIdx <= 0) return { id: suffix, ext: null };
        return { id: suffix.slice(0, dotIdx), ext: suffix.slice(dotIdx + 1) };
    }

    function parseInlaySidecarBackupName(name) {
        if (!name.startsWith('inlay_sidecar/')) return null;
        const id = name.slice('inlay_sidecar/'.length);
        if (!isSafeInlayId(id)) return null;
        return { id };
    }

    function resolveBackupStorageKey(name) {
        if (Buffer.byteLength(name, 'utf-8') > backupEntryNameMaxBytes) {
            throw new Error(`Backup entry name too long: ${name.slice(0, 64)}`);
        }

        if (name === 'database.risudat') {
            return 'database/database.bin';
        }

        if (name.startsWith('inlay_thumb/') || name.startsWith('inlay_meta/')) {
            if (isInvalidBackupPathSegment(name)) {
                throw new Error(`Invalid backup entry name: ${name}`);
            }
            return name;
        }

        if (name.startsWith('inlay/')) {
            const parsed = parseInlayBackupName(name);
            if (!parsed || !isSafeInlayId(parsed.id)) {
                throw new Error(`Invalid inlay backup entry name: ${name}`);
            }
            return name;
        }

        if (name.startsWith('inlay_sidecar/')) {
            const parsed = parseInlaySidecarBackupName(name);
            if (!parsed) {
                throw new Error(`Invalid inlay sidecar backup entry name: ${name}`);
            }
            return name;
        }

        if (isInvalidBackupPathSegment(name) || name !== path.basename(name)) {
            throw new Error(`Invalid asset backup entry name: ${name}`);
        }

        return `assets/${name}`;
    }

    function parseBackupChunk(buffer, onEntry) {
        let offset = 0;
        while (offset + 4 <= buffer.length) {
            const nameLength = buffer.readUInt32LE(offset);
            if (offset + 4 + nameLength > buffer.length) break;
            const nameStart = offset + 4;
            const nameEnd = nameStart + nameLength;
            const name = buffer.subarray(nameStart, nameEnd).toString('utf-8');
            if (nameEnd + 4 > buffer.length) break;
            const dataLength = buffer.readUInt32LE(nameEnd);
            const dataStart = nameEnd + 4;
            const dataEnd = dataStart + dataLength;
            if (dataEnd > buffer.length) break;
            onEntry(name, buffer.subarray(dataStart, dataEnd));
            offset = dataEnd;
        }
        return buffer.subarray(offset);
    }

    function mountRoutes(app) {
        app.get('/api/asset/:hexKey', sessionAuthMiddleware, async (req, res) => {
            try {
                const key = Buffer.from(req.params.hexKey, 'hex').toString('utf-8');

                if (key.startsWith('inlay/')) {
                    const id = key.slice('inlay/'.length);
                    const file = await readInlayFile(id);
                    if (file) {
                        const etag = `"${Math.floor(file.mtimeMs)}"`;
                        if (req.headers['if-none-match'] === etag) {
                            return res.status(304).end();
                        }
                        res.set({
                            'Content-Type': file.mime,
                            'Cache-Control': 'public, max-age=86400',
                            'ETag': etag,
                        });
                        return res.send(file.buffer);
                    }
                    return res.status(404).end();
                }

                if (key.startsWith('inlay_thumb/')) {
                    const id = key.slice('inlay_thumb/'.length);
                    const sidecar = await readInlaySidecar(id);
                    if (!sidecar || sidecar.type !== 'image' || !THUMB_IMAGE_EXTS.has(sidecar.ext)) {
                        return res.status(404).end();
                    }
                    const file = await readInlayFile(id);
                    if (!file) return res.status(404).end();
                    const etag = `"thumb-${Math.floor(file.mtimeMs)}"`;
                    if (req.headers['if-none-match'] === etag) {
                        return res.status(304).end();
                    }
                    const thumb = await generateThumbnail(file.buffer);
                    res.set({
                        'Content-Type': 'image/webp',
                        'Cache-Control': 'public, max-age=86400, must-revalidate',
                        'ETag': etag,
                    });
                    return res.send(thumb);
                }

                const updatedAt = kvGetUpdatedAt(key);
                if (updatedAt === null) return res.status(404).end();

                const etag = `"${updatedAt}"`;
                if (req.headers['if-none-match'] === etag) {
                    return res.status(304).end();
                }

                const data = kvGet(key);
                if (!data) return res.status(404).end();

                const { binary, contentType } = resolveAssetPayload(key, data);
                res.set({
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=0, must-revalidate',
                    'ETag': etag,
                });
                res.send(binary);
            } catch (error) {
                console.error('[Asset] Failed to serve asset:', error);
                res.status(500).end();
            }
        });

        app.get('/api/backup/export', async (req, res, next) => {
            if (!await checkAuth(req, res)) return;
            try {
                dbState.flushAllPendingSaves();
                const inlayFiles = await listInlayFiles();
                const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
                    const stat = await fs.stat(entry.filePath);
                    return {
                        kind: 'file',
                        sourcePath: entry.filePath,
                        backupName: `inlay/${entry.id}.${entry.ext}`,
                        sortKey: `inlay/${entry.id}`,
                        size: stat.size,
                    };
                }));
                const sidecarEntries = await Promise.all(inlayFiles.map(async (entry) => {
                    const sidecarPath = getInlaySidecarPath(entry.id);
                    try {
                        const stat = await fs.stat(sidecarPath);
                        return {
                            kind: 'sidecar',
                            sourcePath: sidecarPath,
                            backupName: `inlay_sidecar/${entry.id}`,
                            sortKey: `inlay_sidecar/${entry.id}`,
                            size: stat.size,
                        };
                    } catch {
                        return null;
                    }
                }));

                const namespacedEntries = [
                    ...kvListWithSizes('assets/').map((entry) => ({
                        kind: 'kv',
                        key: entry.key,
                        backupName: path.basename(entry.key),
                        sortKey: entry.key,
                        size: entry.size,
                    })),
                    ...kvListWithSizes('inlay_meta/').map((entry) => ({
                        kind: 'kv',
                        key: entry.key,
                        backupName: entry.key,
                        sortKey: entry.key,
                        size: entry.size,
                    })),
                    ...inlayEntries,
                    ...sidecarEntries.filter(Boolean),
                ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

                const dbSize = kvSize('database/database.bin');
                const totalBytes = namespacedEntries.reduce((sum, entry) => (
                    sum + 8 + Buffer.byteLength(entry.backupName, 'utf-8') + entry.size
                ), 0) + (dbSize ? 8 + Buffer.byteLength('database.risudat', 'utf-8') + dbSize : 0);

                res.setHeader('content-type', 'application/octet-stream');
                res.setHeader('content-disposition', `attachment; filename="risu-backup-${Date.now()}.bin"`);
                res.setHeader('content-length', totalBytes);
                res.setHeader('x-risu-backup-assets', namespacedEntries.length);

                let closed = false;
                res.once('close', () => { closed = true; });

                function waitForDrain() {
                    if (closed) return Promise.resolve();
                    return new Promise((resolve) => {
                        function done() {
                            res.removeListener('drain', done);
                            res.removeListener('close', done);
                            resolve();
                        }
                        res.once('drain', done);
                        res.once('close', done);
                    });
                }

                for (const entry of namespacedEntries) {
                    if (closed) break;
                    const value = entry.kind === 'kv'
                        ? kvGet(entry.key)
                        : await fs.readFile(entry.sourcePath);
                    if (closed) break;
                    if (value) {
                        const ok = res.write(encodeBackupEntry(entry.backupName, value));
                        if (!ok) {
                            await waitForDrain();
                            if (closed) break;
                        }
                    }
                }

                if (!closed && dbSize) {
                    const dbValue = kvGet('database/database.bin');
                    if (dbValue) {
                        const ok = res.write(encodeBackupEntry('database.risudat', dbValue));
                        if (!ok) {
                            await waitForDrain();
                        }
                    }
                }
                if (!closed) res.end();
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/backup/import/prepare', async (req, res, next) => {
            if (!await checkAuth(req, res)) return;
            if (!checkActiveSession(req, res)) return;
            try {
                if (importState.inProgress) {
                    res.status(409).json({ error: 'Another import is already in progress' });
                    return;
                }

                const size = Number(req.body?.size ?? 0);
                if (backupImportMaxBytes > 0 && size > backupImportMaxBytes) {
                    res.status(413).json({ error: `Backup exceeds max allowed size (${backupImportMaxBytes} bytes)` });
                    return;
                }

                if (size > 0) {
                    const disk = await checkDiskSpace(size * backupDiskHeadroom);
                    if (!disk.ok) {
                        res.status(507).json({
                            error: 'Insufficient disk space',
                            available: disk.available,
                            required: size * backupDiskHeadroom,
                        });
                        return;
                    }
                }

                res.json({ ok: true });
            } catch (error) {
                next(error);
            }
        });

        app.post('/api/backup/import', async (req, res, next) => {
            if (!await checkAuth(req, res)) return;
            if (!checkActiveSession(req, res)) return;
            if (!acquireImportLock()) {
                res.status(409).json({ error: 'Another import is already in progress' });
                return;
            }

            const prevRequestTimeout = req.socket.server?.requestTimeout;
            req.socket.setTimeout(0);
            req.socket.setKeepAlive(true);
            if (req.socket.server) req.socket.server.requestTimeout = 0;

            try {
                const contentType = String(req.headers['content-type'] ?? '');
                if (contentType && !contentType.includes('application/x-risu-backup') && !contentType.includes('application/octet-stream')) {
                    res.status(415).json({ error: 'Unsupported backup content-type' });
                    return;
                }

                const contentLength = Number(req.headers['content-length'] ?? '0');
                if (backupImportMaxBytes > 0 && Number.isFinite(contentLength) && contentLength > backupImportMaxBytes) {
                    res.status(413).json({ error: `Backup exceeds max allowed size (${backupImportMaxBytes} bytes)` });
                    return;
                }

                let responsePayload = null;
                await dbState.queueStorageOperation(async () => {
                    dbState.flushAllPendingSaves();
                    dbState.clearAllPendingState();

                    const BATCH_SIZE = 5000;
                    let remainingBuffer = Buffer.alloc(0);
                    let hasDatabase = false;
                    let assetsRestored = 0;
                    let bytesReceived = 0;
                    let batchCount = 0;
                    const seenEntryNames = new Set();
                    const importedInlayIds = new Set();
                    const importedSidecarIds = new Set();
                    const explicitSidecarMap = new Map();
                    const legacyInlayInfoMap = new Map();
                    const stagingDir = path.join(savePath, 'inlays_import_staging');
                    const backupInlayDir = path.join(savePath, 'inlays_import_backup');

                    await fs.rm(stagingDir, { recursive: true, force: true });
                    await fs.rm(backupInlayDir, { recursive: true, force: true });
                    await fs.mkdir(stagingDir, { recursive: true });

                    function stagingInlayFilePath(id, ext) {
                        return path.join(stagingDir, `${id}.${normalizeInlayExt(ext)}`);
                    }

                    function stagingSidecarPath(id) {
                        return path.join(stagingDir, `${id}.meta.json`);
                    }

                    function writeStagingInlayFileSync(id, ext, buffer, info) {
                        const normalizedExt = normalizeInlayExt(ext);
                        writeFileSync(stagingInlayFilePath(id, normalizedExt), Buffer.from(buffer));
                        const sidecar = {
                            ext: normalizedExt,
                            name: typeof info?.name === 'string' ? info.name : id,
                            type: typeof info?.type === 'string' ? info.type : 'image',
                            height: typeof info?.height === 'number' ? info.height : undefined,
                            width: typeof info?.width === 'number' ? info.width : undefined,
                        };
                        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
                    }

                    function writeStagingSidecarSync(id, info) {
                        const sidecar = {
                            ext: normalizeInlayExt(info?.ext),
                            name: typeof info?.name === 'string' ? info.name : id,
                            type: typeof info?.type === 'string' ? info.type : 'image',
                            height: typeof info?.height === 'number' ? info.height : undefined,
                            width: typeof info?.width === 'number' ? info.width : undefined,
                        };
                        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
                    }

                    sqliteDb.pragma('synchronous = OFF');
                    sqliteDb.exec('BEGIN');
                    kvDelPrefix('assets/');
                    kvDelPrefix('inlay/');
                    kvDelPrefix('inlay_thumb/');
                    kvDelPrefix('inlay_meta/');
                    kvDelPrefix('inlay_info/');
                    clearEntities();
                    sqliteDb.exec('COMMIT');

                    sqliteDb.exec('BEGIN');
                    try {
                        for await (const chunk of req) {
                            bytesReceived += chunk.length;
                            if (backupImportMaxBytes > 0 && bytesReceived > backupImportMaxBytes) {
                                throw new Error(`Backup exceeds max allowed size (${backupImportMaxBytes} bytes)`);
                            }

                            remainingBuffer = remainingBuffer.length === 0
                                ? Buffer.from(chunk)
                                : Buffer.concat([remainingBuffer, Buffer.from(chunk)]);
                            remainingBuffer = parseBackupChunk(remainingBuffer, (name, data) => {
                                if (seenEntryNames.has(name)) {
                                    throw new Error(`Duplicate backup entry: ${name}`);
                                }
                                seenEntryNames.add(name);

                                const inlayRaw = parseInlayBackupName(name);
                                const inlaySidecar = parseInlaySidecarBackupName(name);

                                if (inlayRaw) {
                                    importedInlayIds.add(inlayRaw.id);
                                    if (inlayRaw.ext) {
                                        writeStagingInlayFileSync(inlayRaw.id, inlayRaw.ext, data, legacyInlayInfoMap.get(inlayRaw.id) || { ext: inlayRaw.ext, name: inlayRaw.id, type: 'image' });
                                    } else if (data.length > 0 && data[0] === 0x7b) {
                                        const parsed = JSON.parse(data.toString('utf-8'));
                                        const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                                        const ext = normalizeInlayExt(parsed?.ext);
                                        const buffer = type === 'signature'
                                            ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                                            : decodeDataUri(parsed?.data).buffer;
                                        writeStagingInlayFileSync(inlayRaw.id, ext, buffer, legacyInlayInfoMap.get(inlayRaw.id) || {
                                            ext,
                                            name: typeof parsed?.name === 'string' ? parsed.name : inlayRaw.id,
                                            type,
                                            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                                            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                                        });
                                    } else {
                                        writeStagingInlayFileSync(inlayRaw.id, 'bin', data, legacyInlayInfoMap.get(inlayRaw.id) || {
                                            ext: 'bin',
                                            name: inlayRaw.id,
                                            type: 'image',
                                        });
                                    }
                                    if (explicitSidecarMap.has(inlayRaw.id)) {
                                        writeStagingSidecarSync(inlayRaw.id, explicitSidecarMap.get(inlayRaw.id));
                                    } else if (!importedSidecarIds.has(inlayRaw.id)) {
                                        const legacyInfo = legacyInlayInfoMap.get(inlayRaw.id);
                                        if (legacyInfo) {
                                            writeStagingSidecarSync(inlayRaw.id, legacyInfo);
                                        }
                                    }
                                    assetsRestored += 1;
                                } else if (inlaySidecar) {
                                    const parsed = JSON.parse(data.toString('utf-8'));
                                    explicitSidecarMap.set(inlaySidecar.id, parsed);
                                    writeStagingSidecarSync(inlaySidecar.id, parsed);
                                    importedSidecarIds.add(inlaySidecar.id);
                                } else if (name.startsWith('inlay_info/')) {
                                    const id = name.slice('inlay_info/'.length);
                                    if (!isSafeInlayId(id)) {
                                        throw new Error(`Invalid legacy inlay info entry name: ${name}`);
                                    }
                                    const parsed = JSON.parse(data.toString('utf-8'));
                                    legacyInlayInfoMap.set(id, {
                                        ext: normalizeInlayExt(parsed?.ext),
                                        name: typeof parsed?.name === 'string' ? parsed.name : id,
                                        type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                                        height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                                        width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                                    });
                                    if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                                        writeStagingSidecarSync(id, legacyInlayInfoMap.get(id));
                                    }
                                } else if (name.startsWith('inlay_thumb/')) {
                                    return;
                                } else {
                                    const storageKey = resolveBackupStorageKey(name);
                                    kvSet(storageKey, data);
                                    if (storageKey === 'database/database.bin') {
                                        hasDatabase = true;
                                    } else {
                                        assetsRestored += 1;
                                    }
                                }

                                batchCount++;
                                if (batchCount >= BATCH_SIZE) {
                                    sqliteDb.exec('COMMIT');
                                    sqliteDb.exec('BEGIN');
                                    batchCount = 0;
                                }
                            });
                        }

                        if (remainingBuffer.length > 0) {
                            throw new Error('Backup stream ended with incomplete entry');
                        }
                        if (!hasDatabase) {
                            throw new Error('Backup does not contain database.risudat');
                        }
                        for (const [id, info] of legacyInlayInfoMap.entries()) {
                            if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                                writeStagingSidecarSync(id, info);
                            }
                        }
                        sqliteDb.exec('COMMIT');
                    } catch (error) {
                        try { sqliteDb.exec('ROLLBACK'); } catch {}
                        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
                        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
                        throw error;
                    } finally {
                        sqliteDb.pragma('synchronous = NORMAL');
                    }

                    await ensureInlayDir();
                    try {
                        if (existsSync(inlayDir)) {
                            await fs.rename(inlayDir, backupInlayDir);
                        }
                        await fs.rename(stagingDir, inlayDir);
                        await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
                        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
                    } catch (swapError) {
                        if (existsSync(backupInlayDir)) {
                            await fs.rm(inlayDir, { recursive: true, force: true }).catch(() => {});
                            await fs.rename(backupInlayDir, inlayDir).catch(() => {});
                        }
                        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
                        throw swapError;
                    }

                    dbState.clearAllPendingState();
                    try {
                        checkpointWal('TRUNCATE');
                    } catch (checkpointError) {
                        console.warn('[Backup Import] WAL checkpoint after import failed:', checkpointError);
                    }

                    console.log(`[Backup Import] Complete: ${assetsRestored} assets restored, ${(bytesReceived / 1024 / 1024).toFixed(1)}MB processed`);
                    responsePayload = { ok: true, assetsRestored };
                });

                res.json(responsePayload || { ok: true });
            } catch (error) {
                next(error);
            } finally {
                releaseImportLock();
                if (req.socket.server && prevRequestTimeout !== undefined) {
                    req.socket.server.requestTimeout = prevRequestTimeout;
                }
            }
        });
    }

    return {
        mountRoutes,
        acquireImportLock,
        releaseImportLock,
    };
}

module.exports = { createBackup };
