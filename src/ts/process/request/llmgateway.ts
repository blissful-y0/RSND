import { fetchNative } from "src/ts/globalApi.svelte"
import { LLMFormat } from "src/ts/model/modellist"
import { getDatabase } from "src/ts/storage/database.svelte"
import type { RequestDataArgumentExtended, requestDataResponse } from './request'
import { requestClaude } from './anthropic'
import { requestOpenAI } from './openAI/requests'

const LLM_GATEWAY_API = 'https://api.llmgateway.io'
const LLM_GATEWAY_V1_API = `${LLM_GATEWAY_API}/v1`
const LLM_GATEWAY_PROXY_POLICY = 'always' as const

const OPENCODE_VERSION = '1.14.20'
const AI_SDK_VERSION = '4.0.23'
const BUN_VERSION = '1.3.11'

type Initiator = 'user' | 'agent'

export interface LLMGatewayModelInfo {
    id: string
    name: string
    family: string
    contextWindow: number
    supportsVision: boolean
    supportsTools: boolean
    supportsReasoning: boolean
    promptPrice1M?: number
    completionPrice1M?: number
}

const chatSessions = new Map<string, string>()

function generateOpenCodeSessionId(): string {
    const mask = (1n << 48n) - 1n
    const time = BigInt(Date.now()) * 0x1000n + 1n
    const timeHex = (((~time) & mask)).toString(16).padStart(12, '0')

    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let suffix = ''
    while (suffix.length < 14) {
        const bytes = crypto.getRandomValues(new Uint8Array(14 - suffix.length))
        for (const b of bytes) {
            if (b >= 248) continue
            suffix += alphabet[b % 62]
            if (suffix.length === 14) break
        }
    }
    return `ses_${timeHex}${suffix}`
}

function getChatSessionId(chatKey: string): string {
    let sid = chatSessions.get(chatKey)
    if (!sid) {
        sid = generateOpenCodeSessionId()
        chatSessions.set(chatKey, sid)
    }
    return sid
}

function detectInitiator(arg: RequestDataArgumentExtended): Initiator {
    if (arg.mode && arg.mode !== 'model') return 'agent'

    const last = Array.isArray(arg.formated) ? arg.formated[arg.formated.length - 1] : null
    const role = (last as any)?.role
    if (role === 'tool' || role === 'function') return 'agent'

    return 'user'
}

function getRequestModel(arg: RequestDataArgumentExtended): string {
    const db = getDatabase()
    if (arg.modelInfo?.id === 'llmgateway') {
        return db.llmGatewayRequestModel
    }
    return arg.modelInfo?.internalID || db.llmGatewayRequestModel
}

function getEndpoint(format: LLMFormat): string {
    return format === LLMFormat.Anthropic
        ? `${LLM_GATEWAY_V1_API}/messages`
        : `${LLM_GATEWAY_V1_API}/chat/completions`
}

function buildOpenCodeHeaders(apiKey: string, arg: RequestDataArgumentExtended, format: LLMFormat): Record<string, string> {
    const initiator = detectInitiator(arg)
    const chatSession = getChatSessionId(arg.chatId ?? 'default')
    const sessionId = initiator === 'agent' ? generateOpenCodeSessionId() : chatSession
    const base = `opencode/${OPENCODE_VERSION}`
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': `${base} ai-sdk/provider-utils/${AI_SDK_VERSION} runtime/bun/${BUN_VERSION}, ${base}`,
        'Openai-Intent': 'conversation-edits',
        'x-initiator': initiator,
        'x-session-affinity': sessionId,
    }

    if (initiator === 'agent') {
        headers['x-parent-session-id'] = chatSession
    }

    if (format === LLMFormat.Anthropic) {
        headers['anthropic-version'] = '2023-06-01'
    }

    return headers
}

export async function requestLLMGateway(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const db = getDatabase()
    const apiKey = db.llmGatewayKey

    if (!apiKey) {
        return {
            type: 'fail',
            result: 'No LLM Gateway DevPass key configured. Add a key in Settings -> Model -> LLM Gateway.'
        }
    }

    const model = getRequestModel(arg)
    if (arg.modelInfo?.id === 'llmgateway' && !model) {
        return {
            type: 'fail',
            result: 'No LLM Gateway model selected. Choose a model in Settings -> Model -> LLM Gateway.'
        }
    }

    const format = arg.modelInfo.format
    const gatewayArg: RequestDataArgumentExtended = {
        ...arg,
        modelInfo: {
            ...arg.modelInfo,
            internalID: model,
        },
        customURL: getEndpoint(format),
        key: apiKey,
        extraHeaders: buildOpenCodeHeaders(apiKey, arg, format),
        proxyPolicy: LLM_GATEWAY_PROXY_POLICY,
    }

    if (format === LLMFormat.Anthropic) {
        return requestClaude(gatewayArg)
    }

    return requestOpenAI(gatewayArg)
}

function parseTokenPrice(raw: unknown): number | undefined {
    const n = Number(raw)
    if (raw == null || raw === '' || !Number.isFinite(n)) return undefined
    return n >= 0.01 ? n : n * 1_000_000
}

export async function fetchLLMGatewayModels(apiKey = getDatabase().llmGatewayKey): Promise<{models: LLMGatewayModelInfo[], error?: string}> {
    if (!apiKey) return { models: [], error: 'No LLM Gateway DevPass key configured' }

    try {
        const res = await fetchNative(`${LLM_GATEWAY_V1_API}/models`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'User-Agent': `opencode/${OPENCODE_VERSION}`,
            },
            proxyPolicy: LLM_GATEWAY_PROXY_POLICY,
        })

        if (!res.ok) {
            return { models: [], error: `Failed to fetch LLM Gateway models (HTTP ${res.status})` }
        }

        const data = await res.json()
        const models: LLMGatewayModelInfo[] = (data.data ?? []).map((model: any) => {
            const providers = Array.isArray(model.providers) ? model.providers : []
            const supportsVision = providers.some((provider: any) => !!provider?.vision)
            const supportsTools = providers.some((provider: any) => !!provider?.tools)
            const supportsReasoning = providers.some((provider: any) => !!provider?.reasoning)

            return {
                id: model.id,
                name: model.name ?? model.id,
                family: model.family ?? '',
                contextWindow: Number(model.context_length ?? model.contextWindow ?? 0),
                supportsVision,
                supportsTools,
                supportsReasoning,
                promptPrice1M: parseTokenPrice(model.pricing?.prompt),
                completionPrice1M: parseTokenPrice(model.pricing?.completion),
            }
        })

        return { models }
    } catch (e) {
        return { models: [], error: e?.message ?? 'Unknown error' }
    }
}
