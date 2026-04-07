const transientCharacterFields = new Set([
    'reloadKeys',
])

export function isTransientCharacterField(key: string) {
    return transientCharacterFields.has(key)
}

export function shouldPersistCharacterFieldInSync(key: string) {
    return !isTransientCharacterField(key)
}

export function shouldTrackCharacterFieldForSave(key: string) {
    if (key === 'chats') {
        return false
    }
    return shouldPersistCharacterFieldInSync(key)
}
