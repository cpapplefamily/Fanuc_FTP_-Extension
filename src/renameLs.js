const path = require('path');

function validateProgramName(name) {
    if (!name || name.length > 36) {
        return 'Enter a program name with 1 to 36 characters (without .LS).';
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return 'Use letters, numbers, or underscores; the name cannot start with a number.';
    }
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
        return 'This name is reserved and cannot be used for a FANUC program.';
    }
    return undefined;
}

function findProgramName(text) {
    const match = /^(?:\uFEFF)?\/PROG[ \t]+([^\s]+)[^\r\n]*/m.exec(text);
    if (!match) {
        throw new Error('The LS file has no /PROG header. Add a valid header before renaming.');
    }
    const start = match.index + match[0].indexOf(match[1], match[0].indexOf('/PROG') + 5);
    return { start, end: start + match[1].length };
}

function validateProgramComment(comment) {
    if (comment.length > 16) {
        return 'Use at most 16 characters for the FANUC program comment.';
    }
    if (/[^A-Za-z0-9_@* ]/.test(comment)) {
        return 'Use letters, numbers, spaces, underscores (_), @, or *. Leave blank for no comment.';
    }
    return undefined;
}

function findProgramComment(text) {
    const attr = /^\/ATTR[^\r\n]*(\r?\n)/m.exec(text);
    if (!attr) {
        throw new Error('The LS file has no /ATTR section for the program comment.');
    }
    const start = attr.index + attr[0].length;
    const rest = text.slice(start);
    const nextSection = rest.search(/^\//m);
    const attributes = nextSection < 0 ? rest : rest.slice(0, nextSection);
    const comment = /^[ \t]*COMMENT[ \t]*=[ \t]*"([^"\r\n]*)"[ \t]*;/m.exec(attributes);
    if (comment) {
        const valueStart = start + comment.index + comment[0].indexOf('"') + 1;
        return { start: valueStart, end: valueStart + comment[1].length, value: comment[1], replacement: value => value };
    }
    if (/^[ \t]*COMMENT\b/m.test(attributes)) {
        throw new Error('The LS program COMMENT attribute is malformed. Correct it before renaming.');
    }
    return { start, end: start, value: '', replacement: value => `COMMENT = "${value}";${attr[1]}` };
}

function createRenameLsCommand(vscode, outputChannel) {
    return async function renameLsFile(resourceUri) {
        try {
            const uri = resourceUri || vscode.window.activeTextEditor?.document.uri;
            if (!uri || !/\.ls$/i.test(uri.path)) {
                throw new Error('Select an LS file to rename.');
            }
            const document = await vscode.workspace.openTextDocument(uri);
            if (document.isDirty) {
                throw new Error('Save the LS file before renaming it.');
            }
            const originalText = document.getText();
            const header = findProgramName(originalText);
            const extension = path.posix.extname(uri.path);
            const oldName = path.posix.basename(uri.path, extension);
            const name = await vscode.window.showInputBox({
                title: 'Rename LS File',
                prompt: 'New FANUC program name: 1–36 letters, numbers, or underscores; cannot start with a number. Enter without .LS.',
                value: oldName,
                ignoreFocusOut: true,
                validateInput: validateProgramName
            });
            if (name === undefined || name === oldName) {
                return;
            }
            const validationError = validateProgramName(name);
            if (validationError) {
                throw new Error(validationError);
            }
            if (document.isDirty || document.getText() !== originalText) {
                throw new Error('The LS file changed while entering the name. Save it and try again.');
            }
            const folder = vscode.Uri.joinPath(uri, '..');
            const entries = await vscode.workspace.fs.readDirectory(folder);
            const targetName = name + extension;
            if (entries.some(([entry]) => entry.toLowerCase() === targetName.toLowerCase())) {
                throw new Error(`A file named ${targetName} already exists (names are compared without case).`);
            }
            const commentField = findProgramComment(originalText);
            const comment = await vscode.window.showInputBox({
                title: 'FANUC Program Comment',
                prompt: 'Up to 16 characters: letters, numbers, spaces, _, @, or *. Leave blank for no comment.',
                value: commentField.value,
                ignoreFocusOut: true,
                validateInput: validateProgramComment
            });
            if (comment === undefined) {
                return;
            }
            const commentError = validateProgramComment(comment);
            if (commentError) {
                throw new Error(commentError);
            }
            if (document.isDirty || document.getText() !== originalText) {
                throw new Error('The LS file changed while entering the comment. Save it and try again.');
            }
            const target = vscode.Uri.joinPath(folder, targetName);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(document.positionAt(header.start), document.positionAt(header.end)), name);
            edit.replace(uri, new vscode.Range(document.positionAt(commentField.start), document.positionAt(commentField.end)), commentField.replacement(comment));
            edit.renameFile(uri, target, { overwrite: false, ignoreIfExists: false });
            if (!await vscode.workspace.applyEdit(edit)) {
                throw new Error('VS Code could not apply the rename.');
            }
            const renamedDocument = await vscode.workspace.openTextDocument(target);
            if (!await renamedDocument.save()) {
                throw new Error('The file was renamed, but the updated program name and comment could not be saved. Save the open document before uploading.');
            }
            outputChannel.appendLine(`Renamed ${path.posix.basename(uri.path)} to ${targetName}; updated /PROG name.`);
            vscode.window.showInformationMessage(`Renamed LS program to ${targetName}.`);
        } catch (error) {
            outputChannel.appendLine(`Rename LS file failed: ${error.message}`);
            vscode.window.showErrorMessage(`Could not rename LS file: ${error.message}`);
        }
    };
}

module.exports = { validateProgramName, validateProgramComment, findProgramName, findProgramComment, createRenameLsCommand };
