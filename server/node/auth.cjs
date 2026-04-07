'use strict';

const nodeCrypto = require('crypto');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const rateLimit = require('express-rate-limit');

function createAuth({ passwordPath, jwtSecretPath }) {
    let password = '';
    if (existsSync(passwordPath)) {
        password = readFileSync(passwordPath, 'utf-8');
    }

    let jwtSecret;
    if (existsSync(jwtSecretPath)) {
        jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim();
    } else {
        jwtSecret = nodeCrypto.randomBytes(64).toString('hex');
        writeFileSync(jwtSecretPath, jwtSecret, 'utf-8');
    }

    const sessions = new Map(); // token -> expiresAt (ms)
    let activeSessionId = null;
    const hexRegex = /^[0-9a-fA-F]+$/;

    const loginRouteLimiter = rateLimit({
        windowMs: 30 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many attempts. Please wait and try again later.' },
        validate: { xForwardedForHeader: false },
    });

    function parseSessionCookie(req) {
        const cookieHeader = req.headers.cookie || '';
        for (const part of cookieHeader.split(';')) {
            const eq = part.indexOf('=');
            if (eq === -1) continue;
            if (part.slice(0, eq).trim() === 'risu-session') {
                return part.slice(eq + 1).trim();
            }
        }
        return null;
    }

    function sessionAuthMiddleware(req, res, next) {
        const token = parseSessionCookie(req);
        if (token && (sessions.get(token) ?? 0) > Date.now()) return next();
        res.status(401).end();
    }

    function checkActiveSession(req, res) {
        const clientSessionId = req.headers['x-session-id'];
        if (!clientSessionId) return true;
        if (!activeSessionId) return true;
        if (clientSessionId === activeSessionId) return true;
        res.status(423).json({ error: 'Session deactivated' });
        return false;
    }

    function isHex(str) {
        return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
    }

    async function hashJSON(json) {
        const hash = nodeCrypto.createHash('sha256');
        hash.update(JSON.stringify(json));
        return hash.digest('hex');
    }

    function createServerJwt() {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'HS256', typ: 'JWT' };
        const payload = { iat: now, exp: now + 5 * 60 };
        const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const sig = nodeCrypto.createHmac('sha256', jwtSecret)
            .update(`${headerB64}.${payloadB64}`)
            .digest('base64url');
        return `${headerB64}.${payloadB64}.${sig}`;
    }

    async function checkAuth(req, res, returnOnlyStatus = false, { allowExpired = false } = {}) {
        try {
            const authHeader = req.headers['risu-auth'];

            if (!authHeader) {
                console.log('No auth header');
                if (returnOnlyStatus) {
                    return false;
                }
                res.status(400).send({
                    error: 'No auth header',
                });
                return false;
            }

            const [
                jsonHeaderB64,
                jsonPayloadB64,
                signatureB64,
            ] = authHeader.split('.');

            const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));
            const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

            if (!allowExpired) {
                const now = Math.floor(Date.now() / 1000);
                if (jsonPayload.exp < now) {
                    console.log('Token expired');
                    if (returnOnlyStatus) {
                        return false;
                    }
                    res.status(400).send({
                        error: 'Token Expired',
                    });
                    return false;
                }
            }

            if (jsonHeader.alg !== 'HS256') {
                console.log('Unsupported algorithm');
                if (returnOnlyStatus) {
                    return false;
                }
                res.status(400).send({
                    error: 'Unsupported Algorithm',
                });
                return false;
            }

            const expectedSig = nodeCrypto.createHmac('sha256', jwtSecret)
                .update(`${jsonHeaderB64}.${jsonPayloadB64}`)
                .digest();
            const actualSig = Buffer.from(signatureB64, 'base64url');

            if (expectedSig.length !== actualSig.length || !nodeCrypto.timingSafeEqual(expectedSig, actualSig)) {
                console.log('Invalid signature');
                if (returnOnlyStatus) {
                    return false;
                }
                res.status(400).send({
                    error: 'Invalid Signature',
                });
                return false;
            }
            return true;
        } catch (error) {
            console.log(error);
            if (returnOnlyStatus) {
                return false;
            }
            res.status(500).send({
                error: 'Internal Server Error',
            });
            return false;
        }
    }

    function mountRoutes(app) {
        app.get('/api/test_auth', async (req, res) => {
            if (!password) {
                res.send({ status: 'unset' });
            } else if (!await checkAuth(req, res, true)) {
                const sessionToken = parseSessionCookie(req);
                if (sessionToken && (sessions.get(sessionToken) ?? 0) > Date.now()) {
                    res.send({ status: 'success', token: createServerJwt() });
                } else {
                    res.send({ status: 'incorrect' });
                }
            } else {
                res.send({ status: 'success', token: createServerJwt() });
            }
        });

        app.post('/api/login', loginRouteLimiter, async (req, res) => {
            if (password === '') {
                res.status(400).send({ error: 'Password not set' });
                return;
            }
            if (req.body.password && req.body.password.trim() === password.trim()) {
                res.send({ status: 'success', token: createServerJwt() });
            } else {
                res.status(400).send({ error: 'Password incorrect' });
            }
        });

        app.post('/api/token/refresh', async (req, res) => {
            if (!await checkAuth(req, res, false, { allowExpired: true })) return;
            res.json({ token: createServerJwt() });
        });

        app.post('/api/session', async (req, res) => {
            if (!await checkAuth(req, res)) return;
            const clientSessionId = req.headers['x-session-id'];
            if (clientSessionId) {
                activeSessionId = clientSessionId;
                console.log('[Session] Active writer session updated');
            }
            const token = nodeCrypto.randomBytes(32).toString('hex');
            const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
            sessions.set(token, expiresAt);
            for (const [t, exp] of sessions) {
                if (exp < Date.now()) sessions.delete(t);
            }
            const maxAge = 7 * 24 * 60 * 60;
            res.setHeader('Set-Cookie', `risu-session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`);
            res.json({ ok: true });
        });

        app.post('/api/crypto', async (req, res) => {
            try {
                const hash = nodeCrypto.createHash('sha256');
                hash.update(Buffer.from(req.body.data, 'utf-8'));
                res.send(hash.digest('hex'));
            } catch (error) {
                res.status(500).send({ error: 'Crypto operation failed' });
            }
        });

        app.post('/api/set_password', async (req, res) => {
            if (password === '') {
                password = req.body.password;
                writeFileSync(passwordPath, password, 'utf-8');
                res.send({ status: 'success' });
            } else {
                res.status(400).send('already set');
            }
        });
    }

    return {
        isHex,
        hashJSON,
        createServerJwt,
        parseSessionCookie,
        sessionAuthMiddleware,
        checkActiveSession,
        checkAuth,
        mountRoutes,
    };
}

module.exports = { createAuth };
