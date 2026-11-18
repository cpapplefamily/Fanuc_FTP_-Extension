/**
 * Adds the ";" that ends an LS line when ":" is typed at the start of a line, for example "  :" or "  12:".
 * This replaces the old ":" → ";" auto-closing pair, which also fired inside DO[7: and other comments.
 */

/** True when the ":" at colonIndex starts the line (only spaces and an optional line number before it) and nothing follows it. */
function shouldAddLineEnd(lineText, colonIndex) {
    return lineText[colonIndex] === ':'
        && /^\s*\d*\s*$/.test(lineText.slice(0, colonIndex))
        && lineText.slice(colonIndex + 1).trim() === '';
}

function registerLineEndAutoClose(vscode, context) {
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        // Typing only: one change of exactly ":" with nothing replaced; undo and redo are left alone.
        if (event.document.languageId !== 'fanuctp' || event.reason !== undefined || event.contentChanges.length !== 1) {
            return;
        }
        const change = event.contentChanges[0];
        if (change.text !== ':' || change.rangeLength !== 0) {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== event.document || editor.selections.length !== 1) {
            return;
        }
        const position = change.range.start;
        if (!shouldAddLineEnd(event.document.lineAt(position.line).text, position.character)) {
            return;
        }
        const afterColon = position.translate(0, 1);
        editor.edit(builder => builder.insert(afterColon, ';'), { undoStopBefore: false, undoStopAfter: false })
            .then(applied => {
                if (applied) {
                    editor.selection = new vscode.Selection(afterColon, afterColon);
                }
            });
    }));
}

module.exports = { shouldAddLineEnd, registerLineEndAutoClose };
