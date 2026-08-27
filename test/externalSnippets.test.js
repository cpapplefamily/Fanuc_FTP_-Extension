const assert = require('assert');
const {
    normalizeSnippetDefinitions,
    parseSnippetFile,
    PROJECT_SNIPPETS_TEMPLATE,
    USER_SNIPPETS_TEMPLATE
} = require('../src/externalSnippets');

suite('External Fanuc Snippets', () => {
    test('parses VS Code JSONC snippet files', () => {
        const snippets = parseSnippetFile(`{
            // Comments and trailing commas are valid in snippet files.
            "Pulse Output": {
                "prefix": "PULSE",
                "body": [":  PULSE DO[\${1:1}] FOR \${2:0.5}sec ;"],
                "description": "Pulse a digital output",
            },
        }`);

        assert.strictEqual(snippets['Pulse Output'].prefix, 'PULSE');
        assert.strictEqual(snippets['Pulse Output'].body.length, 1);
    });

    test('normalizes multiple prefixes and multiline bodies', () => {
        const definitions = normalizeSnippetDefinitions({
            Wait: {
                prefix: ['WAIT', 'wait-sec'],
                body: [':  WAIT ${1:1}(sec) ;', ':  ;'],
                description: 'Wait for a duration'
            }
        });

        assert.deepStrictEqual(definitions, [
            {
                name: 'Wait',
                prefix: 'WAIT',
                body: ':  WAIT ${1:1}(sec) ;\n:  ;',
                description: 'Wait for a duration'
            },
            {
                name: 'Wait',
                prefix: 'wait-sec',
                body: ':  WAIT ${1:1}(sec) ;\n:  ;',
                description: 'Wait for a duration'
            }
        ]);
    });

    test('skips malformed snippet entries', () => {
        const definitions = normalizeSnippetDefinitions({
            MissingBody: { prefix: 'BAD' },
            MissingPrefix: { body: 'BAD' },
            Valid: { prefix: 'GOOD', body: ':  GOOD ;' }
        });

        assert.strictEqual(definitions.length, 1);
        assert.strictEqual(definitions[0].prefix, 'GOOD');
    });

    test('provides valid managed and project starter files', () => {
        const userDefinitions = normalizeSnippetDefinitions(parseSnippetFile(USER_SNIPPETS_TEMPLATE));
        const projectDefinitions = normalizeSnippetDefinitions(parseSnippetFile(PROJECT_SNIPPETS_TEMPLATE));

        assert.strictEqual(userDefinitions.length, 0);
        assert.strictEqual(projectDefinitions.length, 1);
        assert.strictEqual(projectDefinitions[0].prefix, 'PROJECT_SNIPPET');
    });
});
