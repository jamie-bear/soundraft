const { logError } = require('../lib/logging');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { generateToken, requireAuth } = require('../middleware/auth');


// V6: Rate limiting for auth endpoints — prevent brute-force attacks
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,                    // 5 attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
});

module.exports = function(pool) {
    const router = require('../lib/router').createRouter();
    /**
     * POST /api/auth/register
     * Create a new user account
     */
    router.post('/register', authLimiter, async (req, res) => {
        try {
            const { email, password } = req.body;

            // Validation
            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required' });
            }

            // V11: Stricter password minimum
            if (password.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters' });
            }

            // Check if signups are enabled
            const signupsCheck = await pool.query(
                "SELECT value FROM system_settings WHERE key = 'signups_enabled'"
            );
            if (signupsCheck.rows.length > 0 && signupsCheck.rows[0].value === 'false') {
                return res.status(403).json({ error: 'New registrations are currently disabled' });
            }

            // Check if user exists
            const existing = await pool.query(
                'SELECT id FROM users WHERE email = $1',
                [email.toLowerCase()]
            );

            if (existing.rows.length > 0) {
                return res.status(409).json({ error: 'Email already registered' });
            }

            // Hash password and create user
            const passwordHash = await bcrypt.hash(password, 10);

            const result = await pool.query(
                'INSERT INTO users (email, password_hash, last_login_at) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING id, email, role, auth_version, created_at',
                [email.toLowerCase(), passwordHash]
            );

            const user = result.rows[0];
            const token = generateToken(user);

            res.status(201).json({
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role
                },
                token
            });
        } catch (err) {
            logError('Registration error:', err);
            res.status(500).json({ error: 'Registration failed' });
        }
    });

    /**
     * POST /api/auth/login
     * Authenticate user and return JWT
     */
    router.post('/login', authLimiter, async (req, res) => {
        try {
            const { email, password } = req.body;

            // Validation
            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required' });
            }

            // Find user
            const result = await pool.query(
                'SELECT id, email, password_hash, role, is_active, auth_version FROM users WHERE email = $1',
                [email.toLowerCase()]
            );

            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const user = result.rows[0];

            // Check if user is active
            if (!user.is_active) {
                return res.status(403).json({ error: 'Account is disabled' });
            }

            // Verify password
            const validPassword = await bcrypt.compare(password, user.password_hash);

            if (!validPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            // Update last login timestamp
            await pool.query(
                'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
                [user.id]
            );

            const token = generateToken(user);

            res.json({
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role
                },
                token
            });
        } catch (err) {
            logError('Login error:', err);
            res.status(500).json({ error: 'Login failed' });
        }
    });

    /**
     * GET /api/auth/me
     * Get current user info
     */
    router.get('/me', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT id, email, role, created_at FROM users WHERE id = $1',
                [req.user.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ user: result.rows[0] });
        } catch (err) {
            logError('Get user error:', err);
            res.status(500).json({ error: 'Failed to get user' });
        }
    });

    return router;
};
