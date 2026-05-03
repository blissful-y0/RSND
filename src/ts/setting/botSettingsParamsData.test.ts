import { describe, expect, test } from 'vitest'
import { LLMFlags } from '../model/types'
import { modelSpecificParameterItems } from './botSettingsParamsData'

describe('botSettingsParamsData reasoning/verbosity controls', () => {
    test('uses segmented button controls for reasoning effort and verbosity', () => {
        const reasoningEffort = modelSpecificParameterItems.find(
            (item) => item.id === 'params.reasoningEffort',
        )
        const verbosity = modelSpecificParameterItems.find(
            (item) => item.id === 'params.verbosity',
        )

        expect(reasoningEffort?.type).toBe('segmented')
        expect(reasoningEffort?.options?.segmentOptions?.map((option) => option.value)).toEqual([
            'none',
            'low',
            'medium',
            'high',
            'xhigh',
        ])
        expect(reasoningEffort?.options?.segmentWrap).toBe(true)
        expect(reasoningEffort?.options?.segmentFullWidth).toBe(true)

        expect(verbosity?.type).toBe('segmented')
        expect(verbosity?.options?.segmentOptions?.map((option) => option.value)).toEqual([
            'low',
            'medium',
            'high',
        ])
        expect(verbosity?.options?.segmentFullWidth).toBe(true)
    })

    test('shows thinking token control for Gemini thinking models without Claude thinking type', () => {
        const thinkingTokens = modelSpecificParameterItems.find(
            (item) => item.id === 'params.thinkingTokens',
        )

        expect(thinkingTokens?.condition?.({
            db: {
                thinkingType: 'off',
            },
            modelInfo: {
                flags: [LLMFlags.geminiThinking],
                parameters: ['thinking_tokens'],
            },
            subModelInfo: {
                flags: [],
                parameters: [],
            },
        } as any)).toBe(true)
    })
})
