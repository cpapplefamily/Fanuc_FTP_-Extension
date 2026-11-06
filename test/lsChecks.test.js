const assert = require('assert');
const { parseRules, verifyLs, upgradeRules } = require('../src/lsVerifier');
const defaults = require('../src/lsVerifierRules.json');
const all = parseRules(JSON.stringify(defaults));
const advanced = all.filter(rule => !rule.section);
const program = (mn, pos = '') => `/PROG MAIN\n/ATTR\nCOMMENT = "MAIN";\n/APPL\n/MN\n${mn}\n${pos ? '/POS\n' + pos + '\n' : ''}/END`;
const check = (text, options = {}) => verifyLs(text, advanced, { fileName: 'MAIN.LS', ...options });

suite('LS advanced checks', () => {
    test('requires APPL and accepts repeated robot-generated APPL headers before MN', () => {
        assert.deepStrictEqual(check(program('')), []);
        assert.deepStrictEqual(check(program('').replace('/APPL', '/APPL\n/APPL')), []);
        const missing = check(program('').replace('/APPL\n', ''));
        assert.strictEqual(missing.length, 1);
        assert.ok(missing[0].message.includes('Missing /APPL'));
        for (const text of [
            program('').replace('/ATTR', '/APPL\n/ATTR'),
            program('').replace('/MN', '/MN\n/APPL')
        ]) {
            const issues = check(text);
            assert.strictEqual(issues.length, 1);
            assert.ok(issues[0].message.includes('/APPL must appear between /ATTR and /MN'));
        }
    });
    test('accepts valid labels, positions, motion, local calls and register references', () => {
        const text = program('arbitrary J: P[1:Home] 50% FINE ;\n 90: L PR[R[1]] R[2]mm/sec CNT R[3] ;\n1: LBL[10:Start] ;\n1: IF R[1]=0,JMP LBL[10] ;\n3: CALL SUB ;\n4: CALL SR[1] ;', 'P[1:Home]{\n};');
        assert.deepStrictEqual(check(text, { localPrograms: ['SUB'] }), []);
    });
    test('checks required sections, order, duplicate sections and content after END', () => {
        for (const text of ['/PROG MAIN\n/MN\n/END', '/ATTR\n/PROG MAIN\n/MN\n/END', '/PROG MAIN\n/ATTR\n/MN\n/MN\n/END', program('') + '\n/MN']) {
            assert.ok(check(text).some(issue => issue.code === 'sections'));
        }
        assert.deepStrictEqual(check(program('')), []);
    });
    test('validates program name and case-insensitive filename match', () => {
        assert.ok(check(program('').replace('/PROG MAIN', '/PROG 1BAD')).some(issue => issue.code === 'programName'));
        assert.ok(check(program(''), { fileName: 'OTHER.ls' }).some(issue => issue.code === 'programName'));
        assert.deepStrictEqual(check(program(''), { fileName: 'main.ls' }), []);
    });
    test('reports unbalanced delimiters but ignores comment and string contents', () => {
        assert.deepStrictEqual(check(program('1: ! CALL MISSING [ ( " ;\n2: MESSAGE["JMP LBL[99] ("] ;\n3: LBL[1:Operator\'s home] ;')), []);
        for (const line of ['1: R[1=2 ;', '1: IF (R[1]=2,JMP LBL[1] ;', '1: MESSAGE["oops] ;', '1: R[1)=0 ;']) {
            assert.ok(check(program(line)).some(issue => issue.code === 'delimiters'));
        }
    });
    test('finds duplicate labels and missing static jump targets, excluding indirect jumps', () => {
        const issues = check(program('1: LBL[1] ;\n2: LBL[01] ;\n3: JMP LBL[9] ;\n4: JMP LBL[R[1]] ;'));
        assert.strictEqual(issues.filter(issue => issue.code === 'labels').length, 2);
    });
    test('checks P definitions but leaves PR and indirect P references unresolved', () => {
        const issues = check(program('1: R[1]=P[9,1] ;\n2: PR[99]=P[2] ;\n3: PR[1]=P[R[1]] ;', 'P[2]{\n};'));
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].code, 'positions');
        assert.ok(check(program('1: PR[1]=P[9] ;')).some(issue => issue.code === 'positions'));
    });
    test('flags missing motion fields and accepts multi-line circular moves', () => {
        const issues = check(program('1: J ;\n2: L PR[1] ;'));
        assert.strictEqual(issues.filter(issue => issue.code === 'motion').length, 5);
        assert.ok(issues.every(issue => issue.severity === 'warning'));
        assert.deepStrictEqual(check(program('1 C: PR[1]\n2: PR[2] 100mm/sec CNT100 ;')), []);
    });
    test('missing local calls are warnings, case-insensitive, and skip indirect targets', () => {
        const issues = check(program('1: CALL sub ;\n2: RUN MISSING ;\n3: CALL SR[1] ;\n4: ! CALL OTHER ;'), { localPrograms: ['SUB'] });
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].severity, 'warning');
        assert.strictEqual(issues[0].code, 'calls');
    });
    test('disabled checks and severity overrides are respected', () => {
        const rules = advanced.map(rule => ({ ...rule, enabled: rule.check === 'calls', severity: 'error' }));
        const issues = verifyLs(program('1: CALL MISSING ;\n2: JMP LBL[99] ;'), rules, { localPrograms: [] });
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0].severity, 'error');
    });
    test('upgrades old rules once without replacing custom rules or disabled settings', () => {
        const old = { version: 1, rules: [{ ...defaults.rules[0], enabled: false, message: 'Custom' }] };
        const upgraded = upgradeRules(JSON.stringify(old));
        const config = JSON.parse(upgraded);
        assert.deepStrictEqual(config.rules[0], old.rules[0]);
        assert.strictEqual(config.rules.length, 8);
        assert.strictEqual(upgradeRules(upgraded), undefined);
        assert.strictEqual(parseRules(upgraded).length, 8);
    });
});
