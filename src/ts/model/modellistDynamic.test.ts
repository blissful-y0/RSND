import { beforeEach, describe, expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    DBState: {
        db: {
            copilot: {
                githubTokens: [],
            },
            nanogpt: {
                apiKeys: ['ng-test-key'],
            },
            google: {
                accessToken: '',
            },
            vercelKey: 'vc-test-key',
        },
    },
    fetchNanoGPTModels: vi.fn(),
    fetchVercelModels: vi.fn(),
}))

vi.mock('../stores.svelte', () => ({
    DBState: mocks.DBState,
}))

vi.mock('../plugins/plugins.svelte', () => ({
    customProviderStore: writable([]),
    pluginV2: {},
}))

vi.mock('../plugins/apiV3/v3.svelte', () => ({
    customV3ProviderMetaStore: [],
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => mocks.DBState.db,
}))

vi.mock('../globalApi.svelte', () => ({
    fetchNative: vi.fn(),
}))

vi.mock('../process/request/nanogpt', () => ({
    fetchNanoGPTModels: mocks.fetchNanoGPTModels,
}))

vi.mock('../process/request/vercel', () => ({
    fetchVercelModels: mocks.fetchVercelModels,
}))

describe('registerNanoGPTModelsDynamic', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    test('does not mark synced NanoGPT models as image-capable without vision metadata', async () => {
        mocks.fetchNanoGPTModels.mockResolvedValue({
            models: [
                {
                    id: 'custom/text-only-model',
                    name: 'Text Only Model',
                    ownedBy: 'Custom',
                },
            ],
        })

        const { LLMFlags, LLMModels, registerNanoGPTModelsDynamic } = await import('./modellist')

        for (let i = LLMModels.length - 1; i >= 0; i--) {
            if (LLMModels[i].id.startsWith('dynamic_nanogpt_')) {
                LLMModels.splice(i, 1)
            }
        }

        await registerNanoGPTModelsDynamic()

        const syncedModel = LLMModels.find((model) => model.id === 'dynamic_nanogpt_custom/text-only-model')

        expect(syncedModel).toBeDefined()
        expect(syncedModel?.flags.includes(LLMFlags.hasImageInput)).toBe(false)
    })

    test('registers Vercel AI Gateway models dynamically', async () => {
        mocks.fetchVercelModels.mockResolvedValue({
            models: [
                {
                    id: 'openai/gpt-5.4',
                    name: 'GPT-5.4',
                    type: 'language',
                    contextWindow: 400000,
                    maxTokens: 128000,
                    supportsVision: true,
                    supportsReasoning: true,
                },
            ],
        })

        const { LLMFlags, LLMProvider, LLMModels, registerVercelModelsDynamic } = await import('./modellist')

        for (let i = LLMModels.length - 1; i >= 0; i--) {
            if (LLMModels[i].id.startsWith('dynamic_vercel_')) {
                LLMModels.splice(i, 1)
            }
        }

        await registerVercelModelsDynamic()

        const syncedModel = LLMModels.find((model) => model.id === 'dynamic_vercel_openai/gpt-5.4')

        expect(syncedModel?.provider).toBe(LLMProvider.Vercel)
        expect(syncedModel?.internalID).toBe('openai/gpt-5.4')
        expect(syncedModel?.flags.includes(LLMFlags.hasImageInput)).toBe(true)
    })

    test('exposes reasoning controls for the custom Vercel Gateway entry', async () => {
        const { LLMModels } = await import('./modellist')

        const model = LLMModels.find((model) => model.id === 'vercel')

        expect(model?.parameters).toContain('reasoning_effort')
        expect(model?.parameters).toContain('verbosity')
    })
})

describe('static DeepSeek models', () => {
    test('registers official DeepSeek V4 Flash and Pro as OpenAI-compatible models', async () => {
        const { LLMFlags, LLMFormat, LLMModels, LLMProvider, LLMTokenizer } = await import('./modellist')

        const flash = LLMModels.find((model) => model.id === 'deepseek-v4-flash')
        const pro = LLMModels.find((model) => model.id === 'deepseek-v4-pro')

        for (const model of [flash, pro]) {
            expect(model).toMatchObject({
                provider: LLMProvider.DeepSeek,
                format: LLMFormat.OpenAICompatible,
                tokenizer: LLMTokenizer.DeepSeek,
                endpoint: 'https://api.deepseek.com/chat/completions',
                keyIdentifier: 'deepseek',
                recommended: true,
            })
            expect(model?.parameters).toContain('reasoning_effort')
            expect(model?.flags).toContain(LLMFlags.hasStreaming)
            expect(model?.flags).toContain(LLMFlags.deepSeekThinkingInput)
        }
    })
})
