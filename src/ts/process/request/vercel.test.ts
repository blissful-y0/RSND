import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    fetchNative: vi.fn(),
    requestOpenAI: vi.fn(),
    db: {
        vercelKey: 'vc-test-key',
        vercelRequestModel: '',
    },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: mocks.fetchNative,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))

vi.mock('./openAI/requests', () => ({
    requestOpenAI: mocks.requestOpenAI,
}))

describe('Vercel AI Gateway usage helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.db.vercelKey = 'vc-test-key'
        mocks.db.vercelRequestModel = ''
    })

    test('fetches AI Gateway credit balance with the configured API key', async () => {
        mocks.fetchNative.mockResolvedValue({
            ok: true,
            json: async () => ({ balance: '95.50', total_used: '4.50' }),
        })

        const { fetchVercelCredits } = await import('./vercel')

        const result = await fetchVercelCredits('vc-test-key')

        expect(mocks.fetchNative).toHaveBeenCalledWith('https://ai-gateway.vercel.sh/v1/credits', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer vc-test-key',
                'Content-Type': 'application/json',
            },
        })
        expect(result).toEqual({
            credits: {
                balance: '95.50',
                totalUsed: '4.50',
            },
        })
    })

    test('reads model capabilities from Vercel model tags', async () => {
        mocks.fetchNative.mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [{
                    id: 'openai/gpt-5',
                    name: 'GPT-5',
                    type: 'language',
                    context_window: 400000,
                    max_tokens: 128000,
                    tags: ['vision', 'reasoning'],
                    pricing: { input: '0.00000125', output: '0.00001' },
                }],
            }),
        })

        const { fetchVercelModels } = await import('./vercel')

        const result = await fetchVercelModels()

        expect(result.models[0]).toMatchObject({
            id: 'openai/gpt-5',
            supportsVision: true,
            supportsReasoning: true,
            promptPrice1M: 1.25,
            completionPrice1M: 10,
        })
    })

    test('fails custom Vercel requests when no Gateway model is selected', async () => {
        const { requestVercel } = await import('./vercel')

        const result = await requestVercel({
            modelInfo: {
                id: 'vercel',
                name: 'Vercel AI Gateway',
                internalID: 'vercel',
                provider: 18,
                format: 0,
                flags: [],
                parameters: [],
                tokenizer: 0,
            },
        } as any)

        expect(mocks.requestOpenAI).not.toHaveBeenCalled()
        expect(result).toEqual({
            type: 'fail',
            result: 'No Vercel Gateway model selected. Choose a model in Settings → Model → Vercel.',
        })
    })

    test('uses selected Gateway model for custom Vercel requests', async () => {
        mocks.db.vercelRequestModel = 'openai/gpt-5'
        mocks.requestOpenAI.mockResolvedValue({ type: 'success', result: 'ok' })
        const { requestVercel } = await import('./vercel')

        await requestVercel({
            modelInfo: {
                id: 'vercel',
                name: 'Vercel AI Gateway',
                internalID: 'vercel',
                provider: 18,
                format: 0,
                flags: [],
                parameters: [],
                tokenizer: 0,
            },
        } as any)

        expect(mocks.requestOpenAI).toHaveBeenCalledWith(expect.objectContaining({
            key: 'vc-test-key',
            customURL: 'https://ai-gateway.vercel.sh/v1/chat/completions',
            modelInfo: expect.objectContaining({
                internalID: 'openai/gpt-5',
            }),
        }))
    })
})
