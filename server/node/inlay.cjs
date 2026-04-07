'use strict';

const path = require('path');
const fs = require('fs/promises');
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } = require('fs');

function createInlay({ inlayDir, kvGet, kvDel, kvList }) {
    const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs');
    const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

    function isSafeInlayId(id) {
        return typeof id === 'string' &&
            id.length > 0 &&
            !id.includes('\0') &&
            !id.includes('/') &&
            !id.includes('\\') &&
            id !== '.' &&
            id !== '..';
    }

    function normalizeInlayExt(ext) {
        if (typeof ext !== 'string') return 'bin';
        const normalized = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '');
        return normalized || 'bin';
    }

    function assertInsideInlayDir(filePath) {
        if (!path.resolve(filePath).startsWith(resolvedInlayDir)) {
            throw new Error(`Path escapes inlay directory: ${filePath}`);
        }
    }

    function getInlayFilePath(id, ext) {
        if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
        const p = path.join(inlayDir, `${id}.${normalizeInlayExt(ext)}`);
        assertInsideInlayDir(p);
        return p;
    }

    function getInlaySidecarPath(id) {
        if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
        const p = path.join(inlayDir, `${id}.meta.json`);
        assertInsideInlayDir(p);
        return p;
    }

    async function ensureInlayDir() {
        await fs.mkdir(inlayDir, { recursive: true });
    }

    function ensureInlayDirSync() {
        if (!existsSync(inlayDir)) {
            mkdirSync(inlayDir, { recursive: true });
        }
    }

    function detectMime(buf) {
        if (!buf || buf.length < 12) return 'application/octet-stream';
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
        if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
            buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
        if (buf[0] === 0x1a && buf[1] === 0x45) return 'video/webm';
        if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4';
        return 'application/octet-stream';
    }

    const ASSET_EXT_MIME = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp',
        mp4: 'video/mp4', webm: 'video/webm',
        mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    };

    function getMimeFromExt(ext, buffer) {
        return ASSET_EXT_MIME[normalizeInlayExt(ext)] || detectMime(buffer);
    }

    function decodeDataUri(dataUri) {
        if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
            throw new Error('Invalid data URI');
        }
        const commaIdx = dataUri.indexOf(',');
        if (commaIdx === -1) {
            throw new Error('Malformed data URI');
        }
        const meta = dataUri.substring(5, commaIdx);
        return {
            buffer: Buffer.from(dataUri.substring(commaIdx + 1), 'base64'),
            mime: meta.split(';')[0] || 'application/octet-stream',
        };
    }

    function encodeDataUri(buffer, mime) {
        return `data:${mime || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
    }

    async function readInlaySidecar(id) {
        try {
            const raw = await fs.readFile(getInlaySidecarPath(id), 'utf-8');
            const parsed = JSON.parse(raw);
            return {
                ext: normalizeInlayExt(parsed?.ext),
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            };
        } catch {
            return null;
        }
    }

    async function resolveInlayFilePath(id) {
        if (!isSafeInlayId(id)) return null;
        const sidecar = await readInlaySidecar(id);
        if (sidecar) {
            const candidate = getInlayFilePath(id, sidecar.ext);
            try {
                await fs.access(candidate);
                return candidate;
            } catch {}
        }
        try {
            const entries = await fs.readdir(inlayDir, { withFileTypes: true });
            const match = entries.find((entry) => (
                entry.isFile() &&
                entry.name.startsWith(`${id}.`) &&
                entry.name !== `${id}.meta.json`
            ));
            return match ? path.join(inlayDir, match.name) : null;
        } catch {
            return null;
        }
    }

    function resolveInlayFilePathSync(id) {
        if (!isSafeInlayId(id)) return null;
        try {
            const raw = readFileSync(getInlaySidecarPath(id), 'utf-8');
            const parsed = JSON.parse(raw);
            const ext = normalizeInlayExt(parsed?.ext);
            const candidate = getInlayFilePath(id, ext);
            if (existsSync(candidate)) return candidate;
        } catch {}
        try {
            const entries = readdirSync(inlayDir, { withFileTypes: true });
            const match = entries.find((entry) => (
                entry.isFile() &&
                entry.name.startsWith(`${id}.`) &&
                entry.name !== `${id}.meta.json`
            ));
            return match ? path.join(inlayDir, match.name) : null;
        } catch {
            return null;
        }
    }

    async function readInlayFile(id) {
        const filePath = await resolveInlayFilePath(id);
        if (!filePath) return null;
        const ext = normalizeInlayExt(path.extname(filePath).slice(1));
        const buffer = await fs.readFile(filePath);
        const stat = await fs.stat(filePath);
        return {
            buffer,
            ext,
            filePath,
            mtimeMs: stat.mtimeMs,
            mime: getMimeFromExt(ext, buffer),
        };
    }

    async function writeInlaySidecar(id, info) {
        await ensureInlayDir();
        const sidecar = {
            ext: normalizeInlayExt(info?.ext),
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        await fs.writeFile(getInlaySidecarPath(id), JSON.stringify(sidecar));
    }

    function writeInlaySidecarSync(id, info) {
        ensureInlayDirSync();
        const sidecar = {
            ext: normalizeInlayExt(info?.ext),
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        writeFileSync(getInlaySidecarPath(id), JSON.stringify(sidecar));
    }

    async function writeInlayFile(id, ext, buffer, info = null) {
        await ensureInlayDir();
        await deleteInlayRawFile(id);
        const normalizedExt = normalizeInlayExt(ext);
        await fs.writeFile(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
        await writeInlaySidecar(id, {
            ...(info || {}),
            ext: normalizedExt,
        });
    }

    function writeInlayFileSync(id, ext, buffer, info = null) {
        ensureInlayDirSync();
        deleteInlayRawFileSync(id);
        const normalizedExt = normalizeInlayExt(ext);
        writeFileSync(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
        writeInlaySidecarSync(id, {
            ...(info || {}),
            ext: normalizedExt,
        });
    }

    async function deleteInlayRawFile(id) {
        const filePath = await resolveInlayFilePath(id);
        if (!filePath) return;
        await fs.unlink(filePath).catch(() => {});
    }

    function deleteInlayRawFileSync(id) {
        const filePath = resolveInlayFilePathSync(id);
        if (!filePath) return;
        try {
            unlinkSync(filePath);
        } catch {}
    }

    async function deleteInlayFile(id) {
        await deleteInlayRawFile(id);
        await fs.unlink(getInlaySidecarPath(id)).catch(() => {});
    }

    function deleteInlayFileSync(id) {
        deleteInlayRawFileSync(id);
        try {
            unlinkSync(getInlaySidecarPath(id));
        } catch {}
    }

    async function listInlayFiles() {
        await ensureInlayDir();
        const entries = await fs.readdir(inlayDir, { withFileTypes: true });
        return entries
            .filter((entry) => (
                entry.isFile() &&
                entry.name !== '.migrated_to_fs' &&
                !entry.name.endsWith('.meta.json')
            ))
            .map((entry) => {
                const ext = normalizeInlayExt(path.extname(entry.name).slice(1));
                const id = entry.name.slice(0, -(ext.length + 1));
                return { id, ext, filePath: path.join(inlayDir, entry.name) };
            })
            .filter((entry) => isSafeInlayId(entry.id));
    }

    async function readInlayLegacyInfo(id) {
        const value = kvGet(`inlay_info/${id}`);
        if (!value) return null;
        try {
            const parsed = JSON.parse(value.toString('utf-8'));
            return {
                ext: normalizeInlayExt(parsed?.ext),
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            };
        } catch {
            return null;
        }
    }

    async function readInlayInfoPayload(id) {
        const sidecar = await readInlaySidecar(id);
        if (sidecar) return Buffer.from(JSON.stringify(sidecar));
        const legacy = await readInlayLegacyInfo(id);
        if (legacy) return Buffer.from(JSON.stringify(legacy));
        return kvGet(`inlay_info/${id}`);
    }

    async function readInlayAssetPayload(id) {
        const file = await readInlayFile(id);
        if (!file) return null;
        const sidecar = (await readInlaySidecar(id)) || (await readInlayLegacyInfo(id));
        const info = {
            ext: sidecar?.ext || file.ext,
            name: sidecar?.name || id,
            type: sidecar?.type || 'image',
            height: sidecar?.height,
            width: sidecar?.width,
        };
        const data = info.type === 'signature'
            ? file.buffer.toString('utf-8')
            : encodeDataUri(file.buffer, file.mime);
        return Buffer.from(JSON.stringify({
            ...info,
            data,
        }));
    }

    async function migrateInlaysToFilesystem() {
        await ensureInlayDir();
        if (existsSync(inlayMigrationMarker)) return;

        const keys = kvList('inlay/');
        for (const key of keys) {
            const id = key.slice('inlay/'.length);
            if (!isSafeInlayId(id)) continue;
            const fileAlreadyExists = await readInlayFile(id);
            if (fileAlreadyExists) {
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
                continue;
            }
            const value = kvGet(key);
            if (!value) continue;
            try {
                const parsed = JSON.parse(value.toString('utf-8'));
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                const ext = normalizeInlayExt(parsed?.ext);
                let buffer;
                if (type === 'signature') {
                    buffer = Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8');
                } else {
                    buffer = decodeDataUri(parsed?.data).buffer;
                }
                const info = (await readInlayLegacyInfo(id)) || {
                    ext,
                    name: typeof parsed?.name === 'string' ? parsed.name : id,
                    type,
                    height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                    width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                };
                await writeInlayFile(id, ext, buffer, info);
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
            } catch (error) {
                console.warn(`[InlayFS] Failed to migrate ${key}:`, error?.message || error);
            }
        }

        await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
    }

    return {
        ASSET_EXT_MIME,
        isSafeInlayId,
        normalizeInlayExt,
        getInlayFilePath,
        getInlaySidecarPath,
        ensureInlayDir,
        ensureInlayDirSync,
        detectMime,
        getMimeFromExt,
        decodeDataUri,
        encodeDataUri,
        readInlaySidecar,
        resolveInlayFilePath,
        resolveInlayFilePathSync,
        readInlayFile,
        writeInlaySidecar,
        writeInlaySidecarSync,
        writeInlayFile,
        writeInlayFileSync,
        deleteInlayRawFile,
        deleteInlayRawFileSync,
        deleteInlayFile,
        deleteInlayFileSync,
        listInlayFiles,
        readInlayLegacyInfo,
        readInlayInfoPayload,
        readInlayAssetPayload,
        migrateInlaysToFilesystem,
    };
}

module.exports = { createInlay };
