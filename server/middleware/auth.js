const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key';

/**
 * Middleware: Require valid JWT token
 * Sets req.user with decoded token payload
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

/**
 * Middleware: Require valid JWT token (accepts both header and query param)
 * Use for download endpoints that need direct browser access
 * Sets req.user with decoded token payload
 */
function requireAuthWithQuery(req, res, next) {
    let token = null;
    
    // First try Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    }
    
    // If no header, try query param 'auth'
    if (!token && req.query.auth) {
        token = req.query.auth;
    }
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

/**
 * Middleware: Optional authentication
 * Sets req.user if valid token exists, otherwise continues
 */
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.user = null;
        return next();
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
    } catch (err) {
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
            console.error('Ownership check error:', err);
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
            console.error('Share access check error:', err);
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
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

module.exports = {
    requireAuth,
    requireAuthWithQuery,
    optionalAuth,
    checkOwnership,
    checkShareAccess,
    requireOwnerForWrite,
    generateToken,
    JWT_SECRET
};
