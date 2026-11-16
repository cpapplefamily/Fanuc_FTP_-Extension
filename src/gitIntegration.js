const path = require('path');

/**
 * Git commits after robot transfers. VS Code-free: git access and dialogs are injected so this can be unit tested.
 *
 * result   { kind: 'download' | 'upload', operation, files: [absolute paths], folder, robotName, ip }
 * settings { onDownload, onUpload: 'off'|'prompt', commitMode: 'auto'|'confirm', messageTemplate, push: 'never'|'ask'|'always', offerInit }
 * git      { findRepo(folder) → repo|null, initChoices(folder) → [paths], init(folder) → repo|null }
 *            A repo returned by init may list createdFiles (e.g. its new .gitignore); they join the first commit.
 * repo     { root, branch(), hasRemote(), refresh(), changedPaths() → paths (unstaged + untracked), stagedPaths() → paths,
 *            add(paths), unstage(paths), commit(message), push(), showInSourceControl(message) }
 * ui       { input(options) → string|undefined, choose(message, buttons, { modal }) → button|undefined,
 *            pick(items, { title, placeHolder }) → item|undefined, info(message), warn(message) }
 */

const DEFAULT_TEMPLATE = '${operation} ${robot} ${date}';
const DEFAULT_IGNORE_PATTERNS = ['*.Sem', '*.Wrk'];
const ADD_CHUNK = 50; // Keep each git command line well under the Windows limit.

function formatDate(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Replaces ${name} variables. Unknown variables are left as typed. Extra spaces from empty values are collapsed. */
function buildCommitMessage(template, vars) {
    const text = (template || DEFAULT_TEMPLATE).replace(/\$\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name] ?? '') : match));
    return text.replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function messageVars(result, repoRoot, count, now = new Date()) {
    const robot = result.robotName ? `${result.robotName} (${result.ip})` : (result.ip || '');
    const folder = repoRoot && result.folder ? path.relative(repoRoot, result.folder).split(path.sep).join('/') || '.' : '';
    return { operation: result.operation, robot, name: result.robotName || '', ip: result.ip || '', date: formatDate(now), count, folder };
}

