const defaultRules = require('./lsVerifierRules.json');
const { checks, runChecks, remarkLine, instructionColon } = require('./lsChecks');
const path = require('path');

function parseRules(text) {
    const config = JSON.parse(text);
    if (!config || ![1, 2].includes(config.version) || !Array.isArray(config.rules)) {
        throw new Error('Rules must have version: 1 or 2 and a rules array.');
    }
    const ids = new Set();
    for (const rule of config.rules) {
        if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)
            || typeof rule.enabled !== 'boolean'
            || (!checks.includes(rule.check) && (!['startsWith', 'endsWith'].includes(rule.check)
                || rule.section !== 'MN' || typeof rule.value !== 'string' || !rule.value || /[\r\n]/.test(rule.value)))
            || (rule.severity !== undefined && !['error', 'warning'].includes(rule.severity))
            || typeof rule.message !== 'string' || !rule.message) {
            throw new Error('Invalid verifier rule: use a unique id, enabled boolean, supported check, message, and optional error/warning severity. Literal checks also need section "MN" and a nonempty value.');
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
    text.split(/\r?\n/).forEach((line, lineNumber) => {
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
            check(line, lineNumber, ['startsWith', 'endsWith']);
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
    if (config.version === 2) return undefined;
    const ids = new Set(config.rules.map(rule => rule.id));
    for (const rule of defaultRules.rules.filter(rule => checks.includes(rule.check))) {
        if (config.rules.some(existing => existing.check === rule.check)) continue;
        let id = rule.id;
        while (ids.has(id)) id += '-new';
        config.rules.push({ ...rule, id });
        ids.add(id);
    }
    config.version = 2;
    return JSON.stringify(config, null, 2) + '\n';
}

function registerLsVerifier(vscode, context, outputChannel) {
    const diagnostics = vscode.languages.createDiagnosticCollection('robotFtpVerifier');
    const rulesUri = vscode.Uri.joinPath(context.globalStorageUri, 'ls-verifier-rules.json');
    async function ensureRules() {
        try {
            await vscode.workspace.fs.stat(rulesUri);
        } catch (error) {
            if (error.code !== 'FileNotFound') throw error;
            await vscode.workspace.fs.createDirectory(context.globalStorageUri);
            await vscode.workspace.fs.writeFile(rulesUri, Buffer.from(JSON.stringify(defaultRules, null, 2) + '\n'));
        }
        const document = await vscode.workspace.openTextDocument(rulesUri);
        const upgraded = upgradeRules(document.getText());
        if (upgraded) {
            if (document.isDirty) throw new Error('Save your verifier rules before upgrading them with the new checks.');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(rulesUri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), upgraded);
            if (!await vscode.workspace.applyEdit(edit) || !await document.save()) throw new Error('Could not save upgraded verifier rules.');
        }
        return document;
    }
    const openRules = vscode.commands.registerCommand('extension.openLsVerifierRules', async () => {
        try {
            await vscode.window.showTextDocument(await ensureRules());
        } catch (error) {
            vscode.window.showErrorMessage(`Could not open LS verifier rules: ${error.message}`);
        }
    });
    const verify = vscode.commands.registerCommand('extension.verifyLsFile', async resourceUri => {
        const uri = resourceUri || vscode.window.activeTextEditor?.document.uri;
        try {
            if (!uri || !/\.ls$/i.test(uri.path)) throw new Error('Select an LS file to verify.');
            diagnostics.delete(uri);
            const document = await vscode.workspace.openTextDocument(uri);
            const rulesDocument = await ensureRules();
            const rules = parseRules(rulesDocument.getText());
            if (!rules.some(rule => rule.enabled)) throw new Error('No verifier rules are enabled. Edit LS Verifier Rules to enable checks.');
            const options = { fileName: path.posix.basename(uri.path) };
            if (rules.some(rule => rule.enabled && rule.check === 'calls')) {
                const folder = vscode.workspace.getWorkspaceFolder(uri);
                const files = folder
                    ? await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{ls,LS,Ls,lS,tp,TP,Tp,tP,pc,PC,Pc,pC}'))
                    : (await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(uri, '..')))
                        .filter(([name, type]) => (type & vscode.FileType.File) && /\.(ls|tp|pc)$/i.test(name))
                        .map(([name]) => ({ path: name }));
                options.localPrograms = files.map(file => path.posix.basename(file.path).replace(/\.[^.]+$/, ''));
                const self = /^\s*\/PROG\s+(\S+)/m.exec(document.getText());
                if (self) options.localPrograms.push(self[1]);
            }
            const issues = verifyLs(document.getText(), rules, options);
            diagnostics.set(uri, issues.map(issue => {
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(issue.line, issue.start, issue.line, issue.end),
                    issue.message, issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
                );
                diagnostic.source = 'LS Verifier';
                diagnostic.code = issue.code;
                return diagnostic;
            }));
            outputChannel.appendLine(`LS verification: ${uri.fsPath}: ${issues.length} issue(s). Rules: ${rulesUri.fsPath}`);
            if (issues.length) {
                vscode.window.showWarningMessage(`LS verification found ${issues.length} issue(s). See the Problems panel.`);
                await vscode.commands.executeCommand('workbench.actions.view.problems');
            } else {
                vscode.window.showInformationMessage('LS verification passed the enabled rules.');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`LS verification failed: ${error.message}`);
        }
    });
    context.subscriptions.push(diagnostics, openRules, verify,
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() === rulesUri.toString()) diagnostics.clear();
            else diagnostics.delete(event.document.uri);
        }),
        vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri))
    );
}

module.exports = { parseRules, verifyLs, upgradeRules, registerLsVerifier };
