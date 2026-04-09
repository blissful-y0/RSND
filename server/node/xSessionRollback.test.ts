import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const serverSource = readFileSync(join(process.cwd(), 'server/node/server.cjs'), 'utf8')
const nodeStorageSource = readFileSync(join(process.cwd(), 'src/ts/storage/nodeStorage.ts'), 'utf8')
const globalApiSource = readFileSync(join(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')

describe('upstream x-session-id rollback', () => {
    test('client가 page-load session id를 만들고 auth 요청에 보낸다', () => {
        expect(nodeStorageSource).toContain('private static sessionId')
        expect(nodeStorageSource).toContain("headers.set('x-session-id', NodeStorage.sessionId)")
        expect(nodeStorageSource).toContain("'x-session-id': NodeStorage.sessionId")
        expect(nodeStorageSource).toContain("window.dispatchEvent(new CustomEvent('risu-session-deactivated'))")
    })

    test('server가 active writer session을 추적한다', () => {
        expect(serverSource).toContain('let activeSessionId = null')
        expect(serverSource).toContain('function checkActiveSession(req, res)')
        expect(serverSource).toContain("const clientSessionId = req.headers['x-session-id']")
        expect(serverSource).toContain("if (!checkActiveSession(req, res)) return;")
    })

    test('/api/session이 active writer session을 갱신한다', () => {
        expect(serverSource).toContain("const clientSessionId = req.headers['x-session-id']")
        expect(serverSource).toContain('activeSessionId = clientSessionId')
    })

    test('423 deactivation을 받으면 기존 탭 전환 경고처럼 reload 경로를 탄다', () => {
        expect(globalApiSource).toContain("window.addEventListener('risu-session-deactivated'")
        expect(globalApiSource).toContain('alertNormalWait(language.activeTabChange).then(() => {')
    })
})
