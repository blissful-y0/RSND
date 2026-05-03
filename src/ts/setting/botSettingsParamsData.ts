/**
 * Bot Settings - Parameters Tab Data
 *
 * Data-driven definition for BotSettings Parameters tab (submenu === 1).
 * Contains standard parameter settings like context size, temperature, etc.
 */

import type { SettingItem } from './types';
import { LLMFlags } from '../model/types';
import {
    dbReasoningEffortToUi,
    dbVerbosityToUi,
    reasoningEffortSelectOptions,
    uiReasoningEffortToDb,
    uiVerbosityToDb,
    verbositySelectOptions,
} from '../model/reasoningVerbosity';

type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

function getModelId(ctx: { modelInfo: { id?: string; internalID?: string } }): string {
    return ctx.modelInfo.internalID ?? ctx.modelInfo.id ?? '';
}

function isGeminiThinkingLevelModel(ctx: { modelInfo: { id?: string; internalID?: string; flags: LLMFlags[] } }): boolean {
    return ctx.modelInfo.flags.includes(LLMFlags.geminiThinking) && /^gemini-3(?:[.-]|$)/.test(getModelId(ctx));
}

function supportsGeminiMinimalThinking(ctx: { modelInfo: { id?: string; internalID?: string } }): boolean {
    return getModelId(ctx) === 'gemini-3-flash-preview';
}

function supportsGeminiMediumThinking(ctx: { modelInfo: { id?: string; internalID?: string } }): boolean {
    const modelId = getModelId(ctx);
    return modelId === 'gemini-3-flash-preview' || modelId.startsWith('gemini-3.1-');
}

function geminiThinkingTokensToLevel(tokens: number | null | undefined, ctx: { modelInfo: { id?: string; internalID?: string } }): GeminiThinkingLevel {
    const budget = typeof tokens === 'number' ? tokens : 16384;
    if (supportsGeminiMinimalThinking(ctx) && budget <= 0) return 'minimal';
    if (budget >= 16384) return 'high';
    if (supportsGeminiMediumThinking(ctx) && budget >= 4096) return 'medium';
    return 'low';
}

function geminiThinkingLevelToTokens(level: GeminiThinkingLevel): number {
    switch (level) {
        case 'minimal':
            return 0;
        case 'low':
            return 1024;
        case 'medium':
            return 4096;
        case 'high':
            return 16384;
    }
}

/**
 * Basic parameter settings that are always visible
 */
export const basicParameterItems: SettingItem[] = [
    {
        id: 'params.maxContext',
        type: 'number',
        labelKey: 'maxContextSize',
        helpKey: 'maxContextSize',
        bindKey: 'maxContext',
        options: { min: 0 },
        keywords: ['context', 'size', 'token', 'limit'],
    },
    {
        id: 'params.maxResponse',
        type: 'number',
        labelKey: 'maxResponseSize',
        helpKey: 'maxResponseSize',
        bindKey: 'maxResponse',
        options: { min: 0, max: 2048 },
        keywords: ['response', 'size', 'output', 'length'],
    },
];

/**
 * Seed setting - only for certain models
 */
export const seedSetting: SettingItem = {
    id: 'params.seed',
    type: 'number',
    labelKey: 'seed',
    helpKey: 'seed',
    bindKey: 'generationSeed',
    condition: (ctx) =>
        ctx.db.aiModel.startsWith('gpt') ||
        ctx.db.aiModel === 'reverse_proxy' ||
        ctx.db.aiModel === 'openrouter',
    keywords: ['seed', 'random', 'deterministic'],
};

/**
 * Temperature and common sampling parameters
 */
