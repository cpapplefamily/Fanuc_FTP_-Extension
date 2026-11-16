const defaultRules = require('./lsVerifierRules.json');
const { checks, runChecks, remarkLine, instructionColon } = require('./lsChecks');
const path = require('path');

// Version 3 (2026-11-16) split "JMP LBL[n] has no matching label" out of "labels" into its own "jumpTargets" rule.
// Version 4 (2026-11-16) added "extraColon" ("1: :!text ;").
// Severities: "critical" blocks uploads, "error" asks before sending, "warning" never stops an upload.
const SEVERITIES = ['critical', 'error', 'warning'];

// Changes to the built-in defaults of existing rules. A user's rules file never changes by itself, so after an
// update these are offered (once) for rules that still have the old default; rules the user changed are left alone.
// Add an entry with the next revision number whenever a default in lsVerifierRules.json changes.
const DEFAULT_CHANGES = [
    { revision: 1, id: 'delimiters', field: 'severity', from: 'error', to: 'critical', reason: 'unclosed brackets or quotes make the robot reject the file' },
    { revision: 1, id: 'extraColon', field: 'severity', from: 'error', to: 'critical', reason: 'a second ":" after the line number makes the robot reject the file' }
];
const DEFAULTS_REVISION = Math.max(0, ...DEFAULT_CHANGES.map(change => change.revision));

/** Default changes newer than seenRevision that apply to this rules text (the rule still has the old default). */
function pendingDefaultChanges(text, seenRevision = 0) {
    const rules = parseRules(text);
    return DEFAULT_CHANGES.filter(change => {
        if (change.revision <= seenRevision) return false;
        const rule = rules.find(existing => existing.id === change.id);
        const current = change.field === 'severity' ? (rule?.severity || 'error') : rule?.[change.field];
        return rule !== undefined && current === change.from;
    });
}

/** Applies the chosen default changes to the rules text; everything else in the file is kept. */
function applyDefaultChanges(text, changes) {
    const config = JSON.parse(text);
    for (const change of changes) {
        const rule = config.rules.find(existing => existing.id === change.id);
        if (rule) rule[change.field] = change.to;
    }
    return JSON.stringify(config, null, 2) + '\n';
}
const RULES_VERSION = defaultRules.version;

function parseRules(text) {
    const config = JSON.parse(text);
    if (!config || !Number.isInteger(config.version) || config.version < 1 || config.version > RULES_VERSION || !Array.isArray(config.rules)) {
        throw new Error(`Rules must have a version from 1 to ${RULES_VERSION} and a rules array.`);
    }
    const ids = new Set();
    for (const rule of config.rules) {
        if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)
            || typeof rule.enabled !== 'boolean'
            || (!checks.includes(rule.check) && (!['startsWith', 'endsWith'].includes(rule.check)
                || rule.section !== 'MN' || typeof rule.value !== 'string' || !rule.value || /[\r\n]/.test(rule.value)))
            || (rule.severity !== undefined && !SEVERITIES.includes(rule.severity))
            || typeof rule.message !== 'string' || !rule.message) {
            throw new Error('Invalid verifier rule: use a unique id, enabled boolean, supported check, message, and optional severity (critical, error or warning). Literal checks also need section "MN" and a nonempty value.');
        }
        ids.add(rule.id);
    }
    return config.rules;
}

