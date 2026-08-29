'use strict';

/**
 * Normalize user-provided plaintext before persistence.
 * React escapes rendered text, but keeping markup out of plaintext fields also
 * protects non-React consumers such as Open Graph and export renderers.
 */
function sanitizeText(input) {
    if (typeof input !== 'string') return input;
    return input.replace(/<[^>]*>/g, '').trim();
}

module.exports = { sanitizeText };