function samePathKey(p, platform = process.platform) {
    const resolved = path.resolve(p);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, p) {
    const relative = path.relative(root, p);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function inChunks(paths, action) {
    for (let i = 0; i < paths.length; i += ADD_CHUNK) {
        await action(paths.slice(i, i + ADD_CHUNK));
    }
}

/**
 * Adds patterns to .gitignore text, skipping blanks and patterns already present.
 * Returns { text, added }. Keeps the existing line ending style.
 */
function mergeGitignore(existingText, patterns) {
    const existing = existingText || '';
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const present = new Set(existing.split(/\r?\n/).map(line => line.trim()));
    const added = [];
    for (const raw of patterns || []) {
        const pattern = typeof raw === 'string' ? raw.trim() : '';
        if (pattern && !present.has(pattern)) {
            present.add(pattern);
            added.push(pattern);
        }
    }
    if (added.length === 0) {
        return { text: existing, added };
    }
    const prefix = existing === '' ? '' : (existing.endsWith('\n') ? '' : eol);
    const header = existing === '' ? `# Files not tracked (robotFtp.git.ignorePatterns)${eol}` : '';
    return { text: existing + prefix + header + added.join(eol) + eol, added };
}

/** Finds the repo for the transfer folder, offering git init when allowed. Returns the repo or undefined. */
async function resolveRepo(git, ui, settings, folder) {
    const repo = await git.findRepo(folder);
    if (repo || !settings.offerInit) {
        return repo || undefined;
    }
    // A pick list instead of buttons: full paths are too long for notification buttons.
    const items = git.initChoices(folder).map(choice => {
        const isTransferFolder = samePathKey(choice) === samePathKey(folder);
        return {
            label: `Create repository in ${path.basename(choice) || choice}`,
            description: isTransferFolder ? 'this folder only' : 'whole project (recommended)',
            detail: choice,
            folder: choice
        };
    });
    items.push({ label: 'Not now', description: 'skip git for this transfer' });
    const picked = await ui.pick(items, {
        title: 'Not in a git repository',
        placeHolder: `${path.basename(folder) || folder} is not in a git repository. Create one to record robot transfers?`
    });
    if (!picked || !picked.folder) {
        return undefined;
    }
    const created = await git.init(picked.folder);
    if (created) {
        created.isNew = true;
    }
    return created || undefined;
}

/**
 * The commit flow. Returns a short status string for logging and tests:
 * 'off' | 'no-files' | 'no-repo' | 'no-changes' | 'cancelled' | 'staged' | 'committed' | 'pushed'
 */
async function offerCommit({ git, ui, settings, result, now }) {
    const mode = result.kind === 'upload' ? settings.onUpload : settings.onDownload;
    if (mode !== 'prompt') {
        return 'off';
    }
    if (!result.files || result.files.length === 0) {
        return 'no-files';
    }

    const repo = await resolveRepo(git, ui, settings, result.folder);
    if (!repo) {
        return 'no-repo';
    }
    await repo.refresh();

    const transferred = [...result.files, ...(repo.createdFiles || [])];
    const ours = new Set(transferred.filter(file => isInside(repo.root, file)).map(file => samePathKey(file)));
    const changed = repo.changedPaths().filter(file => ours.has(samePathKey(file)));
    const staged = repo.stagedPaths();
    const ourStaged = staged.filter(file => ours.has(samePathKey(file)));
    const otherStaged = staged.filter(file => !ours.has(samePathKey(file)));
    let toCommit = [...new Set([...changed, ...ourStaged])];

    // A repository created just now: offer to include the files that were already in the folder.
    if (repo.isNew) {
        const everything = [...new Set([...repo.changedPaths(), ...staged])];
        const others = everything.length - toCommit.length;
        if (others > 0) {
            const all = `Commit all ${everything.length} files`;
            const onlyThis = `Only this transfer (${toCommit.length})`;
            const answer = await ui.choose(
                `New repository in ${repo.root}. It also has ${others} file(s) from before this transfer (earlier downloads, .vscode settings). Include them in the first commit?`,
                [all, onlyThis], { modal: true }
            );
            if (answer === all) {
                toCommit = everything;
            } else if (answer !== onlyThis) {
                return 'cancelled';
            }
        }
    }

    if (toCommit.length === 0) {
        ui.info(result.kind === 'upload'
            ? 'The uploaded files are already committed. Nothing to record.'
            : 'The files from the robot match the last commit. Nothing to commit.');
        return 'no-changes';
    }

    const defaultMessage = buildCommitMessage(settings.messageTemplate, messageVars(result, repo.root, toCommit.length, now));
    const message = await ui.input({
        prompt: `Commit ${toCommit.length} file(s) from "${result.operation}" to ${repo.branch() || 'the current branch'}. Press Esc to skip.`,
        value: defaultMessage,
        validateInput: value => value.trim() ? null : 'Enter a commit message, or press Esc to skip.'
    });
    if (!message || !message.trim()) {
        return 'cancelled';
    }

    let unstageOthers = false;
    if (otherStaged.length > 0) {
        const all = 'Commit anyway';
        const onlyOurs = 'Only robot files';
        const answer = await ui.choose(
            `${otherStaged.length} other staged file(s) are not from this transfer.`,
            [all, onlyOurs], { modal: true }
        );
        if (answer === onlyOurs) {
            unstageOthers = true;
        } else if (answer !== all) {
            return 'cancelled';
        }
    }

    if (settings.commitMode === 'confirm') {
        const commit = 'Commit';
        const review = 'Open Source Control';
        const answer = await ui.choose(`Commit ${toCommit.length} file(s) to ${repo.branch() || 'the current branch'}?`, [commit, review], { modal: true });
        if (answer === review) {
            await inChunks(toCommit, chunk => repo.add(chunk));
            await repo.showInSourceControl(message.trim());
            return 'staged';
        }
        if (answer !== commit) {
            return 'cancelled';
        }
    }

    if (unstageOthers) {
        await inChunks(otherStaged, chunk => repo.unstage(chunk));
    }
    try {
        await inChunks(toCommit, chunk => repo.add(chunk));
        await repo.commit(message.trim());
    } finally {
        if (unstageOthers) {
            await inChunks(otherStaged, chunk => repo.add(chunk));
        }
    }
    ui.info(`Committed ${toCommit.length} file(s) to ${repo.branch() || 'the current branch'}.`);

    const shouldPush = settings.push === 'always'
        || (settings.push === 'ask' && await ui.choose('Push the commit to the remote?', ['Push']) === 'Push');
    if (!shouldPush) {
        return 'committed';
    }
    if (!repo.hasRemote()) {
        ui.warn('This repository has no remote, so the commit was not pushed.');
        return 'committed';
    }
    try {
        await repo.push();
        return 'pushed';
    } catch (error) {
        ui.warn(`Committed, but the push failed: ${error.message}`);
        return 'committed';
    }
}

/** Parent folders that can hold a new repository, nearest first: the transfer folder and the workspace folder. */
function initChoicesFor(folder, workspaceRoot) {
    const choices = [];
    if (workspaceRoot && isInside(workspaceRoot, folder)) {
        choices.push(workspaceRoot);
    }
    if (!choices.some(choice => samePathKey(choice) === samePathKey(folder))) {
        choices.push(folder);
    }
    return choices;
}

module.exports = { DEFAULT_TEMPLATE, DEFAULT_IGNORE_PATTERNS, buildCommitMessage, messageVars, mergeGitignore, offerCommit, initChoicesFor, formatDate };
