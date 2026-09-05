'use strict';
const { decodeCursor, pageLimit, pageResult } = require('./pagination');

function libraryQuery(query, kind, ownerId) {
    const alias = kind === 'track' ? 't' : 'p';
    const sort = query.sort || 'newest';
    const search = query.search || '';
    const filter = query.filter || '';
    if (!['newest', 'oldest', 'title'].includes(sort) || typeof search !== 'string' || search.length > 200 ||
        (filter && !(kind === 'track' ? ['POC', 'DRAFT', 'WIP', 'FINAL'] : ['ALBUM', 'EP', 'SINGLE', 'PLAYLIST']).includes(filter))) {
        throw Object.assign(new Error('Invalid search, filter or sort'), { statusCode: 400 });
    }
    const limit = pageLimit(query.limit);
    const field = sort === 'title' ? 'title' : 'created_at';
    const direction = sort === 'newest' ? 'DESC' : 'ASC';
    const cursor = decodeCursor(query.cursor, [field, 'id', 'scope']);
    const scope = JSON.stringify([kind, ownerId, sort, search, filter]);
    if (cursor && cursor.scope !== scope) throw Object.assign(new Error('Search changed; reload the first page'), { statusCode: 400 });
    const values = [ownerId, `%${search.replace(/[\\%_]/g, '\\$&')}%`, filter || null, cursor?.[field] ?? null, cursor?.id ?? null, limit + 1];
    return {
        values,
        where: `${alias}.owner_id = $1
            AND (${alias}.title ILIKE $2 OR ${alias}.artist ILIKE $2)
            AND ($3::text IS NULL OR ${alias}.${kind === 'track' ? 'status' : 'type'}::text = $3)
            AND ($4::${field === 'title' ? 'text' : 'timestamptz'} IS NULL OR (${alias}.${field}, ${alias}.id) ${sort === 'newest' ? '<' : '>'} ($4, $5::uuid))`,
        order: `${alias}.${field} ${direction}, ${alias}.id ${direction}`,
        page: rows => pageResult(rows, limit, row => ({ [field]: row[field], id: row.id, scope })),
    };
}
module.exports = { libraryQuery };
