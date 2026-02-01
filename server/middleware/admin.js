const { requireAuth } = require('./auth');

/**
 * Middleware: Require admin role
 * Must be used after requireAuth middleware
 */
function requireAdmin(req, res, next) {
    // First ensure user is authenticated
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Check admin role
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    next();
}

/**
 * Combined middleware: Require auth + admin
 * Use this as a single middleware for admin routes
 */
const requireAuthAdmin = [requireAuth, requireAdmin];

module.exports = {
    requireAdmin,
    requireAuthAdmin
};
