const assert = require('assert');
const path = require('path');
const { validateProgramName, validateProgramComment, findProgramName, findProgramComment, createRenameLsCommand } = require('../src/renameLs');

suite('Rename LS program', () => {
    test('validates optional comments using the 16-character limit and permitted characters', () => {
        for (const value of ['', 'Pick_1@*', 'has space', ' PICK PART ', 'A'.repeat(16)]) {
            assert.strictEqual(validateProgramComment(value), undefined);
        }
        for (const value of ['A'.repeat(17), 'A'.repeat(16) + ' ', '"', ';', '\n', '\t', 'é']) {
            assert.ok(validateProgramComment(value));
        }
    });

    test('updates only the ATTR comment and inserts missing comments with matching line endings', () => {
        for (const eol of ['\n', '\r\n']) {
            const text = ['/PROG OLD', '/ATTR', 'COMMENT = "OLD";', '/MN', '1: ! OLD ;', '/END'].join(eol);
            const field = findProgramComment(text);
            assert.strictEqual(field.value, 'OLD');
            assert.strictEqual(text.slice(0, field.start) + field.replacement('NEW') + text.slice(field.end), text.replace('"OLD"', '"NEW"'));
            const missing = ['/PROG OLD', '/ATTR', '/MN', '/END'].join(eol);
            const insertion = findProgramComment(missing);
            assert.strictEqual(insertion.replacement(''), `COMMENT = "";${eol}`);
        }
        assert.throws(() => findProgramComment('/PROG OLD\n/END'), /no \/ATTR/);
        assert.throws(() => findProgramComment('/ATTR\nCOMMENT = broken;\n/MN'), /malformed/);
    });

    test('cancelling or failing comment validation leaves the file untouched', async () => {
        for (const comment of [null, 'A'.repeat(17), 'BAD;']) {
            const { calls, run } = fixture({ comment });
            await run();
            assert.deepStrictEqual(calls.edits, []);
            assert.strictEqual(calls.saves, 0);
        }
    });
    test('validates length, characters, and reserved names', () => {
        for (const name of ['MAIN', 'pick_1', '_TEST', 'A'.repeat(36)]) {
            assert.strictEqual(validateProgramName(name), undefined, name);
        }
        for (const name of ['', 'A'.repeat(37), '1MAIN', 'A B', 'A-B', 'A.LS', '../A', 'A\n', 'é', 'con', 'COM9', 'LPT1', 'PRN', 'AUX', 'NUL']) {
            assert.ok(validateProgramName(name), name);
        }
    });

    test('finds only the header name, preserving BOM, comments, and line endings', () => {
        const text = '\uFEFF/PROG  OLD  COMMENT\r\n/ATTR\r\n/MN\r\n  1: CALL OLD ;\r\n/END\r\n';
        const { start, end } = findProgramName(text);
        assert.strictEqual(text.slice(0, start) + 'NEW' + text.slice(end), text.replace('OLD  COMMENT', 'NEW  COMMENT'));
        assert.throws(() => findProgramName('/MN\n/END'), /no \/PROG header/);
    });

    function fixture({ answer = 'NEW', comment = 'PICK_1', entries = [], dirty = false, apply = true, save = true } = {}) {
        const calls = { edits: [], errors: [], saves: 0 };
        const uri = { path: '/programs/OLD.LS' };
        const document = {
            isDirty: dirty,
            getText: () => '/PROG OLD\r\n/ATTR\r\nCOMMENT = "OLD";\r\n/MN\r\n/END\r\n',
            positionAt: offset => offset,
            save: async () => { calls.saves++; return save; }
        };
        const vscode = {
            window: {
                showInputBox: async options => { const value = options.title === 'Rename LS File' ? answer : comment; return value === null ? undefined : value; },
                showErrorMessage: message => calls.errors.push(message),
                showInformationMessage: () => {}
            },
            Uri: { joinPath: (base, ...parts) => ({ path: path.posix.join(base.path, ...parts) }) },
            Range: class { constructor(start, end) { this.start = start; this.end = end; } },
            WorkspaceEdit: class {
                replace(...args) { calls.edits.push(['replace', ...args]); }
                renameFile(...args) { calls.edits.push(['rename', ...args]); }
            },
            workspace: {
                openTextDocument: async () => document,
                fs: { readDirectory: async () => entries },
                applyEdit: async () => apply
            }
        };
        return { calls, run: () => createRenameLsCommand(vscode, { appendLine() {} })(uri) };
    }

    test('renames the file and header together, then saves', async () => {
        const { calls, run } = fixture({ comment: 'PICK PART' });
        await run();
        assert.deepStrictEqual(calls.errors, []);
        assert.strictEqual(calls.edits[0][3], 'NEW');
        assert.strictEqual(calls.edits[1][3], 'PICK PART');
        assert.strictEqual(calls.edits[2][2].path, '/programs/NEW.LS');
        assert.deepStrictEqual(calls.edits[2][3], { overwrite: false, ignoreIfExists: false });
        assert.strictEqual(calls.saves, 1);
    });

    test('cancellation and unchanged names do not edit', async () => {
        for (const answer of [null, 'OLD']) {
            const { calls, run } = fixture({ answer });
            await run();
            assert.deepStrictEqual(calls.edits, []);
        }
    });

    test('blocks dirty files, invalid names, and case-insensitive collisions', async () => {
        for (const options of [{ dirty: true }, { answer: '1BAD' }, { entries: [['new.ls', 1]] }]) {
            const { calls, run } = fixture(options);
            await run();
            assert.strictEqual(calls.errors.length, 1);
            assert.deepStrictEqual(calls.edits, []);
        }
    });

    test('reports edit and save failures', async () => {
        for (const options of [{ apply: false }, { save: false }]) {
            const { calls, run } = fixture(options);
            await run();
            assert.strictEqual(calls.errors.length, 1);
        }
    });
});
