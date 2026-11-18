const assert = require('assert');
const { parseRules, verifyLs, upgradeRules, pendingDefaultChanges, applyDefaultChanges, DEFAULTS_REVISION } = require('../src/lsVerifier');
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
    test('ignores code-like text inside wrapped --eg: remarks', () => {
        const text = program('  1:  --eg: NOTE, switch to the PR[20] = P[1]\n    :  then JMP LBL[9] and CALL NOPE ( ;\n  2:  CALL SUB ;');
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
    test('"!" is a remark only at the start of a statement; elsewhere it is NOT', () => {
        // Lines from robot-generated files that were wrongly reported as unclosed brackets.
        assert.deepStrictEqual(check(program('  18:  WAIT (!DO[110:OFF:Pallet IN Pos])    ;\n   2:  IF (!DI[1: * :System Air Pressure]) THEN ;\n   3:  ENDIF ;')), []);
        assert.ok(check(program('1: IF (!DI[1] ;')).some(issue => issue.code === 'delimiters'), 'a real unclosed parenthesis after ! is still found');
        assert.deepStrictEqual(check(program('  4:  !Open ( the [ gripper ;')), []);
    });
    test('finds duplicate labels and missing static jump targets, excluding indirect jumps', () => {
        const issues = check(program('1: LBL[1] ;\n2: LBL[01] ;\n3: JMP LBL[9] ;\n4: JMP LBL[R[1]] ;'));
        assert.deepStrictEqual(issues.map(issue => [issue.code, issue.message]), [
            ['labels', 'LS labels: Duplicate LBL[1].'],
            ['jumpTargets', 'LS jump targets: JMP LBL[9] has no matching label.']
        ]);
    });
    test('extraColon: a second ":" after the line number is an error', () => {
        // From p01_place_conveyor.ls: the Header snippet inserted after an existing "1: ".
        const issues = check(program('   1: :!------------------------ ;\n   :  !-----MAIN PROGRAM----- ;'));
        assert.deepStrictEqual(issues.map(issue => [issue.code, issue.line, issue.severity]), [['extraColon', 5, 'critical']]);
        assert.match(issues[0].message, /^LS extra colon: Only one ":" may follow the line number/);
        for (const line of ['  2::  CALL MAIN ;', '  3:   : CALL MAIN ;']) {
            assert.deepStrictEqual(check(program(line)).map(issue => issue.code), ['extraColon'], line);
        }
        // Not flagged: continuation lines, unnumbered statements, colons inside the statement, --eg: remarks.
        const fine = [
            '  20:  C P[5]    ',
            '    :  P[6] 100mm/sec CNT100    ;',
            '   :  !-----MAIN PROGRAM----- ;',
            '  4:  LBL[1:Start] ;',
            '  5:  JMP LBL[1] ;',
            '  6:  IF DI[1: * :Ready]=ON,CALL MAIN ;',
            '  7:  --eg: Note: two colons : here ;'
        ].join('\n');
        assert.deepStrictEqual(check(program(fine, 'P[5]{\n};\nP[6]{\n};'), { localPrograms: ['MAIN'] }), []);
    });
    test('critical severity: accepted in rules, reported on issues, default for extraColon and delimiters', () => {
        const byId = Object.fromEntries(defaults.rules.map(rule => [rule.id, rule.severity]));
        assert.strictEqual(byId.extraColon, 'critical');
        assert.strictEqual(byId.delimiters, 'critical');
        assert.strictEqual(byId.jumpTargets, 'error');
        const issues = check(program('   1: :!---- ;\n   2:  R[1=2 ;\n   3:  JMP LBL[9] ;'));
        assert.deepStrictEqual(issues.map(issue => [issue.code, issue.severity]), [
            ['extraColon', 'critical'], ['delimiters', 'critical'], ['jumpTargets', 'error']
        ]);
        const literal = { version: 4, rules: [{ ...defaults.rules[1], severity: 'critical' }] };
        assert.strictEqual(verifyLs('/MN\n  1: CALL MAIN\n/END', parseRules(JSON.stringify(literal)))[0].severity, 'critical');
        assert.throws(() => parseRules(JSON.stringify({ version: 4, rules: [{ ...defaults.rules[1], severity: 'fatal' }] })));
    });
    test('changed defaults are offered only for rules that still have the old default, once per revision', () => {
        const withSeverity = (overrides) => JSON.stringify({ version: defaults.version, rules: defaults.rules.map(rule => rule.id in overrides ? { ...rule, severity: overrides[rule.id] } : rule) });
        // A 0.9.6-era file: both still "error" (the old default) → both offered.
        const old = withSeverity({ extraColon: 'error', delimiters: 'error' });
        assert.deepStrictEqual(pendingDefaultChanges(old).map(change => [change.id, change.from, change.to]), [
            ['delimiters', 'error', 'critical'], ['extraColon', 'error', 'critical']
        ]);
        // A rule the user set themselves is never offered; an already-current file has nothing to offer.
        assert.deepStrictEqual(pendingDefaultChanges(withSeverity({ extraColon: 'warning', delimiters: 'error' })).map(change => change.id), ['delimiters']);
        assert.deepStrictEqual(pendingDefaultChanges(JSON.stringify(defaults)), []);
        // Already asked for this revision → nothing.
        assert.deepStrictEqual(pendingDefaultChanges(old, DEFAULTS_REVISION), []);
        // Applying changes only the chosen rules and keeps everything else.
        const custom = JSON.parse(withSeverity({ extraColon: 'error', delimiters: 'error', jumpTargets: 'warning' }));
        custom.rules.find(rule => rule.id === 'labels').message = 'My labels:';
        const applied = JSON.parse(applyDefaultChanges(JSON.stringify(custom), pendingDefaultChanges(JSON.stringify(custom)).filter(change => change.id === 'extraColon')));
        const byId = Object.fromEntries(applied.rules.map(rule => [rule.id, rule]));
        assert.strictEqual(byId.extraColon.severity, 'critical');
        assert.strictEqual(byId.delimiters.severity, 'error');
        assert.strictEqual(byId.jumpTargets.severity, 'warning');
        assert.strictEqual(byId.labels.message, 'My labels:');
    });
    test('version 3 rules gain extraColon after delimiters', () => {
        const v3 = { version: 3, rules: defaults.rules.filter(rule => rule.check !== 'extraColon') };
        const upgraded = JSON.parse(upgradeRules(JSON.stringify(v3)));
        assert.deepStrictEqual(upgraded.rules.map(rule => rule.check), defaults.rules.map(rule => rule.check));
        assert.strictEqual(upgraded.version, defaults.version);
    });
    test('jumpTargets has its own severity and on/off setting, separate from labels', () => {
        const text = program('1: LBL[1] ;\n2: LBL[1] ;\n10: JMP LBL[404] ;');
        const withSeverity = severity => advanced.map(rule => rule.check === 'jumpTargets' ? { ...rule, severity } : rule);
        const asWarning = verifyLs(text, withSeverity('warning'), { fileName: 'MAIN.LS' });
        assert.deepStrictEqual(asWarning.map(issue => [issue.code, issue.severity]), [['labels', 'error'], ['jumpTargets', 'warning']]);
        const off = advanced.map(rule => rule.check === 'jumpTargets' ? { ...rule, enabled: false } : rule);
        assert.deepStrictEqual(verifyLs(text, off, { fileName: 'MAIN.LS' }).map(issue => issue.code), ['labels']);
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
        const expected = 1 + advanced.length; // the user's own rule plus every advanced check
        assert.strictEqual(config.rules.length, expected);
        assert.strictEqual(config.version, defaults.version);
        assert.strictEqual(upgradeRules(upgraded), undefined);
        assert.strictEqual(parseRules(upgraded).length, expected);
    });
    test('version 2 rules gain jumpTargets right after labels, keeping the labels setting', () => {
        const v2rules = defaults.rules.filter(rule => rule.check !== 'jumpTargets')
            .map(rule => rule.check === 'labels' ? { ...rule, severity: 'warning', message: 'My labels:' } : rule);
        const upgraded = JSON.parse(upgradeRules(JSON.stringify({ version: 2, rules: v2rules })));
        assert.strictEqual(upgraded.version, defaults.version);
        const labels = upgraded.rules.findIndex(rule => rule.check === 'labels');
        assert.deepStrictEqual(upgraded.rules[labels], { ...defaults.rules.find(rule => rule.check === 'labels'), severity: 'warning', message: 'My labels:' });
        assert.deepStrictEqual(upgraded.rules[labels + 1], { id: 'jumpTargets', enabled: true, check: 'jumpTargets', severity: 'warning', message: 'LS jump targets:' });
        assert.strictEqual(upgraded.rules.length, defaults.rules.length);

        const disabled = v2rules.map(rule => rule.check === 'labels' ? { ...rule, enabled: false } : rule);
        const upgradedDisabled = JSON.parse(upgradeRules(JSON.stringify({ version: 2, rules: disabled })));
        assert.strictEqual(upgradedDisabled.rules.find(rule => rule.check === 'jumpTargets').enabled, false);
    });

    test('descriptions: warns about inline comments that differ from the descriptions, on the key only', () => {
        const descriptions = new Map([['DO[5]', 'Spare'], ['PR[15]', 'Tool Offset Rotate'], ['DO[17]', 'Gripper Open']]);
        const text = program([
            '   1:  DO[5:Clamp Closed]=ON ;',
            '   2:  PR[15:Tool Offset Ro]=LPOS ;',
            '   3:  DO[17: * :Gripper Open]=OFF ;',
            '   4:  R[10:New Count]=0 ;',
            '   5:  !DO[5:in a remark] ;'
        ].join('\n'));
        const issues = check(text, { descriptions }).filter(issue => issue.code === 'descriptions');
        assert.deepStrictEqual(issues.map(issue => [issue.line, issue.severity, text.split('\n')[issue.line].slice(issue.start, issue.end)]), [
            [5, 'warning', 'DO[5:Clamp Closed]'],
            [8, 'warning', 'R[10:New Count]']
        ]);
        assert.match(issues[0].message, /^LS descriptions: DO\[5\] comment "Clamp Closed" differs from its description "Spare"/);
        assert.match(issues[1].message, /R\[10\] comment "New Count" is not in the descriptions/);
        // No descriptions for the project → nothing to compare with.
        assert.deepStrictEqual(check(text, { descriptions: new Map() }).filter(issue => issue.code === 'descriptions'), []);
        assert.deepStrictEqual(check(text).filter(issue => issue.code === 'descriptions'), []);
    });

    test('descriptions: severity comes from the rules file', () => {
        const asError = advanced.map(rule => rule.check === 'descriptions' ? { ...rule, severity: 'error' } : rule);
        const issues = verifyLs(program('   1:  DO[5:Clamp]=ON ;'), asError, { fileName: 'MAIN.LS', descriptions: new Map([['DO[5]', 'Spare']]) })
            .filter(issue => issue.code === 'descriptions');
        assert.deepStrictEqual(issues.map(issue => issue.severity), ['error']);
    });

    test('upgrading version 4 rules adds the descriptions check as a warning, keeping the user\'s rules', () => {
        const v4 = { version: 4, rules: defaults.rules.filter(rule => rule.check !== 'descriptions').map(rule => rule.id === 'motion' ? { ...rule, severity: 'error' } : rule) };
        const upgraded = JSON.parse(upgradeRules(JSON.stringify(v4)));
        assert.strictEqual(upgraded.version, defaults.version);
        assert.deepStrictEqual(upgraded.rules.find(rule => rule.check === 'descriptions'),
            { id: 'descriptions', enabled: true, check: 'descriptions', severity: 'warning', message: 'LS descriptions:' });
        assert.strictEqual(upgraded.rules.find(rule => rule.id === 'motion').severity, 'error');
    });
});
