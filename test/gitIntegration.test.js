const assert = require('assert');
const path = require('path');
const { buildCommitMessage, messageVars, offerCommit, initChoicesFor, formatDate, mergeGitignore, DEFAULT_IGNORE_PATTERNS } = require('../src/gitIntegration');

const ROOT = path.resolve('/job/Robots');
const p = (...parts) => path.join(ROOT, ...parts);

function fakeRepo({ changed = [], staged = [], remote = false, pushFails = false } = {}) {
    const calls = [];
    const state = { changed: [...changed], staged: [...staged] };
    return {
        calls, state,
        root: ROOT,
        branch: () => 'main',
        hasRemote: () => remote,
        refresh: async () => calls.push('refresh'),
        changedPaths: () => [...state.changed],
        stagedPaths: () => [...state.staged],
        add: async paths => {
            calls.push(['add', paths.length]);
            for (const file of paths) {
                state.changed = state.changed.filter(f => f !== file);
                if (!state.staged.includes(file)) state.staged.push(file);
            }
        },
        unstage: async paths => {
            calls.push(['unstage', paths.length]);
            state.staged = state.staged.filter(f => !paths.includes(f));
        },
        commit: async message => {
            calls.push(['commit', message, [...state.staged].sort()]);
            state.staged = [];
        },
        push: async () => {
            calls.push('push');
            if (pushFails) throw new Error('rejected');
        },
        showInSourceControl: async message => calls.push(['scm', message])
    };
}

function fakeUi(answers = {}) {
    const shown = { info: [], warn: [], choose: [], input: [], pick: [] };
    return {
        shown,
        pick: async (items, options) => {
            shown.pick.push({ items, options });
            const answer = (answers.pick || []).shift();
            return typeof answer === 'number' ? items[answer] : answer;
        },
        input: async options => {
            shown.input.push(options);
            return 'input' in answers ? answers.input : options.value;
        },
        choose: async (message, buttons) => {
            shown.choose.push({ message, buttons });
            const answer = (answers.choose || []).shift();
            return typeof answer === 'number' ? buttons[answer] : answer;
        },
        info: message => shown.info.push(message),
        warn: message => shown.warn.push(message)
    };
}

const SETTINGS = { onDownload: 'prompt', onUpload: 'prompt', commitMode: 'auto', messageTemplate: '${operation} ${robot} ${date}', push: 'never', offerInit: true };
const NOW = new Date(2026, 10, 16, 9, 5);

function download(files, extra = {}) {
    return { kind: 'download', operation: 'Download LS files', files, folder: p('ST02', 'LS'), robotName: 'ST02', ip: '192.168.1.12', ...extra };
}

function git(repo, extra = {}) {
    return { findRepo: async () => repo, initChoices: () => [ROOT], init: async () => repo, ...extra };
}

