import { describe, expect, test, vi } from 'vitest'

type ReqLike = { headers?: Record<string, string | undefined> }

function makeRes() {
    const res = {
        status: vi.fn(),
        end: vi.fn(),
    }
    res.status.mockReturnValue(res)
    return res
}

describe('createSessionOrJwtAuthMiddleware', () => {
    test('valid session cookie면 JWT 검사 없이 통과한다', async () => {
        const { createSessionOrJwtAuthMiddleware } = await import('./sessionAuth.cjs')
        const sessions = new Map([['good-token', 10_000]])
        const checkAuth = vi.fn().mockResolvedValue(false)
        const next = vi.fn()
        const req: ReqLike = {
            headers: {
                cookie: 'foo=bar; risu-session=good-token; another=value',
            },
        }
        const res = makeRes()
        const middleware = createSessionOrJwtAuthMiddleware({
            sessions,
            checkAuth,
            now: () => 5_000,
        })

        await middleware(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(checkAuth).not.toHaveBeenCalled()
        expect(res.status).not.toHaveBeenCalled()
    })

    test('세션이 없으면 risu-auth 검사를 허용한다', async () => {
        const { createSessionOrJwtAuthMiddleware } = await import('./sessionAuth.cjs')
        const sessions = new Map<string, number>()
        const checkAuth = vi.fn().mockResolvedValue(true)
        const next = vi.fn()
        const req: ReqLike = {
            headers: {
                'risu-auth': 'jwt-token',
            },
        }
        const res = makeRes()
        const middleware = createSessionOrJwtAuthMiddleware({
            sessions,
            checkAuth,
            now: () => 5_000,
        })

        await middleware(req, res, next)

        expect(checkAuth).toHaveBeenCalledWith(req, res, true)
        expect(next).toHaveBeenCalledTimes(1)
        expect(res.status).not.toHaveBeenCalled()
    })

    test('세션과 risu-auth가 모두 없으면 401을 돌려준다', async () => {
        const { createSessionOrJwtAuthMiddleware } = await import('./sessionAuth.cjs')
        const sessions = new Map<string, number>()
        const checkAuth = vi.fn().mockResolvedValue(false)
        const next = vi.fn()
        const req: ReqLike = { headers: {} }
        const res = makeRes()
        const middleware = createSessionOrJwtAuthMiddleware({
            sessions,
            checkAuth,
            now: () => 5_000,
        })

        await middleware(req, res, next)

        expect(checkAuth).toHaveBeenCalledWith(req, res, true)
        expect(next).not.toHaveBeenCalled()
        expect(res.status).toHaveBeenCalledWith(401)
        expect(res.end).toHaveBeenCalledTimes(1)
    })
})
