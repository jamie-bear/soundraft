const { logError } = require('../lib/logging');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
let authPool;

// V4: Validate JWT secret at startup — refuse to run with missing or known-weak defaults
const KNOWN_DEV_SECRETS = [
    'dev_secret_key',
    'dev_secret_key_change_in_prod',
    'dev_secret_key_change_in_prod_use_random_string',
    'secret',
    'changeme',
];

if (!JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
}

if (KNOWN_DEV_SECRETS.includes(JWT_SECRET)) {
    console.warn(
        'WARNING: JWT_SECRET is set to a known development default. ' +
        'Generate a strong random secret for production (e.g. openssl rand -hex 64).'
    );
}

// Session and resource-grant JWTs use the same signing key but are deliberately
// non-interchangeable through audience, issuer, and token_type checks.
const JWT_VERIFY_OPTIONS = {
    algorithms: ['HS256'],
    audience: 'soundraft-api',
    issuer: 'soundraft',
};

function verifySession(token) {
    const decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTIONS);
    if (decoded.token_type !== 'SESSION' || !decoded.id) {
        throw Object.assign(new Error('Invalid session token'), { statusCode: 401 });
    }
    return decoded;
}

function setAuthPool(pool) {
    authPool = pool;
}

async function loadCurrentUser(decoded) {
    if (!authPool) throw new Error('Authentication database is not configured');
    const result = await authPool.query(
        'SELECT id, email, role, is_active, auth_version FROM users WHERE id = $1',
        [decoded.id]
    );
    const user = result.rows[0];
    if (!user || !user.is_active || Number(user.auth_version) !== Number(decoded.auth_version)) {
        throw Object.assign(new Error('Session revoked'), { statusCode: 401 });
    }
    return { id: user.id, email: user.email, role: user.role, auth_version: user.auth_version };
}

/**
 * Middleware: Require valid JWT token
 * Sets req.user with decoded token payload
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verifySession(token);
        req.user = await loadCurrentUser(decoded);
        next();
    } catch (err) {
        const invalid = err.statusCode === 401 || err instanceof jwt.JsonWebTokenError;
        return res.status(invalid ? 401 : 503).json({ error: invalid ? 'Invalid token' : 'Authentication temporarily unavailable' });
    }
}

/**
 * Middleware: Optional authentication
 * Sets req.user if valid token exists, otherwise continues
 */
async function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        return next();
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verifySession(token);
        req.user = await loadCurrentUser(decoded);
    } catch (err) {
        if (err.statusCode !== 401 && !(err instanceof jwt.JsonWebTokenError)) {
            return res.status(503).json({ error: 'Authentication temporarily unavailable' });
        }
        req.user = null;
    }

    next();
}

/**
 * Middleware Factory: Check resource ownership
 * @param {Function} getOwnerId - Async function that returns owner_id from request params
 */
function checkOwnership(getOwnerId) {
    return async (req, res, next) => {
        try {
            const ownerId = await getOwnerId(req);

            if (!ownerId) {
                return res.status(404).json({ error: 'Resource not found' });
            }

            if (req.user.id !== ownerId) {
                return res.status(403).json({ error: 'Access denied' });
            }

            next();
        } catch (err) {
            logError('Ownership check error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    };
}

/**
 * Middleware Factory: Check share token access
 * Allows access if valid share token provided OR user is owner
 * Sets req.accessLevel = 'READ' | 'COMMENT' | 'OWNER'
 */
function checkShareAccess(getResource) {
    return async (req, res, next) => {
        try {
            const resource = await getResource(req);

            if (!resource) {
                return res.status(404).json({ error: 'Resource not found' });
            }

            req.resource = resource;

            // Check if user is owner
            if (req.user && req.user.id === resource.owner_id) {
                req.accessLevel = 'OWNER';
                return next();
            }

            // Check share token
            const token = req.query.token || req.params.token;

            if (resource.share_token && token === resource.share_token) {
                // Check if resource is public
                if (resource.is_public || resource.release_status === 'PUBLIC') {
                    req.accessLevel = 'READ';
                    return next();
                }
            }

            // No valid access
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            return res.status(403).json({ error: 'Access denied' });
        } catch (err) {
            logError('Share access check error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    };
}

/**
 * Middleware: Block write operations for non-owners
 * Use after checkShareAccess middleware
 */
function requireOwnerForWrite(req, res, next) {
    const writeMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);

    if (writeMethod && req.accessLevel !== 'OWNER') {
        return res.status(403).json({ error: 'Write access denied' });
    }

    next();
}

/**
 * Generate JWT token
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role,
            auth_version: Number(user.auth_version),
            token_type: 'SESSION'
        },
        JWT_SECRET,
        {
            algorithm: 'HS256',
            audience: 'soundraft-api',
            issuer: 'soundraft',
            expiresIn: '7d',
        }
    );
}

module.exports = {
    requireAuth,
    optionalAuth,
    checkOwnership,
    checkShareAccess,
    requireOwnerForWrite,
    generateToken,
    setAuthPool,
    JWT_SECRET
};
