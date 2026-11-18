// Integration tests: run inside VS Code with the extension loaded (npm test), in a copy of test/fixtures/workspace.
// They call commands the way menus and the editor do, and replace VS Code prompts with stubs so no one has to answer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'CoreyApplegate.robot-ftp';
const NEVER = () => new Promise(() => {}); // A notification that is never answered, like one that times out.

const workspaceRoot = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const lsPath = () => path.join(workspaceRoot(), 'Robot', 'MAIN.LS');
const lsUri = () => vscode.Uri.file(lsPath());
const csvPath = () => path.join(workspaceRoot(), '.vscode', 'descriptions', 'TEST.csv');

/** Resolves with the promise's value, or rejects when it takes longer than ms. */
function within(ms, promise, what) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms))
    ]);
}

/** Waits until check() returns a truthy value. */
async function waitFor(check, what, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

suite('Robot FTP commands (integration)', () => {
    const restores = [];
    const originals = {};
    let calls;

    /** Replaces obj[name] for one test; teardown puts the original back. */
    function stub(obj, name, fn) {
        const original = obj[name];
        obj[name] = fn;
        restores.push(() => { obj[name] = original; });
    }

    /** Records every prompt; quick picks and messages answer with the given functions (default: dismissed). */
    function stubPrompts({ quickPick = async () => undefined, info = async () => undefined, warning = async () => undefined } = {}) {
        calls = { quickPick: [], info: [], warning: [], error: [] };
        stub(vscode.window, 'showQuickPick', async (items, options) => {
            calls.quickPick.push({ items: await items, options });
            return quickPick(await items, options);
        });
        stub(vscode.window, 'showInformationMessage', (message, ...rest) => {
            calls.info.push({ message, rest });
            return info(message, ...rest);
        });
        stub(vscode.window, 'showWarningMessage', (message, ...rest) => {
            calls.warning.push({ message, rest });
            return warning(message, ...rest);
        });
        stub(vscode.window, 'showErrorMessage', async (message, ...rest) => {
            calls.error.push({ message, rest });
            return undefined;
        });
    }

    suiteSetup(async () => {
        await vscode.extensions.getExtension(EXTENSION_ID).activate();
        originals.csv = fs.readFileSync(csvPath(), 'utf8');
        originals.ls = fs.readFileSync(lsPath(), 'utf8');
    });

    setup(() => {
        // Each test starts from the fixture files. A new mtime makes the extension re-read them.
        const later = new Date(Date.now() + 1000);
        for (const [file, text] of [[csvPath(), originals.csv], [lsPath(), originals.ls]]) {
            fs.writeFileSync(file, text, 'utf8');
            fs.utimesSync(file, later, later);
        }
    });

    teardown(async () => {
        restores.splice(0).reverse().forEach(restore => restore());
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('activates and registers the description commands', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const id of ['extension.sendDescriptionsToRobot', 'extension.setDescription', 'extension.updateDescriptionsFromLsFile', 'extension.uploadFileToRobot']) {
            assert.ok(commands.includes(id), `${id} is registered`);
        }
    });

    test('Send Descriptions to Robot from the Explorer menu asks for the robot', async () => {
        stubPrompts();
        // The Explorer passes (clicked uri, selected uris). The second argument must not be taken as the robot.
        await within(5000, vscode.commands.executeCommand('extension.sendDescriptionsToRobot', lsUri(), [lsUri()]), 'Send Descriptions');
        assert.strictEqual(calls.quickPick.length, 1, 'the robot picker was shown once');
        assert.ok(calls.quickPick[0].items.some(item => item.robotName === 'TEST'), 'the picker lists the project robot');
        assert.ok(calls.error.some(call => /IP address selection is required/.test(call.message)), 'cancelling the picker stops the command');
    });

    test('an LS comment that differs from its description is marked, and a matching one is not', async () => {
        await vscode.window.showTextDocument(lsUri());
        const issues = await waitFor(() => {
            const found = vscode.languages.getDiagnostics(lsUri()).filter(item => item.source === 'LS Verifier' && item.code === 'descriptions');
            return found.length > 0 && found;
        }, 'description diagnostics');
        assert.deepStrictEqual(issues.map(item => item.range.start.line + 1), [27], 'only line 27, DO[2:Gripper Open], is marked');
        assert.strictEqual(issues[0].severity, vscode.DiagnosticSeverity.Warning);
        assert.match(issues[0].message, /Gripper Open.*Spare/);
    });

    test('Set Description saves the row and finishes even when its notification is never answered', async () => {
        stubPrompts({ info: NEVER });
        await within(5000, vscode.commands.executeCommand('extension.setDescription', lsUri(), 'DO[2]', 'Gripper Open'), 'Set Description');
        const csv = fs.readFileSync(csvPath(), 'utf8').split('\r\n').join('\n'); // Git may check the fixture out with CRLF.
        assert.strictEqual(csv, 'Key,Description\nDO[1],Clamp\nDO[2],Gripper Open\nR[10],Pick Count\n', 'only the DO[2] row changed');
        assert.ok(calls.info.some(call => /Saved to \.vscode\/descriptions\/TEST\.csv/.test(call.message)), 'the saved message offers Send to Robot');
    });

    test('Update Descriptions from LS Comments lists only differing comments and saves the picked ones', async () => {
        stubPrompts({ quickPick: async items => items, info: NEVER });
        await within(5000, vscode.commands.executeCommand('extension.updateDescriptionsFromLsFile', lsUri()), 'Update Descriptions');
        assert.deepStrictEqual(calls.quickPick[0].items.map(item => item.label), ['DO[2]'], 'DO[1] and R[10] already match');
        assert.match(fs.readFileSync(csvPath(), 'utf8'), /^DO\[2\],Gripper Open$/m);
    });

    test('Send This LS File lists differing LS comments first, and Cancel sends nothing', async () => {
        stubPrompts();
        await within(10000, vscode.commands.executeCommand('extension.uploadFileToRobot', lsUri()), 'Send This LS File');
        const question = calls.warning.find(call => /comment\(s\) in the LS file\(s\) differ/.test(call.message));
        assert.ok(question, `the differing comments are listed before the upload; messages shown: ${JSON.stringify([...calls.warning, ...calls.error, ...calls.info].map(call => call.message))}`);
        assert.match(question.rest[0].detail, /MAIN\.LS: DO\[2\] "Gripper Open" \(description: "Spare"\)/);
        assert.deepStrictEqual(question.rest.slice(1), ['Save and Send to Robot', 'Send Without Saving']);
        assert.strictEqual(calls.quickPick.length, 0, 'cancelled before asking for the robot');
        assert.strictEqual(fs.readFileSync(csvPath(), 'utf8'), originals.csv, 'the descriptions were not changed');
    });

    test('typing ":" adds ";" at the start of a line but not inside DO[7:', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'fanuctp', content: '   1\n   2:  DO[7\n' });
        const editor = await vscode.window.showTextDocument(document);

        await editor.edit(builder => builder.insert(new vscode.Position(0, 4), ':'));
        await waitFor(() => document.lineAt(0).text === '   1:;', 'the line end after "   1:"');

        await editor.edit(builder => builder.insert(new vscode.Position(1, 11), ':'));
        await new Promise(resolve => setTimeout(resolve, 300)); // Give the listener time to (wrongly) add ";".
        assert.strictEqual(document.lineAt(1).text, '   2:  DO[7:');
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
});
