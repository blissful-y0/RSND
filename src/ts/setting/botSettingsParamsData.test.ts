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

    test('shows Gemini thinking level control for Gemini 3 models', () => {
        const geminiThinkingLevel = modelSpecificParameterItems.find(
            (item) => item.id === 'params.geminiThinkingLevel',
        )

        expect(geminiThinkingLevel?.condition?.({
            db: {},
            modelInfo: {
                id: 'gemini-3.1-pro-preview',
                internalID: 'gemini-3.1-pro-preview',
                flags: [LLMFlags.geminiThinking],
                parameters: ['thinking_tokens'],
            },
            subModelInfo: {
                flags: [],
                parameters: [],
            },
        } as any)).toBe(true)
        expect(geminiThinkingLevel?.options?.segmentOptions?.map((option) => option.value)).toContain('medium')
    })

    test('limits Gemini thinking level options by model support', () => {
        const geminiThinkingLevel = modelSpecificParameterItems.find(
            (item) => item.id === 'params.geminiThinkingLevel',
        )

        const minimal = geminiThinkingLevel?.options?.segmentOptions?.find((option) => option.value === 'minimal')
        expect(minimal?.condition?.({
            db: {},
            modelInfo: {
                id: 'gemini-3-flash-preview',
                internalID: 'gemini-3-flash-preview',
                flags: [LLMFlags.geminiThinking],
                parameters: ['thinking_tokens'],
            },
            subModelInfo: {
                flags: [],
                parameters: [],
            },
        } as any)).toBe(true)
        expect(minimal?.condition?.({
            db: {},
            modelInfo: {
                id: 'gemini-3.5-flash',
                internalID: 'gemini-3.5-flash',
                flags: [LLMFlags.geminiThinking],
                parameters: ['thinking_tokens'],
            },
            subModelInfo: {
                flags: [],
                parameters: [],
            },
        } as any)).toBe(true)

        const medium = geminiThinkingLevel?.options?.segmentOptions?.find((option) => option.value === 'medium')
        expect(medium?.condition?.({
            db: {},
            modelInfo: {
                id: 'gemini-3.5-flash',
                internalID: 'gemini-3.5-flash',
                flags: [LLMFlags.geminiThinking],
                parameters: ['thinking_tokens'],
            },
            subModelInfo: {
                flags: [],
                parameters: [],
            },
        } as any)).toBe(true)
    })

    test('shows low as the default Gemini thinking level when tokens are unset', () => {
        const geminiThinkingLevel = modelSpecificParameterItems.find(
            (item) => item.id === 'params.geminiThinkingLevel',
        )

        expect(geminiThinkingLevel?.getValue?.({} as any, {
            db: {},
            modelInfo: {
                id: 'gemini-3.5-flash-preview',
                internalID: 'gemini-3.5-flash-preview',
                flags: [LLMFlags.geminiThinking],
                parameters: ['thinking_tokens'],
            },
            subModelInfo: {
                flags: [],
                parameters: [],
            },
        } as any)).toBe('low')
    })
})
