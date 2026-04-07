'use strict';

const nodeCrypto = require('crypto');

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function createDbState({
    kvSet,
    kvCopyValue,
    kvList,
    kvSize,
    kvDel,
    encodeRisuSaveLegacy,
}) {
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

    function hasCacheEntry(key) {
        return hasOwn(dbCache, key);
    }

    function getCacheEntry(key) {
        return dbCache[key];
    }

    function setCacheEntry(key, value) {
        dbCache[key] = value;
        return value;
    }

    function deleteCacheEntry(key) {
        delete dbCache[key];
    }

    function hasSaveTimer(key) {
        return hasOwn(saveTimers, key);
    }

    function getSaveTimer(key) {
        return saveTimers[key];
    }

    function setSaveTimer(key, timer) {
        saveTimers[key] = timer;
        return timer;
    }

    function clearSaveTimer(key) {
        if (!hasSaveTimer(key)) {
            return false;
        }
        clearTimeout(saveTimers[key]);
        delete saveTimers[key];
        return true;
    }

    function getDbEtag() {
        return dbEtag;
    }

    function setDbEtag(value) {
        dbEtag = value;
        return dbEtag;
    }

    function flushPendingSave(key) {
        if (!clearSaveTimer(key)) {
            return;
        }
        const cachedValue = getCacheEntry(key);
        if (!cachedValue) {
            return;
        }

        const storageKey = Buffer.from(key, 'hex').toString('utf-8');
        const data = Buffer.from(encodeRisuSaveLegacy(cachedValue));
        kvSet(storageKey, data);

        if (storageKey === 'database/database.bin') {
            createBackupAndRotate();
        }
    }

    function flushPendingDb() {
        flushPendingSave(DB_HEX_KEY);
    }

    function flushAllPendingSaves() {
        for (const key of Object.keys(saveTimers)) {
            flushPendingSave(key);
        }
    }

    function clearAllPendingState() {
        for (const key of Object.keys(saveTimers)) {
            clearSaveTimer(key);
        }
        dbCache = {};
        dbEtag = null;
    }

    function invalidateDbCache() {
        deleteCacheEntry(DB_HEX_KEY);
        clearSaveTimer(DB_HEX_KEY);
        dbEtag = null;
    }

    return {
        DB_HEX_KEY,
        SAVE_INTERVAL,
        enablePatchSync,
        computeBufferEtag,
        computeDatabaseEtagFromObject,
        queueStorageOperation,
        createBackupAndRotate,
        flushPendingSave,
        flushPendingDb,
        flushAllPendingSaves,
        clearAllPendingState,
        invalidateDbCache,
        hasCacheEntry,
        getCacheEntry,
        setCacheEntry,
        deleteCacheEntry,
        hasSaveTimer,
        getSaveTimer,
        setSaveTimer,
        clearSaveTimer,
        getDbEtag,
        setDbEtag,
    };
}

module.exports = { createDbState };
