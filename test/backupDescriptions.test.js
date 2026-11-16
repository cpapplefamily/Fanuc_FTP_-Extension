const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    parseIoConfig,
    parseIoState,
    parseRegisterVa,
    parsePosRegVa,
    findBackupFiles,
    readBackupDescriptions,
    compareDescriptions,
    combineDescriptions,
    serializeDescriptionsCsv
} = require('../src/backupDescriptions');
const { parseDescriptionsCsv } = require('../src/descriptions');

// Excerpts from a RoboGuide HandlingTool V9.30 backup.
const IOCONFIG = [
    'F Number: 6561414   ',
    'VERSION : HandlingTool         ',
    'IO CONFIGURATION::',
    '',
    'DIN[   1]  System Air Pressure',
    'DIN[   2]  Spare',
    'DIN[   3]  ',
    'DIN    1  -  16   RACK:  89   SLOT:   4   PORT:  33',
    'DOUT[  17]  Gripper Open',
    'DOUT[  18]  Gripper Close',
    'GIN[   3] Tool Number',
    'GOUT[  10] TYPE',
    'UI[   1] *IMSTP',
    'UO[   1] Cmd enabled',
    'AIN[   2] Pressure',
    'SI[   1] Fault reset'
].join('\r\n');

const IOSTATE = [
    'IO STATUS::',
    '',
    'DIN[ 101]  ON  IMSTP',
    'DIN[   1] OFF  Different text',
    'GIN[  10]    0  TYPE',
    'RI[   1] OFF  Hand 1 closed',
    'RI[   2] OFF  ',
    'FLG[   1] OFF  Cross Present             FLG[ 513] OFF                          ',
    'FLG[   2]  ON  Part OK                   FLG[ 514] OFF  Late Flag              '
].join('\n');

const NUMREG = [
    '[*NUMREG*]$NUMREG  Storage: SHADOW  Access: RW  : ARRAY[200] OF Numeric Reg',
    "  [1] = 124.848000  'Cycle Time' ",
    "  [4] = 217  'Part Count' ",
    "  [6] = 0  '' ",
    "  [7] = -3  'Neg, value' ",
    '[*NUMREG*]$MAXREGNUM  Storage: SHADOW  Access: RW  : INTEGER = 200'
].join('\n');

const POSREG = [
    '[*POSREG*]$POSREG  Storage: SHADOW  Access: RW  : ARRAY[1,100] OF Position Reg',
    "    [1,1] =   'Home'   Group: 1",
    '  J1 =     0.000 deg   J2 =   -10.000 deg   J3 =   -30.000 deg ',
    "    [1,4] =   '' Uninitialized",
    "    [1,9] =   'Vis Pos' ",
    "    [2,1] =   'Group 2 home' "
].join('\n');

const STRREG = [
    '[*STRREG*]$STRREG  Storage: SHADOW  Access: RW  : ARRAY[25] OF String Reg',
    "  [1] =   '' ",
    "  [2] = ABC123  'Part Serial' "
].join('\n');

