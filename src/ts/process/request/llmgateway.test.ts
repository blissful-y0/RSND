import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    requestOpenAI: vi.fn(async () => ({ type: 'success', result: 'ok' })),
    requestClaude: vi.fn(async () => ({ type: 'success', result: 'ok' })),
    fetchNative: vi.fn(),
    getDatabase: vi.fn(),
}))

mocks.getDatabase.mockImplementation(() => ({
    llmGatewayKey: 'llmgtwy_test',
    llmGatewayRequestModel: 'gpt-5.5',
    llmGatewayRequestModelName: 'GPT-5.5',
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: mocks.getDatabase,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    fetchNative: mocks.fetchNative,
}))

vi.mock('./openAI/requests', () => ({
    requestOpenAI: mocks.requestOpenAI,
}))

vi.mock('./anthropic', () => ({
    requestClaude: mocks.requestClaude,
}))

vi.mock('src/ts/model/types', () => ({
    LLMFormat: {
        OpenAICompatible: 'openai-compatible',
        Anthropic: 'anthropic',
    },
    LLMProvider: {
        LLMGateway: 19,
    },
}))

const firstArg = (fn: any): any => (fn.mock.calls[0] as any[])[0]
const SES_REGEX = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.fetchNative.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
    })
})

describe('LLM Gateway DevPass request routing', () => {
    test('OpenAI-compatible requests use DevPass key and OpenCode-style session headers without source metadata', async () => {
        const { requestLLMGateway } = await import('./llmgateway')

        await requestLLMGateway({
            chatId: 'chat-A',
            formated: [{ role: 'user', content: 'hello' }],
            modelInfo: { id: 'llmgateway', internalID: '', format: 'openai-compatible', provider: 19 },
        } as any)

        expect(mocks.requestOpenAI).toHaveBeenCalledTimes(1)
        const call = firstArg(mocks.requestOpenAI)
        expect(call).toMatchObject({
            customURL: 'https://api.llmgateway.io/v1/chat/completions',
            key: 'llmgtwy_test',
            proxyPolicy: 'always',
        })
        expect(call.modelInfo.internalID).toBe('gpt-5.5')
        expect(call.extraHeaders).toMatchObject({
            Authorization: 'Bearer llmgtwy_test',
            'Content-Type': 'application/json',
            'Openai-Intent': 'conversation-edits',
            'x-initiator': 'user',
        })
        expect(call.extraHeaders['User-Agent']).toMatch(/^opencode\/[\d.]+/)
        expect(call.extraHeaders['x-session-affinity']).toMatch(SES_REGEX)
        expect(call.extraHeaders['x-parent-session-id']).toBeUndefined()
        expect(call.extraHeaders['X-Source']).toBeUndefined()
        expect(call.extraHeaders['X-LLMGateway-Source']).toBeUndefined()
        expect(call.extraHeaders['anthropic-beta']).toBeUndefined()

        mocks.requestOpenAI.mockClear()
        await requestLLMGateway({
            chatId: 'chat-A',
            formated: [{ role: 'user', content: 'again' }],
            modelInfo: { id: 'llmgateway', internalID: '', format: 'openai-compatible', provider: 19 },
        } as any)

        expect(firstArg(mocks.requestOpenAI).extraHeaders['x-session-affinity']).toBe(call.extraHeaders['x-session-affinity'])
    })

    test('agent calls use a child session and parent the chat session', async () => {
        const { requestLLMGateway } = await import('./llmgateway')

        await requestLLMGateway({
            chatId: 'chat-A',
            formated: [{ role: 'user', content: 'hello' }],
            modelInfo: { id: 'llmgateway', internalID: '', format: 'openai-compatible', provider: 19 },
        } as any)
        const chatSession = firstArg(mocks.requestOpenAI).extraHeaders['x-session-affinity']

        mocks.requestOpenAI.mockClear()
        await requestLLMGateway({
            chatId: 'chat-A',
            mode: 'translate',
            formated: [{ role: 'user', content: 'translate' }],
            modelInfo: { id: 'llmgateway', internalID: '', format: 'openai-compatible', provider: 19 },
        } as any)

        const headers = firstArg(mocks.requestOpenAI).extraHeaders
        expect(headers['x-initiator']).toBe('agent')
        expect(headers['x-parent-session-id']).toBe(chatSession)
        expect(headers['x-session-affinity']).toMatch(SES_REGEX)
        expect(headers['x-session-affinity']).not.toBe(chatSession)
    })

    test('Anthropic requests use the LLM Gateway messages endpoint without anthropic beta headers', async () => {
        const { requestLLMGateway } = await import('./llmgateway')

        await requestLLMGateway({
            chatId: 'chat-A',
            formated: [{ role: 'user', content: 'hello' }],
            modelInfo: { id: 'llmgateway-claude-opus-4.7', internalID: 'claude-opus-4-7', format: 'anthropic', provider: 19 },
        } as any)

        expect(mocks.requestClaude).toHaveBeenCalledTimes(1)
        const call = firstArg(mocks.requestClaude)
        expect(call).toMatchObject({
            customURL: 'https://api.llmgateway.io/v1/messages',
            key: 'llmgtwy_test',
            proxyPolicy: 'always',
        })
        expect(call.extraHeaders).toMatchObject({
            Authorization: 'Bearer llmgtwy_test',
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'Openai-Intent': 'conversation-edits',
        })
        expect(call.extraHeaders['anthropic-beta']).toBeUndefined()
        expect(call.extraHeaders['X-Source']).toBeUndefined()
        expect(call.extraHeaders['X-LLMGateway-Source']).toBeUndefined()
    })
})

describe('LLM Gateway model probing', () => {
    test('fetches models with the DevPass bearer token', async () => {
        const { fetchLLMGatewayModels } = await import('./llmgateway')

        mocks.fetchNative.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                data: [
                    {
                        id: 'gpt-5.5',
                        name: 'GPT-5.5',
                        context_length: 1100000,
                        providers: [{ providerId: 'openai', tools: true, vision: true, reasoning: true }],
                        pricing: { prompt: '5', completion: '30' },
                    },
                ],
            }),
        })

        const result = await fetchLLMGatewayModels('llmgtwy_test')

        expect(mocks.fetchNative).toHaveBeenCalledWith(
            'https://api.llmgateway.io/v1/models',
            expect.objectContaining({
                method: 'GET',
                headers: {
                    Authorization: 'Bearer llmgtwy_test',
                    Accept: 'application/json',
                    'User-Agent': expect.stringMatching(/^opencode\/[\d.]+$/),
                },
                proxyPolicy: 'always',
            }),
        )
        expect(result.models).toEqual([
            expect.objectContaining({
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                contextWindow: 1100000,
                supportsVision: true,
                supportsTools: true,
                supportsReasoning: true,
                promptPrice1M: 5,
                completionPrice1M: 30,
            }),
        ])
    })
})
