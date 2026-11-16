const assert = require('assert');
const { parseRules, verifyLs } = require('../src/lsVerifier');
const defaults = require('../src/lsVerifierRules.json');

suite('LS verifier', () => {
    const literalDefaults = { version: 1, rules: defaults.rules.filter(rule => rule.section === 'MN') };
    const rules = parseRules(JSON.stringify(literalDefaults));
    test('ignores prefixes, blank lines, whitespace, and other sections', () => {
        const text = '/PROG TEST\r\n/ATTR\r\nCOMMENT = "TEST";\r\n/MN\r\n  1: CALL MAIN ;  \r\nanything: ;\r\n 2 : ;\r\n\r\n/POS\r\nP[1]{\r\n/END';
        assert.deepStrictEqual(verifyLs(text, rules), []);
    });
    test('reports missing colon and final semicolon at physical line numbers', () => {
        const issues = verifyLs('/MN\n  1 CALL MAIN ;\n  2: CALL MAIN\n  3: ; trailing\n/END', rules);
        assert.deepStrictEqual(issues.map(issue => [issue.line, issue.code]), [
            [1, 'mn-colon'], [2, 'mn-semicolon'], [3, 'mn-semicolon']
        ]);
    });
    test('accepts robot-wrapped --eg: remarks that end with a semicolon on the last line', () => {
        const text = '/MN\n  1:  --eg: NOTE, During Commitioning I used the Position directly. After\n    :  full run off it maybe ideal\n    :  to switch to the PR[20] = P[1] ;\n  2:  CALL MAIN ;\n/END';
        assert.deepStrictEqual(verifyLs(text, rules), []);
        assert.deepStrictEqual(verifyLs('/MN\n  1:  --eg: one line remark ;\n/END', rules), []);
    });
    test('a line continued on the next ":" line needs no semicolon (circular moves, also commented out)', () => {
        // From a robot-generated program (p01_sand_op20.ls).
        const text = [
            '/MN',
            '  19:  //L P[4] R[34:Bottom Speed]mm/sec CNT100    ;',
            '  20:  //C P[5]    ',
            '    :  P[6] R[34:Bottom Speed]mm/sec CNT100    ;',
            '  21:  C P[8]    ',
            '',
            '    :  P[4] R[34:Bottom Speed]mm/sec CNT100    ;',
            '  22:  //ENDFOR ;',
            '/END'
        ].join('\r\n');
        assert.deepStrictEqual(verifyLs(text, rules), []);
        // Still reported: the continuation line itself without ';', and a missing ';' before a numbered line.
        const issues = verifyLs('/MN\n  20:  C P[5]\n    :  P[6] 100mm/sec CNT100\n  21:  CALL MAIN\n  22:  CALL MAIN ;\n/END', rules);
        assert.deepStrictEqual(issues.map(issue => [issue.line, issue.code]), [[2, 'mn-semicolon'], [3, 'mn-semicolon']]);
    });
    test('requires a leading colon before --eg: remarks', () => {
        for (const line of ['  1  --eg: missing colon ;', '--eg: missing colon ;', '  1  --EG: upper case ;']) {
            assert.deepStrictEqual(verifyLs(`/MN\n${line}\n/END`, rules).map(issue => [issue.line, issue.code]), [[1, 'mn-colon']]);
        }
        const wrapped = verifyLs('/MN\n  1  --eg: wrapped\n    :  rest ;\n/END', rules);
        assert.deepStrictEqual(wrapped.map(issue => [issue.line, issue.code]), [[1, 'mn-colon']]);
    });
    test('reports wrapped remarks that never reach a semicolon', () => {
        const issues = verifyLs('/MN\n  1:  --eg: wrapped\n    :  still open\n  2:  CALL MAIN ;\n  3:  --eg: last\n/END', rules);
        assert.deepStrictEqual(issues.map(issue => [issue.line, issue.code]), [[2, 'mn-semicolon'], [4, 'mn-semicolon']]);
        // Since 2026-11-16 any instruction may continue on a following ':' line (e.g. circular moves);
        // only the last line of the instruction needs ';'.
        assert.deepStrictEqual(verifyLs('/MN\n  1:  CALL MAIN\n    :  more ;\n/END', rules), []);
        assert.deepStrictEqual(verifyLs('/MN\n  1:  CALL MAIN\n    :  more\n/END', rules).map(issue => issue.line), [2]);
    });
    test('reports both failures on malformed lines and missing MN', () => {
        assert.strictEqual(verifyLs('/MN\nbad\n/END', rules).length, 2);
        assert.strictEqual(verifyLs('/PROG TEST\n/END', rules)[0].code, 'missing-mn');
    });
    test('editable rules change checks, messages, and enabled state', () => {
        const custom = JSON.parse(JSON.stringify(literalDefaults));
        custom.rules[0].enabled = false;
        custom.rules[1].value = '!';
        custom.rules[1].message = 'Custom ending';
        const loaded = parseRules(JSON.stringify(custom));
        assert.deepStrictEqual(verifyLs('/MN\nno colon!\n/END', loaded), []);
        assert.strictEqual(verifyLs('/MN\n1: ;\n/END', loaded)[0].message, 'Custom ending');
    });
    test('rejects malformed rule files instead of silently skipping checks', () => {
        for (const text of ['{', 'null', '{}', '{"version":99,"rules":[]}', '{"version":1,"rules":[null]}']) {
            assert.throws(() => parseRules(text));
        }
        const duplicate = { version: 1, rules: [defaults.rules[0], defaults.rules[0]] };
        assert.throws(() => parseRules(JSON.stringify(duplicate)));
        const invalid = { version: 1, rules: [{ ...defaults.rules[0], check: 'execute' }] };
        assert.throws(() => parseRules(JSON.stringify(invalid)));
    });
});
