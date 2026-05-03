import { describe, expect, test, vi } from 'vitest'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from 'src/ts/model/types'

const mocks = vi.hoisted(() => ({
    getDatabase: vi.fn(() => ({
        google: {
            accessToken: 'test-key',
            projectId: '',
        },
        vertexRegion: 'us-central1',
        vertexAccessTokenExpires: 0,
        gptVisionQuality: 'low',
        jsonSchemaEnabled: false,
        saveSignatures: false,
        temperature: 80,
        top_p: 1,
        top_k: 0,
        frequencyPenalty: 70,
        PresensePenalty: 70,
        thinkingTokens: 4096,
        seperateParametersEnabled: false,
        customModels: [],
    })),
    setDatabase: vi.fn(),
    fetchNative: vi.fn(),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: mocks.getDatabase,
    setDatabase: mocks.setDatabase,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: mocks.fetchNative,
    textifyReadableStream: vi.fn(),
    addFetchLog: vi.fn(),
}))

vi.mock('src/ts/alert', () => ({
    notifyError: vi.fn(),
}))

vi.mock('../files/inlays', () => ({
    saveInlayedSignature: vi.fn(),
    setInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}))

vi.mock('../mcp/mcp', () => ({
    callTool: vi.fn(),
    decodeToolCall: vi.fn(),
    encodeToolCall: vi.fn(),
}))

vi.mock('src/ts/stores.svelte', () => ({
    bodyIntercepterStore: {
        get: vi.fn(() => []),
    },
    selIdState: {
        selId: null,
    },
    DBState: {
        db: {
            characters: [],
        },
    },
}))

describe('requestGoogleCloudVertex Gemini thinking config', () => {
    test('serializes Gemini 3.1 thinking tokens as thinkingLevel in standard generationConfig', async () => {
        const { requestGoogleCloudVertex } = await import('./google')

        const result = await requestGoogleCloudVertex({
            formated: [{ role: 'user', content: 'hello' }],
            maxTokens: 512,
            mode: 'model',
            useStreaming: false,
            customURL: 'https://example.test/v1beta/',
            previewBody: true,
            modelInfo: {
                id: 'gemini-3.1-pro-preview',
                internalID: 'gemini-3.1-pro-preview',
                name: 'Gemini Pro 3.1 Preview',
                provider: LLMProvider.GoogleCloud,
                format: LLMFormat.GoogleCloud,
                flags: [
                    LLMFlags.geminiThinking,
                    LLMFlags.hasStreaming,
                    LLMFlags.requiresAlternateRole,
                ],
                parameters: ['thinking_tokens', 'temperature', 'top_p', 'top_k'],
                tokenizer: LLMTokenizer.GoogleCloud,
            },
        } as any)

        if (result.type !== 'success' || typeof result.result !== 'string') {
            throw new Error(`Expected preview JSON, got ${result.type}`)
        }
        const parsed = JSON.parse(result.result)
        expect(parsed.body.generationConfig.thinkingConfig).toEqual({
            thinkingLevel: 'MEDIUM',
            includeThoughts: true,
        })
        expect(parsed.body.generationConfig.thinkingBudget).toBeUndefined()
        expect(parsed.body.generation_config).toBeUndefined()
    })
})
