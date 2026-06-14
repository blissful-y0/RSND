export type StandardChatWidth = 'standard' | 'wide' | 'full'

export interface VisualViewportLike {
    height: number
    offsetTop: number
}

export function isStandardTheme(theme: string): boolean {
    return theme === ''
}

export function shouldFloatChatComposer(_theme: string, fixedChatTextarea: boolean): boolean {
    return fixedChatTextarea
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
