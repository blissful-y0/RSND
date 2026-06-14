export type StandardChatWidth = 'standard' | 'wide' | 'full'

export interface VisualViewportLike {
    height: number
    offsetTop: number
}

export function isStandardTheme(theme: string): boolean {
    return theme === ''
}

export function shouldFloatChatComposer(_theme: string, _fixedChatTextarea: boolean): boolean {
    return false
}

export function chatComposerContainerClass(floating: boolean, fixedChatTextarea: boolean): string {
    let layoutClass = 'mt-2 mb-2'
    if(floating){
        layoutClass = 'pt-2 pb-2'
    } else if(fixedChatTextarea){
        layoutClass = 'sticky pt-2 pb-2 right-0 bottom-0 bg-bgcolor'
    }

    return `${layoutClass} w-full`
}

export function chatComposerContainerStyle(floating: boolean, fixedChatTextarea: boolean): string {
    return !floating && fixedChatTextarea ? 'z-index:29;' : ''
}

export function chatComposerWidthClass(theme: string, width: StandardChatWidth): string {
    if(!isStandardTheme(theme)) return ''
    if(width === 'full') return 'max-w-full'
    if(width === 'wide') return 'max-w-6xl'
    return 'max-w-3xl'
}

export function keyboardInsetFromVisualViewport(
    innerHeight: number,
    viewport: VisualViewportLike | null | undefined,
    baselineHeight = innerHeight
): number {
    if(!viewport) return 0
    const layoutHeight = Math.max(innerHeight, baselineHeight)
    return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
}

export function chatComposerPadding(floating: boolean, composerHeight: string, keyboardInset: number): string {
    if(!floating) return ''
    if(keyboardInset <= 0) return composerHeight
    return `calc(${composerHeight} + ${keyboardInset}px)`
}
