import { describe, expect, test } from 'vitest'

import { shouldTrackCharacterFieldForSave } from './saveTracking'

describe('shouldTrackCharacterFieldForSave', () => {
    test('skips transient UI-only character fields', () => {
        expect(shouldTrackCharacterFieldForSave('reloadKeys')).toBe(false)
    })

    test('keeps persistent character fields tracked', () => {
        expect(shouldTrackCharacterFieldForSave('name')).toBe(true)
        expect(shouldTrackCharacterFieldForSave('chats')).toBe(false)
    })
})
