const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    MAX_RECENT_IPS,
    cleanRecentIps,
    addRecentIp,
    getProjectIpsPath,
    readProjectRecentIps,
    saveProjectRecentIp,
    cleanRobots,
    readProjectConfig,
    saveProjectRobot,
    ensureProjectFile,
    robotForPath,
    buildIpOptions,
    folderChoices,
    OTHER_OPTION
} = require('../src/robotIps');

suite('Project robot IP history', () => {
    let root;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-ips-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('cleans invalid, duplicate, and extra entries', () => {
        assert.deepStrictEqual(cleanRecentIps('nope'), []);
        assert.deepStrictEqual(
            cleanRecentIps(['10.0.0.1', 'bad', 7, '10.0.0.1', '999.0.0.1', '10.0.0.2']),
            ['10.0.0.1', '10.0.0.2']
        );
        const many = Array.from({ length: 8 }, (_, i) => `10.0.0.${i}`);
        assert.strictEqual(cleanRecentIps(many).length, MAX_RECENT_IPS);
    });

    test('puts the newest IP first without duplicates', () => {
        assert.deepStrictEqual(addRecentIp(['10.0.0.1', '10.0.0.2'], '10.0.0.2'), ['10.0.0.2', '10.0.0.1']);
        assert.deepStrictEqual(addRecentIp(undefined, '10.0.0.3'), ['10.0.0.3']);
    });

    test('reading never creates the project file', () => {
        assert.deepStrictEqual(readProjectRecentIps(root), []);
        assert.strictEqual(fs.existsSync(path.join(root, '.vscode')), false);
    });

    test('saving creates .vscode/robot-ftp.json and keeps other keys', () => {
        saveProjectRecentIp(root, '192.168.1.12');
        const filePath = getProjectIpsPath(root);
        assert.strictEqual(filePath, path.join(root, '.vscode', 'robot-ftp.json'));

        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.robots = [{ name: 'ST02', ip: '192.168.1.12' }];
        fs.writeFileSync(filePath, JSON.stringify(data));

        assert.deepStrictEqual(saveProjectRecentIp(root, '192.168.1.14'), ['192.168.1.14', '192.168.1.12']);
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.deepStrictEqual(saved.robots, [{ name: 'ST02', ip: '192.168.1.12' }]);
        assert.deepStrictEqual(readProjectRecentIps(root), ['192.168.1.14', '192.168.1.12']);
    });

    test('rejects a project file that is not a JSON object', () => {
        fs.mkdirSync(path.join(root, '.vscode'));
        fs.writeFileSync(getProjectIpsPath(root), '[]');
        assert.throws(() => readProjectRecentIps(root), /JSON object/);
    });

    test('cleans robots: name and IP required, folder and port optional, null port means setting', () => {
        const { robots, problems } = cleanRobots([
            { name: 'ST02', ip: '192.168.1.12', folder: 'ST02', port: null },
            { name: 'Sim', ip: '127.0.0.2', port: 9125 },
            { name: 'BadPort', ip: '10.0.0.9', port: 'abc' },
            { name: '', ip: '10.0.0.1' },
            { name: 'BadIp', ip: '300.1.1.1' },
            'nope'
        ]);
        assert.deepStrictEqual(robots, [
            { name: 'ST02', ip: '192.168.1.12', folder: 'ST02' },
            { name: 'Sim', ip: '127.0.0.2', port: 9125 },
            { name: 'BadPort', ip: '10.0.0.9' }
        ]);
        assert.strictEqual(problems.length, 4);
        assert.deepStrictEqual(cleanRobots(undefined), { robots: [], problems: [] });
    });

    test('matches the deepest robot folder, case-insensitive on Windows', () => {
        const robots = [
            { name: 'Cell', ip: '10.0.0.1', folder: 'Robots' },
            { name: 'ST02', ip: '10.0.0.2', folder: 'Robots/ST02' },
            { name: 'NoFolder', ip: '10.0.0.3' }
        ];
        const target = path.join(root, 'Robots', 'ST02', 'LS', '2026-11-16-LS_01');
        assert.strictEqual(robotForPath(robots, root, target).name, 'ST02');
        assert.strictEqual(robotForPath(robots, root, path.join(root, 'Robots', 'ST04')).name, 'Cell');
        assert.strictEqual(robotForPath(robots, root, path.join(root, 'Other')), undefined);
        assert.strictEqual(robotForPath(robots, root, path.join(root, 'Robots', 'ST020')).name, 'Cell');
        assert.strictEqual(robotForPath(robots, root, path.join(root, 'robots', 'st02'), 'win32').name, 'ST02');
        if (process.platform !== 'win32') {
            assert.strictEqual(robotForPath(robots, root, path.join(root, 'robots', 'st02'), 'linux'), undefined);
        }
    });

    test('picker order: folder robot, recent, other robots, built-ins, Other', () => {
        const robots = [
            { name: 'ST02', ip: '10.0.0.2', folder: 'ST02' },
            { name: 'St04', ip: '10.0.0.4', folder: 'St04' },
            { name: 'Sim', ip: '127.0.0.2', port: 9125 }
        ];
        const options = buildIpOptions({
            robots,
            recent: ['10.0.0.4', '10.0.0.99', '10.0.0.2'],
            workspaceRoot: root,
            targetPath: path.join(root, 'ST02', 'LS'),
            builtIns: [{ ip: '192.168.10.124', description: 'Default' }, { ip: '127.0.0.2', description: 'RoboGuide' }]
        });
        assert.deepStrictEqual(options.map(o => o.label), ['ST02', 'St04', '10.0.0.99', 'Sim', '192.168.10.124', 'Other']);
        assert.match(options[0].description, /this folder/);
        assert.match(options[1].description, /recent/);
        assert.deepStrictEqual([options[3].ip, options[3].port], ['127.0.0.2', 9125]);
        assert.strictEqual(options[2].port, undefined);
        assert.strictEqual(options[5].kind, OTHER_OPTION);
    });

    test('saves named robots, replacing by name, and keeps recent IPs', () => {
        saveProjectRecentIp(root, '10.0.0.2');
        saveProjectRobot(root, { name: 'ST02', ip: '10.0.0.2', folder: 'ST02' });
        saveProjectRobot(root, { name: 'Sim', ip: '127.0.0.2', port: 9125 });
        saveProjectRobot(root, { name: 'st02', ip: '10.0.0.22', folder: 'ST02' });
        const raw = JSON.parse(fs.readFileSync(getProjectIpsPath(root), 'utf8'));
        assert.deepStrictEqual(raw.robots, [
            { name: 'st02', ip: '10.0.0.22', folder: 'ST02', port: null },
            { name: 'Sim', ip: '127.0.0.2', folder: null, port: 9125 }
        ]);
        const config = readProjectConfig(root);
        assert.deepStrictEqual(config.recent, ['10.0.0.2']);
        assert.deepStrictEqual(config.problems, []);
        assert.strictEqual(config.robots[0].port, undefined);
    });

    test('ensureProjectFile creates an empty list once and leaves an existing file alone', () => {
        const filePath = ensureProjectFile(root);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { robots: [], recent: [] });
        saveProjectRecentIp(root, '10.0.0.5');
        ensureProjectFile(root);
        assert.deepStrictEqual(readProjectRecentIps(root), ['10.0.0.5']);
    });

    test('folder choices list each folder from the workspace down to the target', () => {
        assert.deepStrictEqual(folderChoices(root, path.join(root, 'Robots', 'ST02', 'LS')), ['Robots', 'Robots/ST02', 'Robots/ST02/LS']);
        assert.deepStrictEqual(folderChoices(root, root), []);
        assert.deepStrictEqual(folderChoices(root, path.dirname(root)), []);
    });
});