export const samplingParameterItems: SettingItem[] = [
    {
        id: 'params.temperature',
        type: 'slider',
        labelKey: 'temperature',
        helpKey: 'tempature',
        bindKey: 'temperature',
        options: {
            min: 0,
            max: 200,
            multiple: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ['temperature', 'creativity', 'randomness'],
    },
];

/**
 * OpenAI-style penalty parameters
 * These are conditionally shown based on modelInfo.parameters
 */
export const penaltyParameterItems: SettingItem[] = [
    {
        id: 'params.frequencyPenalty',
        type: 'slider',
        labelKey: 'frequencyPenalty',
        helpKey: 'frequencyPenalty',
        bindKey: 'frequencyPenalty',
        condition: (ctx) => ctx.modelInfo.parameters.includes('frequency_penalty'),
        options: {
            min: 0,
            max: 200,
            multiple: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ['frequency', 'penalty', 'repetition'],
    },
    {
        id: 'params.presencePenalty',
        type: 'slider',
        labelKey: 'presensePenalty',
        helpKey: 'presensePenalty',
        bindKey: 'PresensePenalty',
        condition: (ctx) => ctx.modelInfo.parameters.includes('presence_penalty'),
        options: {
            min: 0,
            max: 200,
            multiple: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ['presence', 'penalty'],
    },
    {
        id: 'params.topP',
        type: 'slider',
        fallbackLabel: 'Top P',
        helpKey: 'topP',
        bindKey: 'top_p',
        condition: (ctx) => ctx.modelInfo.parameters.includes('top_p'),
        options: {
            min: 0,
            max: 1,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ['top', 'p', 'nucleus', 'sampling'],
    },
];

/**
 * Model-specific parameters that depend on modelInfo.parameters
 */
export const modelSpecificParameterItems: SettingItem[] = [
    {
        id: 'params.thinkingType',
        type: 'segmented',
        labelKey: 'thinkingType',
        helpKey: 'thinkingType',
        bindKey: 'thinkingType',
        condition: (ctx) =>
            ctx.modelInfo.flags.includes(LLMFlags.claudeThinking) ||
            ctx.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking),
        options: {
            segmentOptions: [
                { value: 'off', label: 'Off' },
                { value: 'budget', label: 'Budget (Manual Tokens)', condition: (ctx) => ctx.modelInfo.flags.includes(LLMFlags.claudeThinking)  },
                { value: 'adaptive', label: 'Adaptive', condition: (ctx) => ctx.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking) },
            ]
        },
        keywords: ['thinking', 'type', 'mode', 'adaptive', 'budget'],
    },
    {
        id: 'params.geminiThinkingLevel',
        type: 'segmented',
        fallbackLabel: 'Gemini Thinking Level',
        helpKey: 'thinkingTokens',
        bindKey: 'thinkingTokens',
        condition: (ctx) => isGeminiThinkingLevelModel(ctx),
        getValue: (db, ctx) => geminiThinkingTokensToLevel(db.thinkingTokens, ctx!),
        setValue: (db, val) => {
            db.thinkingTokens = geminiThinkingLevelToTokens(val as GeminiThinkingLevel);
        },
        options: {
            segmentOptions: [
                { value: 'minimal', label: 'Minimal', condition: supportsGeminiMinimalThinking },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium', condition: supportsGeminiMediumThinking },
                { value: 'high', label: 'High' },
            ],
            segmentFullWidth: true,
            segmentSize: 'sm',
        },
        keywords: ['gemini', 'thinking', 'level', 'reasoning'],
    },
    {
        id: 'params.thinkingTokens',
        type: 'slider',
        labelKey: 'thinkingTokens',
        helpKey: 'thinkingTokens',
        bindKey: 'thinkingTokens',
        condition: (ctx) =>
            ctx.modelInfo.parameters.includes('thinking_tokens') &&
            !isGeminiThinkingLevelModel(ctx) &&
            (
                ctx.modelInfo.flags.includes(LLMFlags.geminiThinking) ||
                ctx.db.thinkingType === 'budget'
            ),
        options: {
            min: -1,
            max: 64000,
            step: 200,
            disableable: true,
        },
        keywords: ['thinking', 'tokens', 'reasoning'],
    },
    {
        id: 'params.adaptiveThinkingEffort',
        type: 'segmented',
        labelKey: 'adaptiveThinkingEffort',
        helpKey: 'adaptiveThinkingEffort',
        bindKey: 'adaptiveThinkingEffort',
        condition: (ctx) =>
            ctx.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking) &&
            ctx.db.thinkingType === 'adaptive',
        options: {
            segmentOptions: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'XHigh' },
                { value: 'max', label: 'Max' },
            ]
        },
        keywords: ['adaptive', 'thinking', 'effort'],
    },
    {
        id: 'params.adaptiveThinkingDisplay',
        type: 'segmented',
        labelKey: 'adaptiveThinkingDisplay',
        bindKey: 'adaptiveThinkingDisplay',
        condition: (ctx) =>
            ctx.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking) &&
            ctx.db.thinkingType === 'adaptive',
        options: {
            segmentOptions: [
                { value: 'summarized', label: 'Summarized' },
                { value: 'omitted', label: 'Omitted' },
            ]
        },
        keywords: ['adaptive', 'thinking', 'display', 'summarized', 'omitted'],
    },
    {
        id: 'params.topK',
        type: 'slider',
        fallbackLabel: 'Top K',
        helpKey: 'topK',
        bindKey: 'top_k',
        condition: (ctx) => ctx.modelInfo.parameters.includes('top_k'),
        options: {
            min: 0,
            max: 100,
            step: 1,
            disableable: true,
        },
        keywords: ['top', 'k', 'sampling'],
    },
    {
        id: 'params.minP',
        type: 'slider',
        fallbackLabel: 'Min P',
        helpKey: 'minP',
        bindKey: 'min_p',
        condition: (ctx) => ctx.modelInfo.parameters.includes('min_p'),
        options: {
            min: 0,
            max: 1,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ['min', 'p', 'sampling'],
    },
    {
        id: 'params.topA',
        type: 'slider',
        fallbackLabel: 'Top A',
        helpKey: 'topA',
        bindKey: 'top_a',
        condition: (ctx) => ctx.modelInfo.parameters.includes('top_a'),
        options: {
            min: 0,
            max: 1,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ['top', 'a', 'sampling'],
    },
    {
        id: 'params.repetitionPenalty',
        type: 'slider',
        fallbackLabel: 'Repetition penalty',
        helpKey: 'repetitionPenalty',
        bindKey: 'repetition_penalty',
        condition: (ctx) => ctx.modelInfo.parameters.includes('repetition_penalty'),
        options: {
            min: 0,
            max: 2,
            step: 0.01,
            fixed: 2,
            disableable: true,
        },
        keywords: ['repetition', 'penalty'],
    },
    {
        id: 'params.reasoningEffort',
        type: 'segmented',
        fallbackLabel: 'Reasoning Effort',
        helpKey: 'reasoningEffort',
        bindKey: 'reasoningEffort',
        condition: (ctx) => ctx.modelInfo.parameters.includes('reasoning_effort'),
        getValue: (db) => dbReasoningEffortToUi(db.reasoningEffort),
        setValue: (db, val) => {
            db.reasoningEffort = uiReasoningEffortToDb(val)
        },
        options: {
            segmentOptions: reasoningEffortSelectOptions.map((option) => ({
                value: option.value,
                label: option.label,
            })),
            segmentWrap: true,
            segmentFullWidth: true,
            segmentSize: 'sm',
        },
        keywords: ['reasoning', 'effort'],
    },
    {
        id: 'params.verbosity',
        type: 'segmented',
        fallbackLabel: 'Verbosity',
        helpKey: 'verbosity',
        bindKey: 'verbosity',
        condition: (ctx) => ctx.modelInfo.parameters.includes('verbosity'),
        getValue: (db) => dbVerbosityToUi(db.verbosity),
        setValue: (db, val) => {
            db.verbosity = uiVerbosityToDb(val)
        },
        options: {
            segmentOptions: verbositySelectOptions.map((option) => ({
                value: option.value,
                label: option.label,
            })),
            segmentFullWidth: true,
            segmentSize: 'sm',
        },
        keywords: ['verbosity', 'length'],
    },
];

/**
 * All basic parameter items combined for Parameters tab
 * Order: maxContext, maxResponse, seed, thinkingType, thinkingTokens, adaptiveThinkingEffort, temperature, topK, minP, topA, repetitionPenalty, reasoningEffort, verbosity, topP, frequencyPenalty, presencePenalty
 */
export const allBasicParameterItems: SettingItem[] = [
    // Basic settings (always shown)
    ...basicParameterItems,
    seedSetting,

    // Model-specific sampling parameters (in user-specified order)
    modelSpecificParameterItems.find(i => i.id === 'params.thinkingType')!,
    modelSpecificParameterItems.find(i => i.id === 'params.geminiThinkingLevel')!,
    modelSpecificParameterItems.find(i => i.id === 'params.thinkingTokens')!,
    modelSpecificParameterItems.find(i => i.id === 'params.adaptiveThinkingEffort')!,
    ...samplingParameterItems, // temperature
    modelSpecificParameterItems.find(i => i.id === 'params.topK')!,
    modelSpecificParameterItems.find(i => i.id === 'params.minP')!,
    modelSpecificParameterItems.find(i => i.id === 'params.topA')!,
    modelSpecificParameterItems.find(i => i.id === 'params.repetitionPenalty')!,
    modelSpecificParameterItems.find(i => i.id === 'params.reasoningEffort')!,
    modelSpecificParameterItems.find(i => i.id === 'params.verbosity')!,
    penaltyParameterItems.find(i => i.id === 'params.topP')!,
    penaltyParameterItems.find(i => i.id === 'params.frequencyPenalty')!,
    penaltyParameterItems.find(i => i.id === 'params.presencePenalty')!,
    // NOTE: separateParametersItem is now handled via custom component below
];

/**
 * Separate Parameters section (custom component)
 */
export const separateParametersItem: SettingItem = {
    id: 'params.separateParameters',
    type: 'custom',
    componentId: 'SeparateParametersSection' as any,
    keywords: ['separate', 'parameters', 'memory', 'emotion', 'translate'],
};
