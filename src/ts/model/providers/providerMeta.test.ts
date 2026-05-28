import { describe, expect, test } from 'vitest'

import { AnthropicModels } from './anthropic'
import { CopilotModels } from './copilot'
import { GoogleModels } from './google'
import { NanoGPTModels } from './nanogpt'
import { OpenAIModels } from './openai'
import { LLMFlags, LLMFormat, LLMTokenizer } from '../types'

describe('provider model metadata', () => {
    test('registers Claude Opus 4.8 as adaptive-only for Anthropic and Copilot', () => {
        const anthropicOpus48 = AnthropicModels.find((model) => model.id === 'claude-opus-4-8')
        const copilotOpus48 = CopilotModels.find((model) => model.id === 'copilot-claude-opus-4.8')

        expect(anthropicOpus48).toMatchObject({
            name: 'Claude 4.8 Opus',
            shortName: '4.8 Opus',
            format: LLMFormat.Anthropic,
            tokenizer: LLMTokenizer.Claude,
            recommended: true,
            parameters: [],
        })
        expect(anthropicOpus48?.flags).toContain(LLMFlags.claudeAdaptiveThinking)
        expect(anthropicOpus48?.flags).toContain(LLMFlags.claudeNoSamplingParams)
        expect(anthropicOpus48?.flags).not.toContain(LLMFlags.claudeThinking)

        expect(copilotOpus48).toMatchObject({
            name: 'Claude 4.8 Opus',
            internalID: 'claude-opus-4.8',
            shortName: 'GH Copilot Opus 4.8',
            format: LLMFormat.Anthropic,
            tokenizer: LLMTokenizer.Claude,
            recommended: true,
            parameters: [],
        })
        expect(copilotOpus48?.flags).toContain(LLMFlags.claudeAdaptiveThinking)
        expect(copilotOpus48?.flags).toContain(LLMFlags.claudeNoSamplingParams)
        expect(copilotOpus48?.flags).not.toContain(LLMFlags.claudeThinking)
    })

    test('marks requested Copilot models as recommended', () => {
        const recommendedIds = new Set(
            CopilotModels.filter((model) => model.recommended).map((model) => model.id)
        )

        expect(recommendedIds.has('copilot-gpt-5.5')).toBe(true)
        expect(recommendedIds.has('copilot-gpt-5.5-pro')).toBe(true)
        expect(recommendedIds.has('copilot-gpt-5.1')).toBe(true)
        expect(recommendedIds.has('copilot-gemini-3-flash-preview')).toBe(true)
        expect(recommendedIds.has('copilot-gemini-3.1-pro-preview')).toBe(true)
    })

    test('registers Gemini 3.5 Flash for Google provider', () => {
        const model = GoogleModels.find((model) => model.id === 'gemini-3.5-flash')

        expect(model).toMatchObject({
            name: 'Gemini Flash 3.5',
            internalID: 'gemini-3.5-flash',
            format: LLMFormat.GoogleCloud,
            tokenizer: LLMTokenizer.GoogleCloud,
            recommended: true,
        })
        expect(model?.parameters).toContain('thinking_tokens')
        expect(model?.flags).toContain(LLMFlags.hasStreaming)
        expect(model?.flags).toContain(LLMFlags.geminiThinking)
        expect(model?.flags).toContain(LLMFlags.hasImageInput)
    })

    test('registers upcoming OpenAI GPT-5.5 aliases', () => {
        const modelMap = new Map(OpenAIModels.map((model) => [model.id, model]))

        expect(modelMap.get('gpt-5.5')?.internalID).toBe('gpt-5.5')
        expect(modelMap.get('gpt-5.5-pro')?.internalID).toBe('gpt-5.5-pro')
        expect(modelMap.get('gpt-5.5')?.recommended).toBe(true)
    })

    test('routes OpenAI GPT-5.5 models through the responses API', () => {
        const modelMap = new Map(OpenAIModels.map((model) => [model.id, model]))

        expect(modelMap.get('gpt-5.5')?.format).toBe(LLMFormat.OpenAIResponseAPI)
        expect(modelMap.get('gpt-5.5-pro')?.format).toBe(LLMFormat.OpenAIResponseAPI)
    })

    test('registers upcoming Copilot GPT-5.5 aliases', () => {
        const modelMap = new Map(CopilotModels.map((model) => [model.id, model]))

        expect(modelMap.get('copilot-gpt-5.5')?.internalID).toBe('gpt-5.5')
        expect(modelMap.get('copilot-gpt-5.5-pro')?.internalID).toBe('gpt-5.5-pro')
    })

    test('routes Copilot GPT-5.5 models through the responses API', () => {
        const modelMap = new Map(CopilotModels.map((model) => [model.id, model]))

        expect(modelMap.get('copilot-gpt-5.5')?.format).toBe(LLMFormat.OpenAIResponseAPI)
        expect(modelMap.get('copilot-gpt-5.5-pro')?.format).toBe(LLMFormat.OpenAIResponseAPI)
    })

    test('keeps static Copilot GPT-5.4 on chat completions format', () => {
        const gpt54 = CopilotModels.find((model) => model.id === 'copilot-gpt-5.4')

        expect(gpt54?.format).toBe(LLMFormat.OpenAICompatible)
    })

    test('marks static Copilot GPT-5 models to use completion-token field', () => {
        const gpt5Ids = [
            'copilot-gpt-5.5',
            'copilot-gpt-5.5-pro',
            'copilot-gpt-5.4',
            'copilot-gpt-5.2',
            'copilot-gpt-5.1',
            'copilot-gpt-5-mini',
        ]

        for (const id of gpt5Ids) {
            const model = CopilotModels.find((entry) => entry.id === id)
            expect(model?.flags.includes(LLMFlags.OAICompletionTokens)).toBe(true)
        }
    })

    test('keeps NanoGPT models OpenAI-compatible with o200 tokenizer', () => {
        for (const model of NanoGPTModels) {
            expect(model.format).toBe(LLMFormat.OpenAICompatible)
            expect(model.tokenizer).toBe(LLMTokenizer.tiktokenO200Base)
        }
    })

    test('includes requested NanoGPT GLM recommendations', () => {
        const modelMap = new Map(NanoGPTModels.map((model) => [model.id, model]))

        expect(modelMap.get('nanogpt-zai-org/glm-5.1')?.recommended).toBe(true)
        expect(modelMap.get('nanogpt-zai-org/glm-5.1:thinking')?.recommended).toBe(true)
    })
})
