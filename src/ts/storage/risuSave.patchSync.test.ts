import { createRequire } from 'node:module'

import { describe, expect, test, vi } from 'vitest'

vi.mock('./database.svelte', () => ({
    getDatabase: () => ({}),
    presetTemplate: {},
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {},
}))

const { RisuSavePatcher, calculateHash, normalizeJSON } = await import('./risuSave')
const require = createRequire(import.meta.url)
const { calculateHash: serverCalculateHash, normalizeJSON: serverNormalizeJSON } = require('../../../server/node/utils.cjs')

describe('RisuSavePatcher', () => {
    test('keeps client and server patch hashes aligned when reloadKeys changes', () => {
        const value = {
            characters: [
                {
                    chaId: 'char-1',
                    reloadKeys: 99,
                    chats: [
                        {
                            id: 'chat-1',
                            message: [
                                {
                                    role: 'char',
                                    data: 'hello',
                                },
                            ],
                        },
                    ],
                },
            ],
            botPresets: [],
            modules: [],
        }

        const clientHash = calculateHash(normalizeJSON(value)).toString(16)
        const serverHash = serverCalculateHash(serverNormalizeJSON(value)).toString(16)

        expect(clientHash).toBe(serverHash)
    })

    test('does not include reloadKeys in character patch output', async () => {
        const base = {
            characters: [
                {
                    chaId: 'char-1',
                    reloadKeys: 10,
                    chats: [
                        {
                            id: 'chat-1',
                            message: [
                                {
                                    role: 'char',
                                    data: 'before',
                                },
                            ],
                        },
                    ],
                },
            ],
            botPresets: [],
            modules: [],
        }

        const next = {
            characters: [
                {
                    chaId: 'char-1',
                    reloadKeys: 11,
                    chats: [
                        {
                            id: 'chat-1',
                            message: [
                                {
                                    role: 'char',
                                    data: 'after',
                                },
                            ],
                        },
                    ],
                },
            ],
            botPresets: [],
            modules: [],
        }

        const patcher = new RisuSavePatcher()
        await patcher.init(base)

        const result = await patcher.set(next, {
            root: false,
            botPreset: false,
            modules: false,
            loadouts: false,
            plugins: false,
            pluginCustomStorage: false,
            character: ['char-1'],
            chat: [],
        })

        expect(result.patch).toContainEqual({
            op: 'replace',
            path: '/characters/0/chats/0/message/0/data',
            value: 'after',
        })
        expect(result.patch.some((entry) => entry.path === '/characters/0/reloadKeys')).toBe(false)
    })
})