suite('Descriptions from a robot backup', () => {
    test('ioconfig.dg: I/O comments, mapped to description types', () => {
        const map = parseIoConfig(IOCONFIG);
        assert.deepStrictEqual([...map], [
            ['DI[1]', 'System Air Pressure'],
            ['DI[2]', 'Spare'],
            ['DO[17]', 'Gripper Open'],
            ['DO[18]', 'Gripper Close'],
            ['GI[3]', 'Tool Number'],
            ['GO[10]', 'TYPE'],
            ['UI[1]', '*IMSTP'],
            ['UO[1]', 'Cmd enabled'],
            ['AI[2]', 'Pressure']
        ]);
    });

    test('iostate.dg: skips the ON/OFF/value state and reads two entries per line', () => {
        const map = parseIoState(IOSTATE);
        assert.strictEqual(map.get('DI[101]'), 'IMSTP');
        assert.strictEqual(map.get('GI[10]'), 'TYPE');
        assert.strictEqual(map.get('RI[1]'), 'Hand 1 closed');
        assert.strictEqual(map.has('RI[2]'), false);
        assert.strictEqual(map.get('F[1]'), 'Cross Present');
        assert.strictEqual(map.get('F[2]'), 'Part OK');
        assert.strictEqual(map.has('F[513]'), false);
        assert.strictEqual(map.get('F[514]'), 'Late Flag');
    });

    test('numreg.va, strreg.va and posreg.va comments', () => {
        assert.deepStrictEqual([...parseRegisterVa(NUMREG, 'R')], [['R[1]', 'Cycle Time'], ['R[4]', 'Part Count'], ['R[7]', 'Neg, value']]);
        assert.deepStrictEqual([...parseRegisterVa(STRREG, 'SR')], [['SR[2]', 'Part Serial']]);
        assert.deepStrictEqual([...parsePosRegVa(POSREG)], [['PR[1]', 'Home'], ['PR[9]', 'Vis Pos']]);
    });

    test('reads a backup folder; ioconfig.dg wins over iostate.dg for the same key', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
        try {
            fs.writeFileSync(path.join(dir, 'IOCONFIG.DG'), IOCONFIG);
            fs.writeFileSync(path.join(dir, 'iostate.dg'), IOSTATE);
            fs.writeFileSync(path.join(dir, 'numreg.va'), NUMREG);
            fs.writeFileSync(path.join(dir, 'posreg.va'), POSREG);
            fs.writeFileSync(path.join(dir, 'grip_toggle.ls'), '/PROG GRIP_TOGGLE');
            const files = findBackupFiles(dir);
            assert.deepStrictEqual(Object.keys(files).sort(), ['ioconfig.dg', 'iostate.dg', 'numreg.va', 'posreg.va']);

            const { descriptions, counts } = readBackupDescriptions(files);
            assert.strictEqual(descriptions.get('DI[1]'), 'System Air Pressure');
            assert.strictEqual(descriptions.get('F[1]'), 'Cross Present');
            assert.strictEqual(descriptions.get('R[4]'), 'Part Count');
            assert.strictEqual(counts['ioconfig.dg'], 9);
            assert.strictEqual(counts['iostate.dg'], 6); // DI[101], GI[10], RI[1], F[1], F[2], F[514]; DI[1] stays from ioconfig.dg
            assert.strictEqual(counts['strreg.va'], undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('merge keeps manual rows, replace keeps only the backup', () => {
        const existing = new Map([['DO[17]', 'Old text'], ['DO[18]', 'Gripper Close'], ['R[50]', 'My note']]);
        const incoming = new Map([['DO[17]', 'Gripper Open'], ['DO[18]', 'Gripper Close'], ['DI[1]', 'Air']]);
        assert.deepStrictEqual(compareDescriptions(existing, incoming), { added: 1, changed: 1, unchanged: 1, kept: 1 });
        assert.deepStrictEqual(Object.fromEntries(combineDescriptions(existing, incoming, 'merge')),
            { 'DO[17]': 'Gripper Open', 'DO[18]': 'Gripper Close', 'R[50]': 'My note', 'DI[1]': 'Air' });
        assert.deepStrictEqual([...combineDescriptions(existing, incoming, 'replace').keys()], ['DO[17]', 'DO[18]', 'DI[1]']);
    });

    test('writes a sorted CSV that reads back the same, quoting commas and quotes', () => {
        const map = new Map([['R[2]', 'Count'], ['DO[10]', 'Lamp'], ['DI[2]', 'Air, main'], ['DO[9]', 'Say "hi"'], ['F[1]', 'Flag'], ['DI[10]', 'Door']]);
        const csv = serializeDescriptionsCsv(map);
        assert.strictEqual(csv, 'Key,Description\nDI[2],"Air, main"\nDI[10],Door\nDO[9],"Say ""hi"""\nDO[10],Lamp\nF[1],Flag\nR[2],Count\n');
        const back = parseDescriptionsCsv(csv);
        assert.deepStrictEqual(back.problems, []);
        assert.deepStrictEqual(Object.fromEntries(back.descriptions), Object.fromEntries(map));
    });
});
