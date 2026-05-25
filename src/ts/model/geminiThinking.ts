import { LLMFlags } from './types';

export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type GeminiApiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

export const DEFAULT_GEMINI_THINKING_TOKENS = 1024;

type GeminiThinkingModelContext = {
    modelInfo: {
        id?: string;
        internalID?: string;
        flags?: LLMFlags[];
    };
};

export function getGeminiThinkingModelId(ctx: GeminiThinkingModelContext): string {
    return ctx.modelInfo.internalID ?? ctx.modelInfo.id ?? '';
}

export function isGeminiThinkingLevelModel(ctx: GeminiThinkingModelContext): boolean {
    return (ctx.modelInfo.flags ?? []).includes(LLMFlags.geminiThinking) && /^gemini-3(?:[.-]|$)/.test(getGeminiThinkingModelId(ctx));
}

export function supportsGeminiMinimalThinking(ctx: GeminiThinkingModelContext): boolean {
    const modelId = getGeminiThinkingModelId(ctx);
    return modelId === 'gemini-3-flash-preview' || modelId.startsWith('gemini-3.5-flash');
}

export function supportsGeminiMediumThinking(ctx: GeminiThinkingModelContext): boolean {
    const modelId = getGeminiThinkingModelId(ctx);
    return supportsGeminiMinimalThinking(ctx) || modelId.startsWith('gemini-3.1-');
}

export function geminiThinkingTokensToLevel(tokens: number | null | undefined, ctx: GeminiThinkingModelContext): GeminiThinkingLevel {
    const budget = typeof tokens === 'number' ? tokens : DEFAULT_GEMINI_THINKING_TOKENS;
    if (supportsGeminiMinimalThinking(ctx) && budget <= 0) return 'minimal';
    if (budget >= 16384) return 'high';
    if (supportsGeminiMediumThinking(ctx) && budget >= 4096) return 'medium';
    return 'low';
}

export function geminiThinkingLevelToTokens(level: GeminiThinkingLevel): number {
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

export function geminiThinkingTokensToApiLevel(tokens: number | null | undefined, ctx: GeminiThinkingModelContext): GeminiApiThinkingLevel {
    const budget = typeof tokens === 'number' ? tokens : DEFAULT_GEMINI_THINKING_TOKENS;
    if (supportsGeminiMinimalThinking(ctx) && budget <= 0) return 'MINIMAL';
    if (budget >= (supportsGeminiMediumThinking(ctx) ? 16384 : 8192)) return 'HIGH';
    if (supportsGeminiMediumThinking(ctx) && budget >= 4096) return 'MEDIUM';
    return 'LOW';
}