suite('Git commits after robot transfers', () => {
    test('builds commit messages from the template', () => {
        assert.strictEqual(formatDate(NOW), '2026-11-16 09:05');
        const vars = messageVars(download([]), ROOT, 3, NOW);
        assert.strictEqual(buildCommitMessage('${operation} ${robot} ${date}', vars), 'Download LS files ST02 (192.168.1.12) 2026-11-16 09:05');
        assert.strictEqual(buildCommitMessage('${count} files to ${folder} ${unknown}', vars), '3 files to ST02/LS ${unknown}');
        const unnamed = messageVars(download([], { robotName: undefined }), ROOT, 1, NOW);
        assert.strictEqual(buildCommitMessage('${operation} ${name} (${ip})', unnamed), 'Download LS files (192.168.1.12)');
        assert.strictEqual(buildCommitMessage('Get ${name} ()', unnamed), 'Get');
        assert.strictEqual(buildCommitMessage('', vars), 'Download LS files ST02 (192.168.1.12) 2026-11-16 09:05');
    });

    test('off settings and empty transfers do nothing', async () => {
        const repo = fakeRepo({ changed: [p('ST02', 'LS', 'A.LS')] });
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi(), settings: { ...SETTINGS, onDownload: 'off' }, result: download([p('ST02', 'LS', 'A.LS')]) }), 'off');
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi(), settings: { ...SETTINGS, onUpload: 'off' }, result: { ...download([p('x')]), kind: 'upload' } }), 'off');
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi(), settings: SETTINGS, result: download([]) }), 'no-files');
        assert.deepStrictEqual(repo.calls, []);
    });

    test('commits only the transferred files that changed, with the default message', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const b = p('ST02', 'LS', 'B.LS');
        const unrelated = p('notes.txt');
        const repo = fakeRepo({ changed: [a, unrelated] });
        const ui = fakeUi();
        const status = await offerCommit({ git: git(repo), ui, settings: SETTINGS, result: download([a, b]), now: NOW });
        assert.strictEqual(status, 'committed');
        assert.deepStrictEqual(repo.calls.find(call => call[0] === 'commit'), ['commit', 'Download LS files ST02 (192.168.1.12) 2026-11-16 09:05', [a]]);
        assert.deepStrictEqual(repo.state.changed, [unrelated]);
        assert.match(ui.shown.input[0].prompt, /1 file\(s\).*main/);
        assert.deepStrictEqual(ui.shown.info, ['Committed 1 file(s) to main.']);
    });

    test('matches paths ignoring case on Windows', async function () {
        if (process.platform !== 'win32') this.skip();
        const repo = fakeRepo({ changed: [p('ST02', 'LS', 'MAIN.LS')] });
        const status = await offerCommit({ git: git(repo), ui: fakeUi(), settings: SETTINGS, result: download([p('st02', 'ls', 'main.ls')]) });
        assert.strictEqual(status, 'committed');
    });

    test('no changes: download and upload messages', async () => {
        const ui = fakeUi();
        assert.strictEqual(await offerCommit({ git: git(fakeRepo()), ui, settings: SETTINGS, result: download([p('ST02', 'LS', 'A.LS')]) }), 'no-changes');
        assert.match(ui.shown.info[0], /match the last commit/);
        const upload = { ...download([p('ST02', 'LS', 'A.LS')]), kind: 'upload', operation: 'Upload' };
        assert.strictEqual(await offerCommit({ git: git(fakeRepo()), ui, settings: SETTINGS, result: upload }), 'no-changes');
        assert.match(ui.shown.info[1], /already committed/);
        assert.strictEqual(ui.shown.input.length, 0);
    });

    test('upload with edits commits them', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const repo = fakeRepo({ changed: [a] });
        const upload = { kind: 'upload', operation: 'Upload', files: [a], folder: p('ST02', 'LS'), robotName: 'ST02', ip: '10.0.0.2' };
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi(), settings: SETTINGS, result: upload, now: NOW }), 'committed');
        assert.strictEqual(repo.calls.find(call => call[0] === 'commit')[1], 'Upload ST02 (10.0.0.2) 2026-11-16 09:05');
    });

    test('Esc on the message skips without staging anything', async () => {
        const repo = fakeRepo({ changed: [p('ST02', 'LS', 'A.LS')] });
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi({ input: undefined }), settings: SETTINGS, result: download([p('ST02', 'LS', 'A.LS')]) }), 'cancelled');
        assert.deepStrictEqual(repo.state.staged, []);
        assert.ok(!repo.calls.some(call => call[0] === 'add'));
    });

    test('other staged files: commit anyway, only robot files, or cancel', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const other = p('README.md');

        let repo = fakeRepo({ changed: [a], staged: [other] });
        await offerCommit({ git: git(repo), ui: fakeUi({ choose: ['Commit anyway'] }), settings: SETTINGS, result: download([a]) });
        assert.deepStrictEqual(repo.calls.find(call => call[0] === 'commit')[2], [other, a].sort());

        repo = fakeRepo({ changed: [a], staged: [other] });
        await offerCommit({ git: git(repo), ui: fakeUi({ choose: ['Only robot files'] }), settings: SETTINGS, result: download([a]) });
        assert.deepStrictEqual(repo.calls.find(call => call[0] === 'commit')[2], [a]);
        assert.deepStrictEqual(repo.state.staged, [other], 'the other file is staged again afterwards');

        repo = fakeRepo({ changed: [a], staged: [other] });
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi({ choose: [undefined] }), settings: SETTINGS, result: download([a]) }), 'cancelled');
        assert.deepStrictEqual(repo.state.staged, [other]);
    });

    test('confirm mode: commit, open Source Control, or cancel', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const confirm = { ...SETTINGS, commitMode: 'confirm' };

        let repo = fakeRepo({ changed: [a] });
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi({ choose: ['Commit'] }), settings: confirm, result: download([a]) }), 'committed');

        repo = fakeRepo({ changed: [a] });
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi({ choose: ['Open Source Control'], input: 'My message' }), settings: confirm, result: download([a]) }), 'staged');
        assert.deepStrictEqual(repo.state.staged, [a]);
        assert.deepStrictEqual(repo.calls.at(-1), ['scm', 'My message']);

        repo = fakeRepo({ changed: [a] });
        assert.strictEqual(await offerCommit({ git: git(repo), ui: fakeUi({ choose: [undefined] }), settings: confirm, result: download([a]) }), 'cancelled');
        assert.deepStrictEqual(repo.state.staged, []);
    });

    test('stages large transfers in chunks', async () => {
        const files = Array.from({ length: 120 }, (_, i) => p('ST02', '2026-11-16-ALL_01', `F${i}.VA`));
        const repo = fakeRepo({ changed: files });
        await offerCommit({ git: git(repo), ui: fakeUi(), settings: SETTINGS, result: download(files) });
        assert.deepStrictEqual(repo.calls.filter(call => call[0] === 'add').map(call => call[1]), [50, 50, 20]);
        assert.strictEqual(repo.calls.find(call => call[0] === 'commit')[2].length, 120);
    });

    test('not a repo: offer init where allowed', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const repo = fakeRepo({ changed: [a] });
        let initFolder;
        const gitNoRepo = git(null, { initChoices: () => [ROOT, p('ST02', 'LS')], init: async folder => { initFolder = folder; return repo; } });

        assert.strictEqual(await offerCommit({ git: gitNoRepo, ui: fakeUi(), settings: { ...SETTINGS, offerInit: false }, result: download([a]) }), 'no-repo');
        assert.strictEqual(await offerCommit({ git: gitNoRepo, ui: fakeUi({ pick: [2] }), settings: SETTINGS, result: download([a]) }), 'no-repo');
        assert.strictEqual(await offerCommit({ git: gitNoRepo, ui: fakeUi({ pick: [undefined] }), settings: SETTINGS, result: download([a]) }), 'no-repo');

        const ui = fakeUi({ pick: [0] });
        assert.strictEqual(await offerCommit({ git: gitNoRepo, ui, settings: SETTINGS, result: download([a]) }), 'committed');
        assert.strictEqual(initFolder, ROOT);
        // Short labels, full paths on their own line.
        assert.deepStrictEqual(ui.shown.pick[0].items.map(item => [item.label, item.description, item.detail]), [
            ['Create repository in Robots', 'whole project (recommended)', ROOT],
            ['Create repository in LS', 'this folder only', p('ST02', 'LS')],
            ['Not now', 'skip git for this transfer', undefined]
        ]);
        assert.match(ui.shown.pick[0].options.placeHolder, /^LS is not in a git repository/);
    });

    test('inside an SVN working copy: no init offer, but an existing git repo is still used', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const ui = fakeUi();
        const svn = git(null, { skipInitReason: () => 'in an SVN working copy' });
        assert.strictEqual(await offerCommit({ git: svn, ui, settings: SETTINGS, result: download([a]) }), 'other-vcs');
        assert.strictEqual(ui.shown.pick.length, 0, 'no "create repository" question');

        const repo = fakeRepo({ changed: [a] });
        const gitInsideSvn = git(repo, { skipInitReason: () => 'in an SVN working copy' });
        assert.strictEqual(await offerCommit({ git: gitInsideSvn, ui: fakeUi(), settings: SETTINGS, result: download([a]) }), 'committed');
    });

    test('push: never, ask, always, no remote, failure', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const run = (settings, repo, ui = fakeUi()) => offerCommit({ git: git(repo), ui, settings, result: download([a]) });

        assert.strictEqual(await run(SETTINGS, fakeRepo({ changed: [a], remote: true })), 'committed');
        assert.strictEqual(await run({ ...SETTINGS, push: 'always' }, fakeRepo({ changed: [a], remote: true })), 'pushed');
        assert.strictEqual(await run({ ...SETTINGS, push: 'ask' }, fakeRepo({ changed: [a], remote: true }), fakeUi({ choose: ['Push'] })), 'pushed');
        assert.strictEqual(await run({ ...SETTINGS, push: 'ask' }, fakeRepo({ changed: [a], remote: true }), fakeUi({ choose: [undefined] })), 'committed');

        const noRemote = fakeUi();
        assert.strictEqual(await run({ ...SETTINGS, push: 'always' }, fakeRepo({ changed: [a] }), noRemote), 'committed');
        assert.match(noRemote.shown.warn[0], /no remote/);

        const failing = fakeUi();
        assert.strictEqual(await run({ ...SETTINGS, push: 'always' }, fakeRepo({ changed: [a], remote: true, pushFails: true }), failing), 'committed');
        assert.match(failing.shown.warn[0], /push failed: rejected/);
    });

    test('.gitignore: new file, missing patterns only, line endings, blanks', () => {
        assert.deepStrictEqual(mergeGitignore('', DEFAULT_IGNORE_PATTERNS), {
            text: '# Files not tracked (robotFtp.git.ignorePatterns)\n*.Sem\n*.Wrk\n',
            added: ['*.Sem', '*.Wrk']
        });
        assert.deepStrictEqual(mergeGitignore('node_modules\r\n*.Sem\r\n', ['*.Sem', ' *.Wrk ', '', 7]), {
            text: 'node_modules\r\n*.Sem\r\n*.Wrk\r\n',
            added: ['*.Wrk']
        });
        assert.deepStrictEqual(mergeGitignore('*.bak', ['*.Wrk']), { text: '*.bak\n*.Wrk\n', added: ['*.Wrk'] });
        assert.deepStrictEqual(mergeGitignore('*.Sem\n*.Wrk\n', ['*.Wrk', '*.Wrk']), { text: '*.Sem\n*.Wrk\n', added: [] });
        assert.deepStrictEqual(mergeGitignore(undefined, []), { text: '', added: [] });
    });

    test('a new repository commits its .gitignore with the robot files', async () => {
        const a = p('ST02', 'LS', 'A.LS');
        const gitignore = p('.gitignore');
        const repo = fakeRepo({ changed: [a, gitignore] });
        repo.createdFiles = [gitignore];
        const gitNoRepo = git(null, { init: async () => repo });
        assert.strictEqual(await offerCommit({ git: gitNoRepo, ui: fakeUi({ pick: [0] }), settings: SETTINGS, result: download([a]) }), 'committed');
        assert.deepStrictEqual(repo.calls.find(call => call[0] === 'commit')[2], [gitignore, a].sort());
    });

    test('a new repository offers to include files that were already in the folder', async () => {
        const a = p('ST02', 'LS_02', 'A.LS');
        const older = p('ST02', 'LS_01', 'A.LS');
        const settingsFile = p('.vscode', 'robot-ftp.json');
        const gitignore = p('.gitignore');
        const make = () => {
            const repo = fakeRepo({ changed: [a, older, settingsFile, gitignore] });
            repo.createdFiles = [gitignore];
            return repo;
        };
        const run = (repo, [initPick, answer]) => offerCommit({ git: git(null, { init: async () => repo }), ui: fakeUi({ pick: [initPick], choose: [answer] }), settings: SETTINGS, result: download([a]) });

        let repo = make();
        assert.strictEqual(await run(repo, [0, 'Commit all 4 files']), 'committed');
        assert.deepStrictEqual(repo.calls.find(call => call[0] === 'commit')[2], [a, older, settingsFile, gitignore].sort());

        repo = make();
        assert.strictEqual(await run(repo, [0, 'Only this transfer (2)']), 'committed');
        assert.deepStrictEqual(repo.calls.find(call => call[0] === 'commit')[2], [a, gitignore].sort());

        repo = make();
        assert.strictEqual(await run(repo, [0, undefined]), 'cancelled');
        assert.deepStrictEqual(repo.state.staged, []);

        // An existing repository never asks: only the transfer is committed.
        repo = fakeRepo({ changed: [a, older] });
        const ui = fakeUi();
        await offerCommit({ git: git(repo), ui, settings: SETTINGS, result: download([a]) });
        assert.strictEqual(ui.shown.choose.length, 0);
        assert.deepStrictEqual(repo.calls.find(call => call[0] === 'commit')[2], [a]);
    });

    test('init choices: workspace folder first, then the transfer folder', () => {
        assert.deepStrictEqual(initChoicesFor(p('ST02', 'LS'), ROOT), [ROOT, p('ST02', 'LS')]);
        assert.deepStrictEqual(initChoicesFor(ROOT, ROOT), [ROOT]);
        assert.deepStrictEqual(initChoicesFor(p('x'), undefined), [p('x')]);
        assert.deepStrictEqual(initChoicesFor(path.resolve('/elsewhere'), ROOT), [path.resolve('/elsewhere')]);
    });
});
