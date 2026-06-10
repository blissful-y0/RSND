import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, ClaudeParameters, GPT5Parameters, OpenAIParameters, type LLMModel } from './types'
import type { ModelGridItem } from './modelGrid'
import type { LLMGatewayModelInfo } from '../process/request/llmgateway'

function isAnthropicModel(model: LLMGatewayModelInfo): boolean {
    return /claude|anthropic/i.test(`${model.id} ${model.name} ${model.family}`)
}

export function toLLMGatewayDynamicModel(model: LLMGatewayModelInfo): LLMModel {
    const anthropic = isAnthropicModel(model)
    const flags: LLMFlags[] = [LLMFlags.hasStreaming]

    if (model.supportsVision) flags.push(LLMFlags.hasImageInput)
    if (anthropic) {
        flags.push(LLMFlags.hasFirstSystemPrompt)
    } else {
        flags.push(LLMFlags.hasFullSystemPrompt)
    }

    return {
        id: `dynamic_llmgateway_${model.id}`,
        name: model.name,
        shortName: `LLM Gateway ${model.name}`,
        fullName: `LLM Gateway ${model.name}`,
        internalID: model.id,
        provider: LLMProvider.LLMGateway,
        format: anthropic ? LLMFormat.Anthropic : LLMFormat.OpenAICompatible,
        flags,
        parameters: anthropic
            ? ClaudeParameters
            : (model.id.startsWith('gpt-5') ? GPT5Parameters : OpenAIParameters),
        tokenizer: anthropic ? LLMTokenizer.Claude : LLMTokenizer.tiktokenO200Base,
    }
}

export async function getLLMGatewayModels(): Promise<LLMGatewayModelInfo[]> {
    const { fetchLLMGatewayModels } = await import('../process/request/llmgateway')
    const { models } = await fetchLLMGatewayModels()
    return models
}

export function toModelGridItem(model: LLMGatewayModelInfo): ModelGridItem {
    const prices: { label: string; value: string }[] = []
    if (model.promptPrice1M !== undefined) prices.push({ label: 'In', value: `$${model.promptPrice1M.toFixed(2)}` })
    if (model.completionPrice1M !== undefined) prices.push({ label: 'Out', value: `$${model.completionPrice1M.toFixed(2)}` })

    return {
        id: model.id,
        displayName: model.name,
        providerName: 'LLM Gateway',
        description: [model.family, model.contextWindow ? `${model.contextWindow.toLocaleString()} ctx` : ''].filter(Boolean).join(' · '),
        context_length: model.contextWindow,
        sortPrice: model.promptPrice1M ?? Infinity,
        prices,
    }
}
