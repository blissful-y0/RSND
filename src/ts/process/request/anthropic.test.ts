import { describe, expect, test, vi } from 'vitest'
import { LLMFormat, LLMProvider } from 'src/ts/model/types'

const mocks = vi.hoisted(() => ({
    getDatabase: vi.fn(() => ({
        claudeAPIKey: 'claude-key',
        proxyKey: '',
        usePlainFetch: false,
        autofillRequestUrl: false,
        seperateParametersEnabled: false,
        customModels: [],
        claude1HourCaching: false,
        claudeBatching: false,
        jsonSchemaEnabled: false,
        extractJson: '',
        thinkingType: 'off',
    })),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: mocks.getDatabase,
    getCurrentCharacter: vi.fn(() => null),
    getCurrentChat: vi.fn(() => []),
}))

vi.mock('src/ts/stores.svelte', () => ({
    DBState: {
        db: {
            characters: [],
            modules: [],
        },
    },
    selIdState: {
        selId: null,
    },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    textifyReadableStream: vi.fn(),
}))

vi.mock('src/ts/observer.svelte', () => ({
    registerClaudeObserver: vi.fn(),
}))

vi.mock('../mcp/mcp', () => ({
    callTool: vi.fn(),
    decodeToolCall: vi.fn(),
    encodeToolCall: vi.fn(),
}))

describe('requestClaude Copilot headers', () => {
    test('preserves Copilot Anthropic beta header for high max token requests', async () => {
        const { requestClaude } = await import('./anthropic')

        const result = await requestClaude({
            formated: [{ role: 'user', content: 'hello' }],
            maxTokens: 9000,
            mode: 'model',
            useStreaming: false,
            customURL: 'https://api.githubcopilot.com/v1/messages',
            key: 'ghp_test',
            previewBody: true,
            extraHeaders: {
                'Authorization': 'Bearer ghp_test',
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'interleaved-thinking-2025-05-14',
                'User-Agent': 'opencode/1.14.20',
            },
            modelInfo: {
                id: 'copilot-claude-sonnet-4.6',
                internalID: 'claude-sonnet-4.6',
                provider: LLMProvider.Copilot,
                format: LLMFormat.Anthropic,
                flags: [],
                parameters: [],
            },
        } as any)

        if (result.type !== 'success' || typeof result.result !== 'string') {
            throw new Error(`Expected preview JSON, got ${result.type}`)
        }

        const parsed = JSON.parse(result.result)
        expect(parsed.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14')
        expect(parsed.headers['anthropic-beta']).not.toContain('output-128k-2025-02-19')
    })
})

describe('requestClaude LLM Gateway headers', () => {
    test('uses DevPass bearer headers without Anthropic beta or x-api-key', async () => {
        const { requestClaude } = await import('./anthropic')

        const result = await requestClaude({
            formated: [{ role: 'user', content: 'hello' }],
            maxTokens: 9000,
            mode: 'model',
            useStreaming: false,
            customURL: 'https://api.llmgateway.io/v1/messages',
            key: 'llmgtwy_test',
            previewBody: true,
            extraHeaders: {
                Authorization: 'Bearer llmgtwy_test',
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'User-Agent': 'opencode/1.14.20',
                'Openai-Intent': 'conversation-edits',
                'x-initiator': 'user',
                'x-session-affinity': 'ses_000000000000ABCDEFGHIJKLMN',
            },
            modelInfo: {
                id: 'llmgateway-claude-opus-4.7',
                internalID: 'claude-opus-4-7',
                provider: 19,
                format: LLMFormat.Anthropic,
                flags: [],
                parameters: [],
            },
        } as any)

        if (result.type !== 'success' || typeof result.result !== 'string') {
            throw new Error(`Expected preview JSON, got ${result.type}`)
        }

        const parsed = JSON.parse(result.result)
        expect(parsed.headers.Authorization).toBe('Bearer llmgtwy_test')
        expect(parsed.headers['x-api-key']).toBeUndefined()
        expect(parsed.headers['anthropic-beta']).toBeUndefined()
        expect(parsed.headers['x-session-affinity']).toBe('ses_000000000000ABCDEFGHIJKLMN')
    })
})
