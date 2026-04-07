import { createRequire } from 'node:module'

import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { normalizeJSON } = require('./utils.cjs')

describe('server normalizeJSON', () => {
    test('drops transient reloadKeys fields from nested character data', () => {
        const result = normalizeJSON({
            characters: [
                {
                    chaId: 'char-1',
                    reloadKeys: 42,
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
        })

        expect(result).toEqual({
            characters: [
                {
                    chaId: 'char-1',
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
        })
    })
})
