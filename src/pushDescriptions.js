const http = require('http');

/**
 * Sends I/O and register comments to a robot through the controller's built-in KAREL web program ComSet:
 *
 *   GET http://<robot>/karel/ComSet?sComment=<text>&sIndx=<n>&sFc=<code>
 *
 * ComSet ships with the controller (it backs the web Comment Tool); the KAREL option is not needed.
 * The robot must allow KAREL over HTTP: Setup > Host Comm > HTTP, KAREL entry unlocked.
 * Codes from onerobotics/comtool. UI and UO comments cannot be set this way.
 */
const COMSET_CODES = {
    R: 1, PR: 3, RI: 6, RO: 7, DI: 8, DO: 9, GI: 10, GO: 11, AI: 12, AO: 13, SR: 14, F: 19
};

const KEY = /^([A-Z]+)\[(\d+)\]$/;

/** { type, index, code } for a description key, or undefined when ComSet cannot set it. */
function comSetTarget(key) {
    const match = KEY.exec(key);
    const code = match && COMSET_CODES[match[1]];
    return code ? { type: match[1], index: Number(match[2]), code } : undefined;
}

/**
 * Compares the local descriptions (Map key → text) with the robot's current comments (Map key → text).
 * Only keys present locally are considered; robot comments with no local row are left alone.
 * Returns { send: [{ key, text, current, code, index }], unsupported: [key], unchanged }.
 */
function planDescriptionPush(local, robot) {
    const send = [];
    const unsupported = [];
    let unchanged = 0;
    for (const [key, text] of local) {
        const current = robot.get(key);
        if (current === text) {
            unchanged++;
            continue;
        }
        const target = comSetTarget(key);
        if (!target) {
            unsupported.push(key);
            continue;
        }
        send.push({ key, text, current, code: target.code, index: target.index });
    }
    return { send, unsupported, unchanged };
}

function comSetUrl(host, port, item) {
    const portText = port && port !== 80 ? `:${port}` : '';
    return `http://${host}${portText}/karel/ComSet?sComment=${encodeURIComponent(item.text)}&sIndx=${item.index}&sFc=${item.code}`;
}

const UNLOCK_HINT = 'On the robot, unlock KAREL for HTTP: Setup > Host Comm > HTTP, set KAREL to unlocked.';

/**
 * The error a ComSet response means, or undefined when it worked.
 * A locked robot answers 200 with a "krlerrN" page ("Protected feature"), so the body is checked too.
 */
function comSetError(statusCode, body) {
    if (statusCode === 401 || statusCode === 403) {
        return `The robot refused the request (HTTP ${statusCode}). ${UNLOCK_HINT}`;
    }
    if (statusCode !== 200) {
        return `The robot answered HTTP ${statusCode}.`;
    }
    if (/<title>\s*krlerr/i.test(body || '')) {
        const message = String(body).replace(/<[^>]*>/g, ' ').replace(/krlerr\d*/gi, ' ').replace(/\s+/g, ' ').trim();
        const locked = /protected/i.test(message) ? ` ${UNLOCK_HINT}` : '';
        return `The robot answered: ${message || 'KAREL error'}.${locked}`;
    }
    return undefined;
}

/** Sends one comment. Resolves undefined on success, or an error message. */
function sendComment(host, port, item, timeoutMs = 5000, get = http.get) {
    return new Promise(resolve => {
        const request = get(comSetUrl(host, port, item), { timeout: timeoutMs }, response => {
            let body = '';
            response.setEncoding('latin1');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve(comSetError(response.statusCode, body)));
            response.on('error', error => resolve(error.message));
        });
        request.on('timeout', () => request.destroy(new Error(`No answer from http://${host}${port && port !== 80 ? `:${port}` : ''} after ${timeoutMs} ms. Check the robot's web server and HTTP port.`)));
        request.on('error', error => resolve(error.message));
    });
}

module.exports = {
    COMSET_CODES,
    comSetTarget,
    planDescriptionPush,
    comSetUrl,
    comSetError,
    sendComment
};
