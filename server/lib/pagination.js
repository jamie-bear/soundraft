'use strict';

function pageLimit(value, fallback = 50, maximum = 100) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, parsed)) : fallback;
}

function encodeCursor(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value, requiredKeys) {
    if (!value) return null;
    try {
        if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid cursor');
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || requiredKeys.some((key) => parsed[key] == null)) {
            throw new Error('missing cursor fields');
        }
        for (const key of requiredKeys) {
            if ((key === 'id' || key.endsWith('_id')) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed[key])) throw new Error('invalid ID');
            if (key.endsWith('_at') && (typeof parsed[key] !== 'string' || !Number.isFinite(Date.parse(parsed[key])))) throw new Error('invalid date');
            if (['sort_order', 'version_number'].includes(key) && (!Number.isSafeInteger(parsed[key]) || parsed[key] < 0)) throw new Error('invalid order');
        }
        return parsed;
    } catch {
        const error = new Error('Invalid pagination cursor');
        error.statusCode = 400;
        throw error;
    }
}

function pageResult(rows, limit, cursorFromRow) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
        items,
        next_cursor: hasMore ? encodeCursor(cursorFromRow(items[items.length - 1])) : null,
    };
}

module.exports = { decodeCursor, encodeCursor, pageLimit, pageResult };
