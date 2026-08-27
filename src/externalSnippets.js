const fs = require('fs');

const USER_SNIPPETS_TEMPLATE = `{
    // Add your Fanuc snippets here. This file is preserved when Robot FTP is updated.
}
`;
const PROJECT_SNIPPETS_TEMPLATE = `{
    // Project-only Fanuc snippets. Add more entries using this same framework.
    "Project Snippet": {
        "scope": "fanuctp",
        "prefix": "PROJECT_SNIPPET",
        "body": [
            ":  $1 ;"
        ],
        "description": "Project-specific Fanuc snippet"
    }
}
`;

function removeJsonComments(text) {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index++) {
        const current = text[index];
        const next = text[index + 1];

        if (inString) {
            result += current;
            if (escaped) {
                escaped = false;
            } else if (current === '\\') {
                escaped = true;
            } else if (current === '"') {
                inString = false;
            }
            continue;
        }

        if (current === '"') {
            inString = true;
            result += current;
            continue;
        }

        if (current === '/' && next === '/') {
            result += '  ';
            index += 2;
            while (index < text.length && text[index] !== '\n' && text[index] !== '\r') {
                result += ' ';
                index++;
            }
            if (index < text.length) {
                result += text[index];
            }
            continue;
        }

        if (current === '/' && next === '*') {
            result += '  ';
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
                result += text[index] === '\n' || text[index] === '\r' ? text[index] : ' ';
                index++;
            }
            if (index < text.length) {
                result += '  ';
                index++;
            }
            continue;
        }

        result += current;
    }

    return result;
}

function removeTrailingCommas(text) {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index++) {
        const current = text[index];

        if (inString) {
            result += current;
            if (escaped) {
                escaped = false;
            } else if (current === '\\') {
                escaped = true;
            } else if (current === '"') {
                inString = false;
            }
            continue;
        }

        if (current === '"') {
            inString = true;
            result += current;
            continue;
        }

        if (current === ',') {
            let lookAhead = index + 1;
            while (lookAhead < text.length && /\s/.test(text[lookAhead])) {
                lookAhead++;
            }
            if (text[lookAhead] === '}' || text[lookAhead] === ']') {
                continue;
            }
        }

        result += current;
    }

    return result;
}

function parseSnippetFile(text) {
    const parsed = JSON.parse(removeTrailingCommas(removeJsonComments(text)));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('The snippet file must contain a JSON object.');
    }
    return parsed;
}

function normalizeSnippetDefinitions(snippets) {
    const definitions = [];

    for (const [name, snippet] of Object.entries(snippets)) {
        if (!snippet || Array.isArray(snippet) || typeof snippet !== 'object') {
            continue;
        }

        const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
        const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;

        if (typeof body !== 'string') {
            continue;
        }

        for (const prefix of prefixes) {
            if (typeof prefix !== 'string' || prefix.length === 0) {
                continue;
            }

            definitions.push({
                name,
                prefix,
                body,
                description: typeof snippet.description === 'string' ? snippet.description : ''
            });
        }
    }

    return definitions;
}

function loadSnippetDefinitions(filePath) {
    const snippets = parseSnippetFile(fs.readFileSync(filePath, 'utf8'));
    return normalizeSnippetDefinitions(snippets);
}

module.exports = {
    PROJECT_SNIPPETS_TEMPLATE,
    USER_SNIPPETS_TEMPLATE,
    loadSnippetDefinitions,
    normalizeSnippetDefinitions,
    parseSnippetFile
};
