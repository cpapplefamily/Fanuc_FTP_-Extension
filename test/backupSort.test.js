const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_FOLDERS, DEFAULT_SYSTEM_PROGRAMS, categoryOf, folderFor, sortDownloadedFiles, planRestoreFolder } = require('../src/backupSort');

const sep = (...parts) => parts.join(path.sep);

suite('Sorting downloaded robot files', () => {
    test('categories follow the rules found in real backups', () => {
        const lsInfo = base => ({ errall: { isProgram: false }, logbook: { isProgram: false } })[base] || { isProgram: true };
        const hasFile = name => ['setcmnt.pc'].includes(name);
        const cases = {
            'MAIN.LS': 'programs', 'main.tp': 'programs', 'GRIP_OPEN.LS': 'programs',
            '-BCKED8-.LS': 'systemPrograms', '-bckedt-.tp': 'systemPrograms', 'SV_ADJST.LS': 'systemPrograms',
            'getdata.ls': 'systemPrograms', 'clskp_g3.tp': 'systemPrograms',
            'ERRALL.LS': 'diagnostics', 'logbook.ls': 'diagnostics', 'summary.dg': 'diagnostics', 'ipkdmp.zip': 'diagnostics',
            'NUMREG.VA': 'registers', 'posreg.vr': 'registers', 'strreg.va': 'registers', 'palreg.vr': 'registers',
            'DIOCFGSV.IO': 'io', 'diocfgsv.va': 'io', 'ioconfig.dg': 'io', 'iostate.dg': 'io', 'iostatus.cm': 'io',
            'setcmnt.pc': 'karel', 'setcmnt.vr': 'karel', 'setcmnt.va': 'karel',
            'sysframe.sv': 'systemVariables', 'system.va': 'systemVariables', 'comset.vr': 'systemVariables',
            'panel1.stm': 'web', 'redled.gif': 'web', 'panel1.dt': 'web',
            'cam1.cam': 'vision', 'vis1.vd': 'vision', 'vis1.vda': 'vision',
            'df_logi1.df': 'systemConfig', 'backdate.dt': 'systemConfig', 'tpeins.xml': 'systemConfig', 'updates.dat': 'systemConfig', 'psrbwld.cm': 'systemConfig',
            'notes.bin': 'other'
        };
        for (const [name, expected] of Object.entries(cases)) {
            assert.strictEqual(categoryOf(name, { lsInfo, hasFile }), expected, name);
        }
    });

    test('the FANUC program list is configurable with wildcards', () => {
        assert.ok(DEFAULT_SYSTEM_PROGRAMS.includes('SV_ADJST'));
        assert.strictEqual(categoryOf('MYTOOL.LS', { systemPrograms: ['MY*'] }), 'systemPrograms');
        assert.strictEqual(categoryOf('SV_ADJST.LS', { systemPrograms: [] }), 'programs');
        assert.strictEqual(categoryOf('A1.LS', { systemPrograms: ['A?'] }), 'systemPrograms');
        assert.strictEqual(categoryOf('A12.LS', { systemPrograms: ['A?'] }), 'programs');
    });

    test('folder template: defaults, renamed folders, top level, and .tp next to its .ls folder', () => {
        assert.strictEqual(folderFor('MAIN.LS', 'programs'), 'Programs');
        assert.strictEqual(folderFor('MAIN.TP', 'programs'), sep('Programs', 'TP'));
        assert.strictEqual(folderFor('-BCKED8-.TP', 'systemPrograms'), sep('System', 'Programs', 'TP'));
        assert.strictEqual(folderFor('sysframe.sv', 'systemVariables'), sep('System', 'Variables'));
        const custom = { programs: '1 Programs', tp: 'Binary', diagnostics: '', systemVariables: 'Sys\\Vars', registers: '../escape' };
        assert.strictEqual(folderFor('MAIN.TP', 'programs', custom), sep('1 Programs', 'Binary'));
        assert.strictEqual(folderFor('summary.dg', 'diagnostics', custom), '');
        assert.strictEqual(folderFor('sysframe.sv', 'systemVariables', custom), sep('Sys', 'Vars'));
        assert.strictEqual(folderFor('numreg.va', 'registers', custom), 'escape');
        assert.strictEqual(folderFor('x.bin', 'nonexistent'), DEFAULT_FOLDERS.other);
    });

    test('sortDownloadedFiles moves files and returns their new paths', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sort-'));
        try {
            const write = (name, text = '') => { fs.writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
            const files = [
                write('MAIN.LS', '/PROG  MAIN\n/ATTR\n/MN\n/END\n'),
                write('MAIN.TP', 'binary'),
                write('ERRALL.LS', 'Alarm history\n'),
                write('-BCKED8-.LS', '/PROG  -BCKED8-\n'),
                write('numreg.va', ''),
                write('summary.dg', '')
            ];
            write('existing.txt', 'not part of this download');
            const moved = sortDownloadedFiles(dir, files);
            assert.deepStrictEqual(moved.map(file => path.relative(dir, file)), [
                sep('Programs', 'MAIN.LS'), sep('Programs', 'TP', 'MAIN.TP'), sep('Diagnostics', 'ERRALL.LS'),
                sep('System', 'Programs', '-BCKED8-.LS'), sep('Registers', 'numreg.va'), sep('Diagnostics', 'summary.dg')
            ]);
            assert.ok(moved.every(file => fs.existsSync(file)));
            assert.ok(fs.existsSync(path.join(dir, 'existing.txt')), 'other files are left alone');
            // A second download into the same (fixed) folder replaces the sorted files.
            const again = sortDownloadedFiles(dir, [write('MAIN.LS', '/PROG  MAIN\n/MN\nnew\n')]);
            assert.match(fs.readFileSync(again[0], 'utf8'), /new/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('descriptions from a sorted backup find files in IO/ and Registers/', () => {
        const { findBackupFiles } = require('../src/backupDescriptions');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-'));
        try {
            const files = sortDownloadedFiles(dir, ['IOCONFIG.DG', 'iostate.dg', 'numreg.va', 'posreg.va', 'MAIN.LS'].map(name => {
                fs.writeFileSync(path.join(dir, name), name === 'MAIN.LS' ? '/PROG MAIN\n' : '');
                return path.join(dir, name);
            }));
            assert.ok(files.every(file => path.dirname(file) !== dir), 'all were moved into sub-folders');
            const found = findBackupFiles(dir);
            assert.deepStrictEqual(Object.keys(found).sort(), ['ioconfig.dg', 'iostate.dg', 'numreg.va', 'posreg.va']);
            assert.strictEqual(found['numreg.va'], path.join(dir, 'Registers', 'numreg.va'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('restore plan collects every file into one flat list and reports duplicates', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
        try {
            for (const [rel, text] of [['Programs/MAIN.LS', 'a'], ['Programs/TP/MAIN.TP', 'b'], ['System/Variables/sysframe.sv', 'c'], ['Diagnostics/MAIN.LS', 'dup'], ['.git/HEAD', 'x']]) {
                fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
                fs.writeFileSync(path.join(dir, rel), text);
            }
            const plan = planRestoreFolder(dir);
            assert.deepStrictEqual(plan.copies.map(copy => copy.name).sort(), ['MAIN.LS', 'MAIN.TP', 'sysframe.sv']);
            assert.deepStrictEqual(plan.duplicates, ['MAIN.LS']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