function verifyLs(text, rules, options = {}) {
    const issues = [];
    let section = '';
    let foundMn = false;
    let pending; // Last line of a wrapped --eg: remark, waiting for its continuation.
    function check(line, lineNumber, kinds) {
        const colon = instructionColon(line);
        const content = (colon < 0 ? line : line.slice(colon)).trim();
        for (const rule of rules) {
            if (rule.enabled && kinds.includes(rule.check) && !content[rule.check](rule.value)) {
                issues.push({ line: lineNumber, start: Math.max(0, colon), end: line.length, message: rule.message, code: rule.id, severity: rule.severity || 'error' });
            }
        }
    }
    // A wrapped remark that never reached its ';' line is checked like a normal line.
    function flush() {
        if (pending) check(pending.line, pending.lineNumber, ['endsWith']);
        pending = undefined;
    }
    const lines = text.split(/\r?\n/);
    // An instruction can continue on the next line, which starts with ':' and has no line number,
    // e.g. a circular move "20:  C P[5]" + "    :  P[6] 100mm/sec CNT100 ;" (also when commented out with //).
    // The ';' then belongs on the last line, so the line before a continuation needs none.
    function continuesOnNextLine(lineNumber) {
        let next = lineNumber + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        return next < lines.length && /^\s*:/.test(lines[next]);
    }
    lines.forEach((line, lineNumber) => {
        const marker = /^\s*\/([A-Z]+)(?:\s|$)/.exec(line);
        if (marker) {
            flush();
            section = marker[1];
            if (section === 'MN') foundMn = true;
            return;
        }
        if (section !== 'MN' || !line.trim()) return;
        const remark = remarkLine(Boolean(pending), line);
        if (remark.continuation) pending = undefined;
        else flush();
        if (remark.open) {
            check(line, lineNumber, ['startsWith']);
            pending = { line, lineNumber };
        } else {
            check(line, lineNumber, continuesOnNextLine(lineNumber) ? ['startsWith'] : ['startsWith', 'endsWith']);
        }
    });
    flush();
    if (!foundMn && !rules.some(rule => rule.enabled && rule.check === 'sections')) {
        issues.push({ line: 0, start: 0, end: 0, message: 'No /MN section found; instruction rules could not be checked.', code: 'missing-mn' });
    }
    return issues.concat(runChecks(text, rules, options));
}

function upgradeRules(text) {
    parseRules(text);
    const config = JSON.parse(text);
    if (config.version === RULES_VERSION) return undefined;
    const ids = new Set(config.rules.map(rule => rule.id));
    for (const rule of defaultRules.rules.filter(rule => checks.includes(rule.check))) {
        if (config.rules.some(existing => existing.check === rule.check)) continue;
        let id = rule.id;
        while (ids.has(id)) id += '-new';
        const added = { ...rule, id };
        // jumpTargets used to be part of labels: keep the user's labels setting.
        const labels = config.rules.find(existing => existing.check === 'labels');
        if (rule.check === 'jumpTargets' && labels) {
            added.enabled = labels.enabled;
            added.severity = labels.severity || 'error';
        }
        // Insert after the rule that comes before it in the template, so the file keeps the template order.
        const template = defaultRules.rules;
        let after = -1;
        for (let i = template.indexOf(rule) - 1; i >= 0 && after < 0; i--) {
            after = config.rules.findIndex(existing => existing.check === template[i].check);
        }
        if (after >= 0) config.rules.splice(after + 1, 0, added);
        else config.rules.push(added);
        ids.add(id);
    }
    config.version = RULES_VERSION;
    return JSON.stringify(config, null, 2) + '\n';
}

