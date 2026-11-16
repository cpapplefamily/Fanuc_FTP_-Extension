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
});
