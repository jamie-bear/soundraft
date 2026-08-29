'use strict';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
    return UUID_PATTERN.test(value || '');
}

function isResourcePublic(resource, resourceType) {
    return resourceType === 'track'
        ? resource.release_status === 'PUBLIC'
        : resource.is_public === true;
}

function presentedShareToken(resource, identifier, queryToken) {
    if (queryToken) return queryToken;
    return identifier === resource.share_token ? identifier : null;
}

/**
 * Evaluate owner/share access consistently for tracks and playlists.
 * A public flag alone is not authorization: callers must also present the
 * resource's share token. Owners do not need a share token.
 */
function evaluateResourceAccess({ resource, resourceType, identifier, queryToken, user }) {
    const isOwner = Boolean(user && user.id === resource.owner_id);
    if (isOwner) {
        return { allowed: true, level: 'OWNER', isOwner: true };
    }

    const token = presentedShareToken(resource, identifier, queryToken);
    const hasValidShare = Boolean(
        token &&
        resource.share_token &&
        token === resource.share_token &&
        isResourcePublic(resource, resourceType)
    );

    return {
        allowed: hasValidShare,
        level: hasValidShare ? 'SHARE' : null,
        isOwner: false,
        status: user ? 403 : 401,
    };
}

function evaluateEntityAccess({ resource, resourceType, shareToken, user }) {
    return evaluateResourceAccess({
        resource,
        resourceType,
        identifier: resource.id,
        queryToken: shareToken,
        user,
    });
}

module.exports = {
    evaluateEntityAccess,
    evaluateResourceAccess,
    isResourcePublic,
    isUuid,
};