function registerLsVerifier(vscode, context, outputChannel) {
    const diagnostics = vscode.languages.createDiagnosticCollection('robotFtpVerifier');
    const rulesUri = vscode.Uri.joinPath(context.globalStorageUri, 'ls-verifier-rules.json');
    const REVISION_KEY = 'robotFtp.lsRulesDefaultsRevision';
    async function replaceRulesText(document, text, failure) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(rulesUri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        if (!await vscode.workspace.applyEdit(edit) || !await document.save()) throw new Error(failure);
    }
    // After an update, offer built-in default changes for rules the user has not changed. Asked once per revision.
    async function offerDefaultChanges(document) {
        const seen = context.globalState.get(REVISION_KEY, 0);
        if (seen >= DEFAULTS_REVISION || document.isDirty) return;
        const pending = pendingDefaultChanges(document.getText(), seen);
        if (pending.length > 0) {
            const picked = await vscode.window.showQuickPick(pending.map(change => ({
                label: `${change.id}: ${change.field} ${change.from} → ${change.to}`,
                detail: change.reason,
                picked: true,
                change
            })), {
                canPickMany: true,
                ignoreFocusOut: true,
                title: 'New LS verifier defaults',
                placeHolder: 'Updated defaults for rules you have not changed. Uncheck any to keep your current setting, then press Enter.'
            });
            if (picked && picked.length > 0) {
                await replaceRulesText(document, applyDefaultChanges(document.getText(), picked.map(item => item.change)), 'Could not save the updated verifier rules.');
                outputChannel.appendLine(`LS verifier rules: applied new defaults: ${picked.map(item => item.label).join('; ')}`);
            }
        }
        await context.globalState.update(REVISION_KEY, DEFAULTS_REVISION);
    }
    async function ensureRules() {
        try {
            await vscode.workspace.fs.stat(rulesUri);
        } catch (error) {
            if (error.code !== 'FileNotFound') throw error;
            await vscode.workspace.fs.createDirectory(context.globalStorageUri);
            await vscode.workspace.fs.writeFile(rulesUri, Buffer.from(JSON.stringify(defaultRules, null, 2) + '\n'));
            await context.globalState.update(REVISION_KEY, DEFAULTS_REVISION); // a new file already has the current defaults
        }
        const document = await vscode.workspace.openTextDocument(rulesUri);
        const upgraded = upgradeRules(document.getText());
        if (upgraded) {
            if (document.isDirty) throw new Error('Save your verifier rules before upgrading them with the new checks.');
            await replaceRulesText(document, upgraded, 'Could not save upgraded verifier rules.');
        }
        await offerDefaultChanges(document);
        return document;
    }
    const resetRules = vscode.commands.registerCommand('extension.resetLsVerifierRules', async () => {
        try {
            const reset = 'Reset to Defaults';
            const answer = await vscode.window.showWarningMessage(
                'Replace your LS verifier rules with the built-in defaults?',
                { modal: true, detail: 'Your current rules file is saved as a backup copy first, so your changes can be restored.' },
                reset
            );
            if (answer !== reset) return;
            let backupUri;
            try {
                const current = await vscode.workspace.fs.readFile(rulesUri);
                const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
                backupUri = vscode.Uri.joinPath(context.globalStorageUri, `ls-verifier-rules.backup-${stamp}.json`);
                await vscode.workspace.fs.writeFile(backupUri, current);
            } catch (error) {
                if (error.code !== 'FileNotFound') throw error;
            }
            await context.globalState.update(REVISION_KEY, DEFAULTS_REVISION); // no "new defaults" question: everything is reset
            const document = await ensureRules();
            if (document.isDirty) throw new Error('Save or undo your unsaved edits in the rules file first.');
            await replaceRulesText(document, JSON.stringify(defaultRules, null, 2) + '\n', 'Could not save the default verifier rules.');
            await context.globalState.update(REVISION_KEY, DEFAULTS_REVISION);
            diagnostics.clear();
            outputChannel.appendLine(`LS verifier rules reset to defaults.${backupUri ? ` Backup: ${backupUri.fsPath}` : ''}`);
            await vscode.window.showTextDocument(document);
            if (backupUri) {
                const open = 'Open Backup';
                if (await vscode.window.showInformationMessage(`LS verifier rules reset to defaults. Your previous rules were saved as ${path.basename(backupUri.fsPath)}.`, open) === open) {
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(backupUri), { preview: false });
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Could not reset LS verifier rules: ${error.message}`);
        }
    });
    const openRules = vscode.commands.registerCommand('extension.openLsVerifierRules', async () => {
        try {
            await vscode.window.showTextDocument(await ensureRules());
        } catch (error) {
            vscode.window.showErrorMessage(`Could not open LS verifier rules: ${error.message}`);
        }
    });
    // Local program names for the "calls" check, cached per workspace folder (or directory) during one run.
    async function localProgramsFor(uri, cache) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const key = folder ? folder.uri.toString() : vscode.Uri.joinPath(uri, '..').toString();
        if (!cache.has(key)) {
            const files = folder
                ? await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{ls,LS,Ls,lS,tp,TP,Tp,tP,pc,PC,Pc,pC}'))
                : (await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(uri, '..')))
                    .filter(([name, type]) => (type & vscode.FileType.File) && /\.(ls|tp|pc)$/i.test(name))
                    .map(([name]) => ({ path: name }));
            cache.set(key, files.map(file => path.posix.basename(file.path).replace(/\.[^.]+$/, '')));
        }
        return cache.get(key);
    }
    async function verifyText(uri, text, rules, cache = new Map()) {
        const options = { fileName: path.posix.basename(uri.path) };
        if (rules.some(rule => rule.enabled && rule.check === 'calls')) {
            options.localPrograms = [...await localProgramsFor(uri, cache)];
            const self = /^\s*\/PROG\s+(\S+)/m.exec(text);
            if (self) options.localPrograms.push(self[1]);
        }
        return verifyLs(text, rules, options);
    }
    function showDiagnostics(uri, issues) {
        diagnostics.set(uri, issues.map(issue => {
            // VS Code has no level above Error, so critical findings are Errors labeled "Critical:".
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(issue.line, issue.start, issue.line, issue.end),
                issue.severity === 'critical' ? `Critical: ${issue.message} (blocks sending to the robot)` : issue.message,
                issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'LS Verifier';
            diagnostic.code = issue.code;
            return diagnostic;
        }));
    }
    const verify = vscode.commands.registerCommand('extension.verifyLsFile', async resourceUri => {
        const uri = resourceUri || vscode.window.activeTextEditor?.document.uri;
        try {
            if (!uri || !/\.ls$/i.test(uri.path)) throw new Error('Select an LS file to verify.');
            diagnostics.delete(uri);
            const document = await vscode.workspace.openTextDocument(uri);
            const rulesDocument = await ensureRules();
            const rules = parseRules(rulesDocument.getText());
            if (!rules.some(rule => rule.enabled)) throw new Error('No verifier rules are enabled. Edit LS Verifier Rules to enable checks.');
            const issues = await verifyText(uri, document.getText(), rules);
            showDiagnostics(uri, issues);
            outputChannel.appendLine(`LS verification: ${uri.fsPath}: ${issues.length} issue(s). Rules: ${rulesUri.fsPath}`);
            const critical = issues.filter(issue => issue.severity === 'critical').length;
            if (critical) {
                vscode.window.showErrorMessage(`LS verification found ${issues.length} issue(s), ${critical} critical. This file cannot be sent to the robot until the critical issues are fixed. See the Problems panel.`);
                await vscode.commands.executeCommand('workbench.actions.view.problems');
            } else if (issues.length) {
                vscode.window.showWarningMessage(`LS verification found ${issues.length} issue(s). See the Problems panel.`);
                await vscode.commands.executeCommand('workbench.actions.view.problems');
            } else {
                vscode.window.showInformationMessage('LS verification passed the enabled rules.');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`LS verification failed: ${error.message}`);
        }
    });
    context.subscriptions.push(diagnostics, openRules, verify, resetRules,
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() === rulesUri.toString()) diagnostics.clear();
            else diagnostics.delete(event.document.uri);
        }),
        vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri))
    );

    return {
        /**
         * Checks the saved contents of LS files (what an upload sends) and shows the issues in the Problems panel.
         * Returns { skipped: true } when no rules are enabled, otherwise { results: [{ uri, issues }] }. Throws on invalid rules.
         */
        async checkFiles(uris) {
            const rules = parseRules((await ensureRules()).getText());
            if (!rules.some(rule => rule.enabled)) return { skipped: true, results: [] };
            const cache = new Map();
            const results = [];
            for (const uri of uris) {
                const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                const issues = await verifyText(uri, text, rules, cache);
                showDiagnostics(uri, issues);
                results.push({ uri, issues });
            }
            return { skipped: false, results };
        }
    };
}

module.exports = { parseRules, verifyLs, upgradeRules, registerLsVerifier, pendingDefaultChanges, applyDefaultChanges, DEFAULTS_REVISION };
