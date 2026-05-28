import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getDatabase: vi.fn(() => ({
        reasoningEffort: 2,
        seperateParametersEnabled: false,
    })),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: mocks.getDatabase,
}))

describe('request shared parameter helpers', () => {
    test('reads global reasoning effort when separate parameters are disabled', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: -1,
            seperateParametersEnabled: false,
        })
        const { getReasoningEffortParameterValue } = await import('./shared')

        expect(getReasoningEffortParameterValue('model', { modelId: 'deepseek-v4-pro' })).toBe(-1)
    })

    test('reads model override reasoning effort when separate parameters by model are enabled', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: 0,
            seperateParametersEnabled: true,
            seperateParametersByModel: true,
            seperateParameters: {
                overrides: {
                    'deepseek-v4-pro': {
                        reasoning_effort: 3,
                    },
                },
            },
        } as any)
        const { getReasoningEffortParameterValue } = await import('./shared')

        expect(getReasoningEffortParameterValue('model', { modelId: 'deepseek-v4-pro' })).toBe(3)
    })

    test('maps reasoning effort to a nested response API reasoning effort field', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: 2,
            seperateParametersEnabled: false,
        })
        const { applyParameters } = await import('./shared')

        const body = applyParameters(
            {},
            ['reasoning_effort'],
            { reasoning_effort: 'reasoning.effort' },
            'model',
            { modelId: 'gpt-5.5' },
        )

        expect(body).toEqual({
            reasoning: {
                effort: 'high',
            },
        })
    })

    test('preserves xhigh reasoning effort for response API nested fields', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: 3,
            seperateParametersEnabled: false,
        })
        const { applyParameters } = await import('./shared')

        const body = applyParameters(
            {},
            ['reasoning_effort'],
            { reasoning_effort: 'reasoning.effort' },
            'model',
            { modelId: 'copilot-gpt-5.5' },
        )

        expect(body).toEqual({
            reasoning: {
                effort: 'xhigh',
            },
        })
    })

    test('passes none as the nested response API reasoning effort by default', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: -1,
            seperateParametersEnabled: false,
        })
        const { applyParameters } = await import('./shared')

        const body = applyParameters(
            {},
            ['reasoning_effort'],
            { reasoning_effort: 'reasoning.effort' },
            'model',
            { modelId: 'gpt-5.5' },
        )

        expect(body).toEqual({
            reasoning: {
                effort: 'none',
            },
        })
    })

    test('omits nested response API reasoning effort none when requested', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: -1,
            seperateParametersEnabled: false,
        })
        const { applyParameters } = await import('./shared')

        const body = applyParameters(
            {},
            ['reasoning_effort'],
            { reasoning_effort: 'reasoning.effort' },
            'model',
            { modelId: 'copilot-gpt-5.5', omitNoneReasoningEffort: true },
        )

        expect(body).toEqual({})
    })

    test('passes none as top-level OpenAI-compatible reasoning effort by default', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: -1,
            seperateParametersEnabled: false,
        })
        const { applyParameters } = await import('./shared')

        const body = applyParameters(
            {},
            ['reasoning_effort'],
            {},
            'model',
            { modelId: 'gpt-5.5' },
        )

        expect(body).toEqual({
            reasoning_effort: 'none',
        })
    })

    test('omits top-level OpenAI-compatible reasoning effort none when requested', async () => {
        mocks.getDatabase.mockReturnValue({
            reasoningEffort: -1,
            seperateParametersEnabled: false,
        })
        const { applyParameters } = await import('./shared')

        const body = applyParameters(
            {},
            ['reasoning_effort'],
            {},
            'model',
            { modelId: 'copilot-gpt-5.5', omitNoneReasoningEffort: true },
        )

        expect(body).toEqual({})
    })
})
