import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getDatabase: vi.fn(() => ({
        openAIKey: '',
        modelTools: [],
        autofillRequestUrl: false,
        usePlainFetch: false,
        localNetworkMode: false,
        localNetworkTimeoutSec: 600,
        newOAIHandle: true,
        gptVisionQuality: 'low',
        generationSeed: -1,
        jsonSchemaEnabled: false,
        OAIPrediction: '',
        vercelServiceTier: 'flex',
        vercelPromptCacheRetention: '24h',
        vercelGatewayCaching: true,
    })),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    textifyReadableStream: vi.fn(async () => ''),
    applyParameters: vi.fn((data: Record<string, any>) => data),
}))

vi.mock('src/lang', () => ({
    language: {
        errors: {
            httpError: 'HTTP Error: ',
        },
    },
}))

vi.mock('src/ts/alert', () => ({
    alertError: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: mocks.getDatabase,
    getCurrentCharacter: vi.fn(() => null),
    getCurrentChat: vi.fn(() => []),
}))

vi.mock('src/ts/model/modellist', () => ({
    LLMFlags: {
        deepSeekPrefix: 'deepSeekPrefix',
        deepSeekThinkingInput: 'deepSeekThinkingInput',
        OAICompletionTokens: 'OAICompletionTokens',
        DeveloperRole: 'DeveloperRole',
    },
    LLMFormat: {
        Mistral: 'mistral',
    },
    LLMProvider: {
        Vercel: 'vercel',
    },
}))

vi.mock('src/ts/model/openrouter', () => ({
    getFreeOpenRouterModels: vi.fn(),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    addFetchLog: vi.fn(),
    fetchNative: mocks.fetchNative,
    globalFetch: mocks.globalFetch,
    textifyReadableStream: mocks.textifyReadableStream,
}))

vi.mock('src/ts/network/localNetwork', () => ({
    isLocalNetworkUrl: vi.fn(() => false),
}))

vi.mock('../../templates/jsonSchema', () => ({
    extractJSON: vi.fn(),
    getOpenAIJSONSchema: vi.fn(),
}))

vi.mock('../../templates/chatTemplate', () => ({
    applyChatTemplate: vi.fn(),
}))

vi.mock('../../files/inlays', () => ({
    supportsInlayImage: vi.fn(),
}))

vi.mock('../../mcp/mcp', () => ({
    callTool: vi.fn(),
    decodeToolCall: vi.fn(),
    encodeToolCall: vi.fn(),
}))

vi.mock('../shared', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../shared')>()
    return {
        ...actual,
        applyParameters: mocks.applyParameters,
    }
})

describe('Vercel AI Gateway request options', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    test('adds flex service tier and 24h prompt cache retention to Vercel OpenAI-compatible requests', async () => {
        const { requestOpenAI } = await import('./requests')

        const response = await requestOpenAI({
            aiModel: 'vercel',
            formated: [{ role: 'user', content: 'hello' }],
            bias: {},
            biasString: [],
            maxTokens: 256,
            mode: 'model',
            previewBody: true,
            useStreaming: false,
            modelInfo: {
                id: 'vercel',
                internalID: 'openai/gpt-5',
                provider: 'vercel',
                flags: [],
                parameters: ['temperature', 'top_p', 'reasoning_effort', 'verbosity'],
            },
        } as any)

        expect(response.type).toBe('success')
        const preview = JSON.parse(response.result as string)

        expect(preview.body).toMatchObject({
            service_tier: 'flex',
            prompt_cache_retention: '24h',
            providerOptions: {
                gateway: {
                    caching: 'auto',
                },
            },
        })
    })
})
