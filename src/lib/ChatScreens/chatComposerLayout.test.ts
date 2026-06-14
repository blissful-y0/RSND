import { describe, expect, test } from 'vitest'
import {
    chatComposerPadding,
    chatComposerContainerClass,
    chatComposerContainerStyle,
    chatComposerWidthClass,
    keyboardInsetFromVisualViewport,
    shouldFloatChatComposer,
} from './chatComposerLayout'

describe('chat composer layout', () => {
    test('keeps fixed composer in the scroll flow instead of floating it', () => {
        expect(shouldFloatChatComposer('', true)).toBe(false)
        expect(shouldFloatChatComposer('', false)).toBe(false)
        expect(shouldFloatChatComposer('custom-theme', true)).toBe(false)
        expect(chatComposerContainerClass(false, true)).toBe('sticky pt-2 pb-2 right-0 bottom-0 bg-bgcolor w-full')
        expect(chatComposerContainerStyle(false, true)).toBe('z-index:29;')
        expect(chatComposerContainerClass(false, false)).toBe('mt-2 mb-2 w-full')
        expect(chatComposerContainerStyle(false, false)).toBe('')
    })

    test('keeps standard theme width classes independent from floating mode', () => {
        expect(chatComposerWidthClass('', 'standard')).toBe('max-w-3xl')
        expect(chatComposerWidthClass('', 'wide')).toBe('max-w-6xl')
        expect(chatComposerWidthClass('', 'full')).toBe('max-w-full')
        expect(chatComposerWidthClass('custom-theme', 'wide')).toBe('')
    })

    test('calculates keyboard inset from visual viewport geometry', () => {
        expect(keyboardInsetFromVisualViewport(800, { height: 500, offsetTop: 0 })).toBe(300)
        expect(keyboardInsetFromVisualViewport(800, { height: 500.4, offsetTop: 10.2 })).toBe(289)
        expect(keyboardInsetFromVisualViewport(500, { height: 500, offsetTop: 0 }, 800)).toBe(300)
        expect(keyboardInsetFromVisualViewport(800, { height: 810, offsetTop: 0 })).toBe(0)
        expect(keyboardInsetFromVisualViewport(800, null)).toBe(0)
    })

    test('adds keyboard inset to floating composer padding only', () => {
        expect(chatComposerPadding(true, '64px', 280)).toBe('calc(64px + 280px)')
        expect(chatComposerPadding(true, '64px', 0)).toBe('64px')
        expect(chatComposerPadding(false, '64px', 280)).toBe('')
    })
})
