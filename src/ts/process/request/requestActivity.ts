export const trackedRequestActivityModes = ['otherAx', 'submodel', 'translate'] as const

export type RequestActivityMode = (typeof trackedRequestActivityModes)[number]

export type RequestActivityState = {
    activeCount: number
    byMode: Record<RequestActivityMode, number>
    lastStartedAt: number | null
}

export function createRequestActivityState(): RequestActivityState {
    return {
        activeCount: 0,
        byMode: {
            otherAx: 0,
            submodel: 0,
            translate: 0,
        },
        lastStartedAt: null,
    }
}

export function isTrackedRequestActivityMode(mode: string): mode is RequestActivityMode {
    return trackedRequestActivityModes.includes(mode as RequestActivityMode)
}

export function startRequestActivity(
    state: RequestActivityState,
    mode: string,
    startedAt = Date.now(),
): RequestActivityState {
    if (!isTrackedRequestActivityMode(mode)) {
        return state
    }

    return {
        activeCount: state.activeCount + 1,
        byMode: {
            ...state.byMode,
            [mode]: state.byMode[mode] + 1,
        },
        lastStartedAt: startedAt,
    }
}

export function endRequestActivity(state: RequestActivityState, mode: string): RequestActivityState {
    if (!isTrackedRequestActivityMode(mode)) {
        return state
    }

    if (state.byMode[mode] <= 0) {
        return state
    }

    return {
        activeCount: Math.max(0, state.activeCount - 1),
        byMode: {
            ...state.byMode,
            [mode]: state.byMode[mode] - 1,
        },
        lastStartedAt: state.lastStartedAt,
    }
}

export function getRequestActivityLabel(state: RequestActivityState): string {
    if (state.activeCount <= 0) {
        return ''
    }

    if (state.activeCount === 1) {
        if (state.byMode.translate > 0) {
            return '번역 처리 중'
        }
        return '보조 모델 처리 중'
    }

    return `보조 요청 ${state.activeCount}개 처리 중`
}
