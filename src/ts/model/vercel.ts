import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from './types'
import type { ModelGridItem } from './modelGrid'

export type VercelModelInfo = {
    id: string
    name: string
    type: string
    contextWindow: number
    maxTokens: number
    supportsVision: boolean
    supportsReasoning: boolean
    promptPrice1M?: number
    completionPrice1M?: number
}

export function toVercelDynamicModel(model: VercelModelInfo): LLMModel {
    const flags: LLMFlags[] = [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming]
    if (model.supportsVision) flags.push(LLMFlags.hasImageInput)

    return {
        id: `dynamic_vercel_${model.id}`,
        name: model.name,
        shortName: `Vercel ${model.name}`,
        fullName: `Vercel ${model.name}`,
        internalID: model.id,
        provider: LLMProvider.Vercel,
        format: LLMFormat.OpenAICompatible,
        flags,
        parameters: ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'reasoning_effort', 'verbosity'],
        tokenizer: LLMTokenizer.tiktokenO200Base,
    }
}

export async function getVercelModels(): Promise<VercelModelInfo[]> {
    const { fetchVercelModels } = await import('../process/request/vercel')
    const { models } = await fetchVercelModels()
    return models
}

export function toModelGridItem(model: VercelModelInfo): ModelGridItem {
    const prices: { label: string; value: string }[] = []
    if (model.promptPrice1M !== undefined) prices.push({ label: 'In', value: `$${model.promptPrice1M.toFixed(2)}` })
    if (model.completionPrice1M !== undefined) prices.push({ label: 'Out', value: `$${model.completionPrice1M.toFixed(2)}` })

    return {
        id: model.id,
        displayName: model.name,
        providerName: 'Vercel',
        description: [model.type, model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : ''].filter(Boolean).join(' · '),
        context_length: model.contextWindow,
        sortPrice: model.promptPrice1M ?? Infinity,
        prices,
    }
}
