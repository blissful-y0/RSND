import { fetchNative } from "src/ts/globalApi.svelte"
import { getDatabase } from "src/ts/storage/database.svelte"
import type { RequestDataArgumentExtended, requestDataResponse } from './request'
import { requestOpenAI } from './openAI/requests'
import type { VercelModelInfo } from "src/ts/model/vercel"

const VERCEL_AI_GATEWAY_API = 'https://ai-gateway.vercel.sh/v1'

export interface VercelCredits {
    balance: string
    totalUsed: string
}

export async function requestVercel(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const db = getDatabase()
    if (!db.vercelKey) {
        return {
            type: 'fail',
            result: 'No Vercel API key configured. Add a key in Settings → Model → Vercel.'
        }
    }

    if (arg.modelInfo?.id === 'vercel' && !db.vercelRequestModel) {
        return {
            type: 'fail',
            result: 'No Vercel Gateway model selected. Choose a model in Settings → Model → Vercel.'
        }
    }

    const modelInfo = arg.modelInfo && arg.modelInfo.id === 'vercel'
        ? { ...arg.modelInfo, internalID: db.vercelRequestModel }
        : arg.modelInfo

    return requestOpenAI({
        ...arg,
        modelInfo,
        customURL: `${VERCEL_AI_GATEWAY_API}/chat/completions`,
        key: db.vercelKey,
    })
}

export async function fetchVercelModels(): Promise<{models: VercelModelInfo[], error?: string}> {
    try {
        const res = await fetchNative(`${VERCEL_AI_GATEWAY_API}/models`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        })

        if (!res.ok) {
            return { models: [], error: `Failed to fetch Vercel models (HTTP ${res.status})` }
        }

        const data = await res.json()
        const models: VercelModelInfo[] = (data.data ?? [])
            .filter((m: any) => (m.type ?? 'language') === 'language')
            .map((m: any) => {
                const tags: string[] = Array.isArray(m.tags) ? m.tags : []
                return {
                    id: m.id,
                    name: m.name ?? m.id,
                    type: m.type ?? 'language',
                    contextWindow: Number(m.context_window ?? m.contextWindow ?? 0),
                    maxTokens: Number(m.max_tokens ?? m.maxTokens ?? 0),
                    supportsVision: Boolean(m.capabilities?.vision ?? m.supports_vision ?? tags.includes('vision')),
                    supportsReasoning: Boolean(m.capabilities?.reasoning ?? m.supports_reasoning ?? tags.includes('reasoning')),
                    promptPrice1M: parseTokenPrice(m.pricing?.input ?? m.pricing?.prompt),
                    completionPrice1M: parseTokenPrice(m.pricing?.output ?? m.pricing?.completion),
                }
            })

        return { models }
    } catch (e) {
        return { models: [], error: e?.message ?? 'Unknown error' }
    }
}

export async function fetchVercelCredits(apiKey = getDatabase().vercelKey): Promise<{credits: VercelCredits | null, error?: string}> {
    if (!apiKey) return { credits: null, error: 'No Vercel API key configured' }

    try {
        const res = await fetchNative(`${VERCEL_AI_GATEWAY_API}/credits`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
        })

        if (!res.ok) {
            return { credits: null, error: `Failed to fetch Vercel credits (HTTP ${res.status})` }
        }

        const data = await res.json()
        return {
            credits: {
                balance: String(data.balance ?? '0'),
                totalUsed: String(data.total_used ?? data.totalUsed ?? '0'),
            },
        }
    } catch (e) {
        return { credits: null, error: e?.message ?? 'Unknown error' }
    }
}

function parseTokenPrice(raw: unknown): number | undefined {
    const n = Number(raw)
    if (raw == null || raw === '' || !Number.isFinite(n)) return undefined
    return n >= 0.01 ? n : n * 1_000_000
}
