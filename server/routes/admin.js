const express = require('express');
const { requireAuthAdmin } = require('../middleware/admin');

const router = express.Router();

module.exports = function(pool) {
    // Apply admin middleware to all routes
    router.use(requireAuthAdmin);

    /**
     * GET /api/admin/users
     * List all users with stats
     */
    router.get('/users', async (req, res) => {
        try {
            const { search } = req.query;
            // V10: Parse and clamp pagination params to prevent abuse
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
            const offset = (page - 1) * limit;

            let query = `
                SELECT 
                    u.id,
                    u.email,
                    u.role,
                    u.is_active,
                    u.last_login_at,
                    u.created_at,
                    COUNT(DISTINCT t.id) as track_count,
                    COUNT(DISTINCT p.id) as playlist_count,
                    COALESCE(SUM(tv.size_bytes), 0) + COALESCE(SUM(a.size_bytes), 0) as total_storage_bytes
                FROM users u
                LEFT JOIN tracks t ON t.owner_id = u.id
                LEFT JOIN playlists p ON p.owner_id = u.id
                LEFT JOIN track_versions tv ON tv.track_id = t.id
                LEFT JOIN attachments a ON a.track_id = t.id
            `;

            const params = [];
            
            if (search) {
                query += ` WHERE u.email ILIKE $1`;
                params.push(`%${search}%`);
            }

            query += `
                GROUP BY u.id
                ORDER BY u.created_at DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `;
            params.push(limit, offset);

            const result = await pool.query(query, params);

            // Get total count
            let countQuery = 'SELECT COUNT(*) FROM users';
            const countParams = [];
            if (search) {
                countQuery += ' WHERE email ILIKE $1';
                countParams.push(`%${search}%`);
            }
            const countResult = await pool.query(countQuery, countParams);

            res.json({
                users: result.rows,
                total: parseInt(countResult.rows[0].count),
                page: parseInt(page),
                limit: parseInt(limit)
            });
        } catch (err) {
            console.error('Admin list users error:', err);
            res.status(500).json({ error: 'Failed to list users' });
        }
    });

    /**
     * GET /api/admin/users/:id
     * Get single user details
     */
    router.get('/users/:id', async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT 
                    u.id,
                    u.email,
                    u.role,
                    u.is_active,
                    u.last_login_at,
                    u.created_at,
                    COUNT(DISTINCT t.id) as track_count,
                    COUNT(DISTINCT p.id) as playlist_count,
                    COALESCE(SUM(tv.size_bytes), 0) + COALESCE(SUM(a.size_bytes), 0) as total_storage_bytes
                FROM users u
                LEFT JOIN tracks t ON t.owner_id = u.id
                LEFT JOIN playlists p ON p.owner_id = u.id
                LEFT JOIN track_versions tv ON tv.track_id = t.id
                LEFT JOIN attachments a ON a.track_id = t.id
                WHERE u.id = $1
                GROUP BY u.id
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ user: result.rows[0] });
        } catch (err) {
            console.error('Admin get user error:', err);
            res.status(500).json({ error: 'Failed to get user' });
        }
    });

    /**
     * PUT /api/admin/users/:id
     * Update user role or status
     */
    router.put('/users/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { role, is_active } = req.body;

            // Prevent admin from modifying themselves
            if (id === req.user.id) {
                return res.status(400).json({ error: 'Cannot modify your own account' });
            }

            // Validate role if provided
            if (role && !['USER', 'ADMIN'].includes(role)) {
                return res.status(400).json({ error: 'Invalid role' });
            }

            const result = await pool.query(`
                UPDATE users
                SET 
                    role = COALESCE($1, role),
                    is_active = COALESCE($2, is_active)
                WHERE id = $3
                RETURNING id, email, role, is_active, created_at
            `, [role, is_active, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ user: result.rows[0] });
        } catch (err) {
            console.error('Admin update user error:', err);
            res.status(500).json({ error: 'Failed to update user' });
        }
    });

    /**
     * DELETE /api/admin/users/:id
     * Delete user and all their content
     */
    router.delete('/users/:id', async (req, res) => {
        try {
            const { id } = req.params;

            // Prevent admin from deleting themselves
            if (id === req.user.id) {
                return res.status(400).json({ error: 'Cannot delete your own account' });
            }

            const result = await pool.query(
                'DELETE FROM users WHERE id = $1 RETURNING id',
                [id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ success: true });
        } catch (err) {
            console.error('Admin delete user error:', err);
            res.status(500).json({ error: 'Failed to delete user' });
        }
    });

    /**
     * GET /api/admin/stats
     * Get system-wide statistics
     */
    router.get('/stats', async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT
                    (SELECT COUNT(*) FROM users) as total_users,
                    (SELECT COUNT(*) FROM users WHERE is_active = true) as active_users,
                    (SELECT COUNT(*) FROM users WHERE role = 'ADMIN') as admin_count,
                    (SELECT COUNT(*) FROM tracks) as total_tracks,
                    (SELECT COUNT(*) FROM playlists) as total_playlists,
                    (SELECT COALESCE(SUM(size_bytes), 0) FROM track_versions) as audio_storage_bytes,
                    (SELECT COALESCE(SUM(size_bytes), 0) FROM attachments) as attachment_storage_bytes
            `);

            const row = stats.rows[0];
            
            res.json({
                users: {
                    total: parseInt(row.total_users),
                    active: parseInt(row.active_users),
                    admins: parseInt(row.admin_count)
                },
                content: {
                    tracks: parseInt(row.total_tracks),
                    playlists: parseInt(row.total_playlists)
                },
                storage: {
                    audio: parseInt(row.audio_storage_bytes),
                    attachments: parseInt(row.attachment_storage_bytes),
                    total: parseInt(row.audio_storage_bytes) + parseInt(row.attachment_storage_bytes)
                }
            });
        } catch (err) {
            console.error('Admin stats error:', err);
            res.status(500).json({ error: 'Failed to get stats' });
        }
    });

    /**
     * GET /api/admin/settings
     * Get all system settings
     */
    router.get('/settings', async (req, res) => {
        try {
            const result = await pool.query('SELECT key, value FROM system_settings');
            
            // Convert to object
            const settings = {};
            for (const row of result.rows) {
                settings[row.key] = row.value;
            }

            // Don't expose SMTP password
            if (settings.smtp_password) {
                settings.smtp_password = settings.smtp_password ? '********' : '';
            }

            res.json({ settings });
        } catch (err) {
            console.error('Admin get settings error:', err);
            res.status(500).json({ error: 'Failed to get settings' });
        }
    });

    /**
     * PUT /api/admin/settings
     * Update system settings
     */
    router.put('/settings', async (req, res) => {
        try {
            const { settings } = req.body;

            if (!settings || typeof settings !== 'object') {
                return res.status(400).json({ error: 'Settings object required' });
            }

            const allowedKeys = [
                'signups_enabled',
                'smtp_host',
                'smtp_port',
                'smtp_user',
                'smtp_password',
                'smtp_from_email',
                'smtp_from_name'
            ];

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                for (const [key, value] of Object.entries(settings)) {
                    if (!allowedKeys.includes(key)) continue;
                    
                    // Skip password update if it's the masked value
                    if (key === 'smtp_password' && value === '********') continue;

                    await client.query(`
                        INSERT INTO system_settings (key, value, updated_at)
                        VALUES ($1, $2, CURRENT_TIMESTAMP)
                        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
                    `, [key, value]);
                }

                await client.query('COMMIT');
                res.json({ success: true });
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        } catch (err) {
            console.error('Admin update settings error:', err);
            res.status(500).json({ error: 'Failed to update settings' });
        }
    });

    /**
     * GET /api/admin/invitations
     * List pending invitations
     */
    router.get('/invitations', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT 
                    i.id,
                    i.email,
                    i.expires_at,
                    i.created_at,
                    i.accepted_at,
                    u.email as invited_by_email
                FROM user_invitations i
                LEFT JOIN users u ON i.invited_by = u.id
                ORDER BY i.created_at DESC
            `);

            res.json({ invitations: result.rows });
        } catch (err) {
            console.error('Admin list invitations error:', err);
            res.status(500).json({ error: 'Failed to list invitations' });
        }
    });

    /**
     * POST /api/admin/invitations
     * Create a new invitation
     */
    router.post('/invitations', async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({ error: 'Email is required' });
            }

            // Check if user already exists
            const existing = await pool.query(
                'SELECT id FROM users WHERE email = $1',
                [email.toLowerCase()]
            );

            if (existing.rows.length > 0) {
                return res.status(400).json({ error: 'User with this email already exists' });
            }

            // Generate token and expiry (7 days)
            const token = require('crypto').randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

            const result = await pool.query(`
                INSERT INTO user_invitations (email, token, invited_by, expires_at)
                VALUES ($1, $2, $3, $4)
                RETURNING id, email, token, expires_at, created_at
            `, [email.toLowerCase(), token, req.user.id, expiresAt]);

            res.status(201).json({ invitation: result.rows[0] });
        } catch (err) {
            console.error('Admin create invitation error:', err);
            res.status(500).json({ error: 'Failed to create invitation' });
        }
    });

    /**
     * DELETE /api/admin/invitations/:id
     * Revoke an invitation
     */
    router.delete('/invitations/:id', async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(
                'DELETE FROM user_invitations WHERE id = $1 RETURNING id',
                [id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Invitation not found' });
            }

            res.json({ success: true });
        } catch (err) {
            console.error('Admin delete invitation error:', err);
            res.status(500).json({ error: 'Failed to delete invitation' });
        }
    });

    return router;
};
