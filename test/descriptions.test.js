const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    normalizeKey,
    parseCsvRows,
    parseDescriptionsCsv,
    mergeDescriptions,
    findDescriptionKeys,
    findInlineComments,
    inlineCommentMatches,
    setDescriptionInCsv,
    getSharedDescriptionsPath,
    getRobotDescriptionsPath,
    ensureDescriptionsFile
} = require('../src/descriptions');
const { cleanRobots } = require('../src/robotIps');

suite('I/O and register descriptions', () => {
    test('normalizes keys for every supported type', () => {
        for (const type of ['DI', 'DO', 'RI', 'RO', 'AI', 'AO', 'GI', 'GO', 'UI', 'UO', 'PR', 'SR', 'R', 'F']) {
            assert.strictEqual(normalizeKey(`${type.toLowerCase()}[ 007 ]`), `${type}[7]`);
        }
        for (const bad of ['DX[1]', 'DO[]', 'DO[1:Clamp]', 'DO1', '', undefined]) {
            assert.strictEqual(normalizeKey(bad), undefined);
        }
    });

    test('parses quoted CSV fields, BOM, and CRLF line endings', () => {
        const text = '﻿Key,Description\r\nDO[1],"Clamp, closed"\r\nDI[2],"Says ""ready"""\r\n\r\n';
        assert.deepStrictEqual(parseCsvRows(text), [['Key', 'Description'], ['DO[1]', 'Clamp, closed'], ['DI[2]', 'Says "ready"']]);
    });

    test('reads Key,Description files and reports bad rows', () => {
        const { descriptions, problems } = parseDescriptionsCsv('description,KEY\nValve 1,do[1]\nGripper,PR[3]\nNope,XX[1]\nEmpty,\n,R[5]\n');
        assert.deepStrictEqual([...descriptions], [['DO[1]', 'Valve 1'], ['PR[3]', 'Gripper']]);
        assert.strictEqual(problems.length, 2);
        assert.match(parseDescriptionsCsv('A,B\n1,2\n').problems[0], /header/);
        assert.deepStrictEqual(parseDescriptionsCsv('').problems, []);
    });

    test('robot descriptions override shared ones and remember their source', () => {
        const merged = mergeDescriptions(
            new Map([['DO[1]', 'Shared valve'], ['DI[1]', 'E-stop']]),
            new Map([['DO[1]', 'ST02 valve']])
        );
        assert.deepStrictEqual(merged.get('DO[1]'), { text: 'ST02 valve', source: 'robot' });
        assert.deepStrictEqual(merged.get('DI[1]'), { text: 'E-stop', source: 'shared' });
        assert.strictEqual(mergeDescriptions(new Map(), undefined).size, 0);
    });

    test('finds keys in LS code, ends at the closing bracket, and skips remarks and robot comments', () => {
        const line = '  4:  IF DI[12]=ON AND R[3]>PR[2,1],JMP LBL[1] ; DO[1:Clamp]=ON ;';
        assert.deepStrictEqual(findDescriptionKeys(line).map(found => found.key), ['DI[12]', 'R[3]']);
        const [first] = findDescriptionKeys('DO[5]=ON ;');
        assert.deepStrictEqual(first, { key: 'DO[5]', start: 0, end: 4 });
        assert.deepStrictEqual(findDescriptionKeys('  1:  !Turn DO[1] on ;'), []);
        assert.deepStrictEqual(findDescriptionKeys('!Turn DO[1] on ;'), []);
        assert.deepStrictEqual(findDescriptionKeys('   1:  IF (!DO[17]) THEN ;').map(found => found.key), ['DO[17]']);
        assert.deepStrictEqual(findDescriptionKeys('   2:  IF (DI[1] AND !DI[2]),JMP LBL[1] ;').map(found => found.key), ['DI[1]', 'DI[2]']);
        assert.deepStrictEqual(findDescriptionKeys('   3:  DO[17: * :Gripper Open]=ON ;'), []);
        assert.deepStrictEqual(findDescriptionKeys('  2:  sr[1]=GO[2] ; F[3]=(ON) ;').map(found => found.key), ['SR[1]', 'GO[2]', 'F[3]']);
        assert.deepStrictEqual(findDescriptionKeys('  3:  UFRAME_NUM=1 ; AR[1] ; MyR[2]').map(found => found.key), []);
    });

    test('file locations follow the robot name unless the robot sets a descriptions path', () => {
        const root = path.join(os.tmpdir(), 'job');
        assert.strictEqual(getSharedDescriptionsPath(root), path.join(root, '.vscode', 'descriptions', 'shared.csv'));
        assert.strictEqual(getRobotDescriptionsPath(root, { name: 'ST02' }), path.join(root, '.vscode', 'descriptions', 'ST02.csv'));
        assert.strictEqual(getRobotDescriptionsPath(root, { name: 'Cell 1/A' }), path.join(root, '.vscode', 'descriptions', 'Cell 1_A.csv'));
        assert.strictEqual(getRobotDescriptionsPath(root, { name: 'ST02', descriptions: 'io/st02.csv' }), path.join(root, 'io', 'st02.csv'));

        const { robots, problems } = cleanRobots([
            { name: 'ST02', ip: '10.0.0.2', descriptions: 'io/st02.csv' },
            { name: 'ST04', ip: '10.0.0.4', descriptions: 5 }
        ]);
        assert.strictEqual(robots[0].descriptions, 'io/st02.csv');
        assert.strictEqual(robots[1].descriptions, undefined);
        assert.strictEqual(problems.length, 1);
    });

    test('ensureDescriptionsFile creates a header-only file once', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'descriptions-'));
        try {
            const filePath = path.join(root, '.vscode', 'descriptions', 'ST02.csv');
            ensureDescriptionsFile(filePath);
            assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'Key,Description\n');
            fs.appendFileSync(filePath, 'DO[1],Valve\n');
            ensureDescriptionsFile(filePath);
            assert.match(fs.readFileSync(filePath, 'utf8'), /Valve/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('finds inline comments in the forms the robot writes, without the I/O state', () => {
        const pick = line => findInlineComments(line).map(found => [found.key, found.text, line.slice(found.start, found.end)]);
        assert.deepStrictEqual(pick('   1:  DO[17: * :Gripper Open]=ON ;'), [['DO[17]', 'Gripper Open', 'DO[17: * :Gripper Open]']]);
        assert.deepStrictEqual(pick('   2:  WAIT (DI[3:OFF:Hold]=ON AND DO[1:ON :Clamp]) ;').map(item => item[1]), ['Hold', 'Clamp']);
        assert.deepStrictEqual(pick('   3:  R[10:Pick Number]=GI[1:Part ID] ;').map(item => [item[0], item[1]]), [['R[10]', 'Pick Number'], ['GI[1]', 'Part ID']]);
        assert.deepStrictEqual(pick('   4:  F[2:OFF:Cycle: A]=(ON) ;').map(item => item[1]), ['Cycle: A']);
        assert.deepStrictEqual(pick('   5:  DO[7:OFF:]=ON ; DO[8]=OFF ; R[1]=GI[1: * ] ;'), []);
        assert.deepStrictEqual(pick('   6:  !DO[5:in a remark] ;'), []);
    });

    test('a description that starts with a cut-off LS comment still matches, but a shortened short comment does not', () => {
        assert.strictEqual(inlineCommentMatches('Tool Offset Ro', 'Tool Offset Rotate'), true);
        assert.strictEqual(inlineCommentMatches('S201 PIC Y OFF', 'S201 PIC Y OFFST'), true);
        assert.strictEqual(inlineCommentMatches('new', 'newer'), false);
        assert.strictEqual(inlineCommentMatches('Gripper Ope', 'Gripper Open'), false);
        assert.strictEqual(inlineCommentMatches('Clamp', 'Clamp'), true);
        assert.strictEqual(inlineCommentMatches('Clamp Closed', 'Clamp'), false);
        assert.strictEqual(inlineCommentMatches('Clamp', undefined), false);
    });

    test('setDescriptionInCsv changes one row in place, keeps order and CRLF, and appends new keys', () => {
        const csv = 'Key,Description\r\nDI[1],Air\r\ndi[ 2 ],Spare\r\nDI[3],Hold\r\nDI[2],Duplicate\r\n';
        assert.strictEqual(setDescriptionInCsv(csv, 'DI[2]', 'Clamp, closed'),
            'Key,Description\r\nDI[1],Air\r\ndi[ 2 ],"Clamp, closed"\r\nDI[3],Hold\r\n');
        assert.strictEqual(setDescriptionInCsv(csv, 'R[1]', 'Count').endsWith('DI[2],Duplicate\r\nR[1],Count\r\n'), true);
        assert.strictEqual(setDescriptionInCsv('', 'R[1]', 'Count'), 'Key,Description\nR[1],Count\n');
        assert.strictEqual(setDescriptionInCsv('Description,Key\n', 'R[1]', 'Count'), 'Description,Key\nCount,R[1]\n');
        assert.throws(() => setDescriptionInCsv('Name,Text\n', 'R[1]', 'Count'), /header/);
        const parsed = parseDescriptionsCsv(setDescriptionInCsv(csv, 'DI[2]', 'Say "hi"')).descriptions;
        assert.strictEqual(parsed.get('DI[2]'), 'Say "hi"');
        assert.strictEqual(parsed.size, 3);
    });
});
