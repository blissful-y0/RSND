function parseSessionCookie(req) {
    const cookieHeader = req?.headers?.cookie || ''
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === 'risu-session') return part.slice(eq + 1).trim()
    }
    return null
}

function hasValidSession(req, sessions, now = Date.now()) {
    const token = parseSessionCookie(req)
    return !!(token && (sessions.get(token) ?? 0) > now)
}

function createSessionOrJwtAuthMiddleware({ sessions, checkAuth, now = () => Date.now() }) {
    return async function sessionOrJwtAuthMiddleware(req, res, next) {
        if (hasValidSession(req, sessions, now())) return next()
        if (await checkAuth(req, res, true)) return next()
        res.status(401).end()
    }
}

module.exports = {
    parseSessionCookie,
    hasValidSession,
    createSessionOrJwtAuthMiddleware,
}
