const vscode = require('vscode');
const ftp = require('basic-ftp');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createRenameLsCommand } = require('./renameLs');
const { registerLsVerifier } = require('./lsVerifier');
const {
    IP_PATTERN, OTHER_OPTION, cleanRecentIps, addRecentIp, isValidPort, getProjectIpsPath,
    readProjectConfig, saveProjectRecentIp, saveProjectRobot, ensureProjectFile, buildIpOptions, folderChoices, robotForPath
} = require('./robotIps');
const {
    parseDescriptionsCsv, mergeDescriptions, findDescriptionKeys,
    findInlineComments, inlineCommentMatches, setDescriptionInCsv,
    getSharedDescriptionsPath, getRobotDescriptionsPath, ensureDescriptionsFile
} = require('./descriptions');
const {
    BACKUP_FILES, findBackupFiles, readBackupDescriptions, compareDescriptions, combineDescriptions, serializeDescriptionsCsv
} = require('./backupDescriptions');
const { planDescriptionPush, sendComment } = require('./pushDescriptions');
const { registerLineEndAutoClose } = require('./lineEndAutoClose');
const { DEFAULT_FOLDERS, DEFAULT_SYSTEM_PROGRAMS, sortDownloadedFiles, listFilesRecursive, planRestoreFolder } = require('./backupSort');
const { DEFAULT_TEMPLATE, DEFAULT_IGNORE_PATTERNS, mergeGitignore, offerCommit, initChoicesFor } = require('./gitIntegration');
const {
    loadSnippetDefinitions,
    PROJECT_SNIPPETS_TEMPLATE,
    USER_SNIPPETS_TEMPLATE
} = require('./externalSnippets');

const outputChannel = vscode.window.createOutputChannel("Robot File Sync");
let extensionContext;
let lsVerifier; // { checkFiles(uris) } from registerLsVerifier

const EXTERNAL_SNIPPETS_STATE_KEY = 'robotFtp.externalSnippetsPath';
const EXTERNAL_SNIPPETS_CONFIG_KEY = 'externalSnippetsFile';
const USER_SNIPPETS_FILENAME = 'fanuc-snippets.code-snippets';
let managedSnippetDefinitions = [];
let externalSnippetDefinitions = [];
let externalSnippetWatcher;

function ensureManagedSnippetFile(context) {
    const snippetFilePath = path.join(context.globalStorageUri.fsPath, USER_SNIPPETS_FILENAME);
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

    if (!fs.existsSync(snippetFilePath)) {
        fs.writeFileSync(snippetFilePath, USER_SNIPPETS_TEMPLATE, 'utf8');
        outputChannel.appendLine(`Created managed Fanuc snippet file at ${snippetFilePath}`);
    }

    return snippetFilePath;
}

/**
 * Where folder pickers start: the right-clicked folder (or a right-clicked file's folder),
 * then the folder of the file open in the editor, then the workspace root.
 */
function defaultFolderUri(resourceUri) {
    const folderOf = uri => {
        if (!uri || uri.scheme !== 'file') {
            return undefined;
        }
        try {
            return fs.statSync(uri.fsPath).isDirectory() ? uri : vscode.Uri.file(path.dirname(uri.fsPath));
        } catch {
            return undefined;
        }
    };
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    const workspaceFolder = (editorUri && vscode.workspace.getWorkspaceFolder(editorUri)) || vscode.workspace.workspaceFolders?.[0];
    return folderOf(resourceUri) || folderOf(editorUri) || workspaceFolder?.uri;
}

async function selectWorkspaceFolder(resourceUri) {
    if (resourceUri) {
        const resourceFolder = vscode.workspace.getWorkspaceFolder(resourceUri);
        if (resourceFolder) {
            return resourceFolder;
        }
    }

    const editorUri = vscode.window.activeTextEditor?.document.uri;
    if (editorUri) {
        const editorFolder = vscode.workspace.getWorkspaceFolder(editorUri);
        if (editorFolder) {
            return editorFolder;
        }
    }

    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    if (workspaceFolders.length === 1) {
        return workspaceFolders[0];
    }

    if (workspaceFolders.length > 1) {
        const selected = await vscode.window.showQuickPick(
            workspaceFolders.map(folder => ({
                label: folder.name,
                description: folder.uri.fsPath,
                folder
            })),
            { placeHolder: 'Select the project for Fanuc snippets' }
        );
        return selected?.folder;
    }

    return undefined;
}

async function openProjectSnippetFile(resourceUri) {
    const workspaceFolder = await selectWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open a project folder before creating project Fanuc snippets.');
        return;
    }

    const vscodeFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
    const snippetFileUri = vscode.Uri.joinPath(vscodeFolderUri, USER_SNIPPETS_FILENAME);
    await vscode.workspace.fs.createDirectory(vscodeFolderUri);

    try {
        await vscode.workspace.fs.stat(snippetFileUri);
    } catch (error) {
        if (error.code !== 'FileNotFound') {
            throw error;
        }
        await vscode.workspace.fs.writeFile(snippetFileUri, Buffer.from(PROJECT_SNIPPETS_TEMPLATE, 'utf8'));
        outputChannel.appendLine(`Created project Fanuc snippet file at ${snippetFileUri.toString()}`);
    }

    const document = await vscode.workspace.openTextDocument(snippetFileUri);
    await vscode.window.showTextDocument(document);
}

function registerSnippetWatcher(context, snippetFilePath, sourceLabel, onLoad, onDelete) {
    const pattern = new vscode.RelativePattern(path.dirname(snippetFilePath), path.basename(snippetFilePath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = () => {
        const definitions = loadSnippetFile(snippetFilePath, sourceLabel, false);
        if (definitions) {
            onLoad(definitions);
        }
    };
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(() => {
        onDelete();
        vscode.window.showWarningMessage(`${sourceLabel} Fanuc snippet file was removed: ${snippetFilePath}`);
    });

    context.subscriptions.push(watcher);
    return watcher;
}

function loadSnippetFile(snippetFilePath, sourceLabel, showSuccess = true) {
    try {
        const loadedDefinitions = loadSnippetDefinitions(snippetFilePath);
        outputChannel.appendLine(`Loaded ${loadedDefinitions.length} ${sourceLabel.toLowerCase()} Fanuc snippets from ${snippetFilePath}`);

        if (showSuccess) {
            vscode.window.showInformationMessage(`Loaded ${loadedDefinitions.length} ${sourceLabel.toLowerCase()} Fanuc snippets.`);
        }
        return loadedDefinitions;
    } catch (error) {
        outputChannel.appendLine(`Failed to load ${sourceLabel.toLowerCase()} Fanuc snippets from ${snippetFilePath}: ${error.message}`);
        vscode.window.showErrorMessage(`Could not load ${sourceLabel.toLowerCase()} Fanuc snippets: ${error.message}`);
        return undefined;
    }
}

function createExternalSnippetCompletionProvider() {
    return vscode.languages.registerCompletionItemProvider('fanuctp', {
        provideCompletionItems() {
            return [...managedSnippetDefinitions, ...externalSnippetDefinitions].map((definition) => {
                const item = new vscode.CompletionItem({
                    label: definition.prefix,
                    description: definition.name
                }, vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString(definition.body);
                item.filterText = definition.prefix;
                item.detail = 'External Fanuc snippet';
                if (definition.description) {
                    item.documentation = new vscode.MarkdownString(definition.description);
                }
                return item;
            });
        }
    });
}



// Make the activate function async
async function activate(context) {
    extensionContext = context;
    outputChannel.show();
    lsVerifier = registerLsVerifier(vscode, context, outputChannel, { descriptionsFor: descriptionTextsFor });
    registerLineEndAutoClose(vscode, context);
    context.subscriptions.push(vscode.commands.registerCommand(
        'extension.renameLsFile', createRenameLsCommand(vscode, outputChannel)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'extension.openSettings',
        () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
    ));
    context.subscriptions.push(vscode.commands.registerCommand('extension.editRobotList', openRobotList));
    context.subscriptions.push(vscode.commands.registerCommand('extension.resetReminders', resetReminders));
    context.subscriptions.push(vscode.commands.registerCommand('extension.makeRestoreFolder', makeRestoreFolder));

    const managedSnippetFilePath = ensureManagedSnippetFile(context);
    const loadedManagedSnippets = loadSnippetFile(managedSnippetFilePath, 'User', false);
    if (loadedManagedSnippets) {
        managedSnippetDefinitions = loadedManagedSnippets;
    }
    registerSnippetWatcher(
        context,
        managedSnippetFilePath,
        'User',
        definitions => { managedSnippetDefinitions = definitions; },
        () => {
            managedSnippetDefinitions = [];
            ensureManagedSnippetFile(context);
        }
    );

    const externalSnippetProvider = createExternalSnippetCompletionProvider();
    const openUserSnippets = vscode.commands.registerCommand('extension.openUserSnippets', async () => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(managedSnippetFilePath));
        await vscode.window.showTextDocument(document);
    });
    const openProjectSnippets = vscode.commands.registerCommand('extension.openProjectSnippets', async (resourceUri) => {
        try {
            await openProjectSnippetFile(resourceUri);
        } catch (error) {
            outputChannel.appendLine(`Failed to open project Fanuc snippets: ${error.message}`);
            vscode.window.showErrorMessage(`Could not open project Fanuc snippets: ${error.message}`);
        }
    });
    const selectExternalSnippets = vscode.commands.registerCommand('extension.selectExternalSnippets', async () => {
        const currentExternal = vscode.workspace.getConfiguration('robotFtp').get(EXTERNAL_SNIPPETS_CONFIG_KEY, '');
        const selectedFiles = await vscode.window.showOpenDialog({
            defaultUri: currentExternal && fs.existsSync(path.dirname(currentExternal))
                ? vscode.Uri.file(path.dirname(currentExternal))
                : defaultFolderUri(undefined),
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Load Fanuc Snippets',
            filters: {
                'VS Code Snippets': ['code-snippets', 'json']
            }
        });

        if (!selectedFiles || selectedFiles.length === 0) {
            return;
        }

        const snippetFilePath = selectedFiles[0].fsPath;
        const loadedExternalSnippets = loadSnippetFile(snippetFilePath, 'External');
        if (loadedExternalSnippets) {
            externalSnippetDefinitions = loadedExternalSnippets;
            await context.globalState.update(EXTERNAL_SNIPPETS_STATE_KEY, snippetFilePath);
            await vscode.workspace.getConfiguration('robotFtp').update(
                EXTERNAL_SNIPPETS_CONFIG_KEY,
                snippetFilePath,
                vscode.ConfigurationTarget.Global
            );
            if (externalSnippetWatcher) {
                externalSnippetWatcher.dispose();
            }
            externalSnippetWatcher = registerSnippetWatcher(
                context,
                snippetFilePath,
                'External',
                definitions => { externalSnippetDefinitions = definitions; },
                () => { externalSnippetDefinitions = []; }
            );
        }
    });
    const clearExternalSnippets = vscode.commands.registerCommand('extension.clearExternalSnippets', async () => {
        externalSnippetDefinitions = [];
        if (externalSnippetWatcher) {
            externalSnippetWatcher.dispose();
            externalSnippetWatcher = undefined;
        }
        await context.globalState.update(EXTERNAL_SNIPPETS_STATE_KEY, undefined);
        await vscode.workspace.getConfiguration('robotFtp').update(
            EXTERNAL_SNIPPETS_CONFIG_KEY,
            undefined,
            vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage('External Fanuc snippets cleared. Built-in and user snippets are still available.');
    });

    context.subscriptions.push(externalSnippetProvider, openUserSnippets, openProjectSnippets, selectExternalSnippets, clearExternalSnippets);

    const configuredSnippetFilePath = vscode.workspace.getConfiguration('robotFtp').get(EXTERNAL_SNIPPETS_CONFIG_KEY, '');
    const savedSnippetFilePath = configuredSnippetFilePath || context.globalState.get(EXTERNAL_SNIPPETS_STATE_KEY);
    if (savedSnippetFilePath) {
        const loadedExternalSnippets = loadSnippetFile(savedSnippetFilePath, 'External', false);
        if (loadedExternalSnippets) {
            externalSnippetDefinitions = loadedExternalSnippets;
        }
        externalSnippetWatcher = registerSnippetWatcher(
            context,
            savedSnippetFilePath,
            'External',
            definitions => { externalSnippetDefinitions = definitions; },
            () => { externalSnippetDefinitions = []; }
        );

        if (!configuredSnippetFilePath) {
            await vscode.workspace.getConfiguration('robotFtp').update(
                EXTERNAL_SNIPPETS_CONFIG_KEY,
                savedSnippetFilePath,
                vscode.ConfigurationTarget.Global
            );
        }
    }

    const downloadAll_Function = vscode.commands.registerCommand("extension.downloadAllFiles", async (resourceUri) => {
        // Prompt the user to select a folder
        const destinationFolder = await vscode.window.showOpenDialog({
            defaultUri: defaultFolderUri(resourceUri),
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Select Destination Folder"
        });

        if (!destinationFolder || destinationFolder.length === 0) {
            vscode.window.showErrorMessage("You must select a destination folder.");
            return;
        }

        const destinationUri = destinationFolder[0];
        //await f_downloadFromRobot(destinationUri, true, ".ls"); // Pass true for folder operations
        await f_downloadFromRobot(destinationUri, true, "*", "ALL"); // Pass true for folder operations
    });
    const downloadLs_Function = vscode.commands.registerCommand("extension.downloadLsFiles", async (resourceUri) => {
        // Prompt the user to select a folder
        const destinationFolder = await vscode.window.showOpenDialog({
            defaultUri: defaultFolderUri(resourceUri),
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Select Destination Folder"
        });

        if (!destinationFolder || destinationFolder.length === 0) {
            vscode.window.showErrorMessage("You must select a destination folder.");
            return;
        }

        const destinationUri = destinationFolder[0];
        await f_downloadFromRobot(destinationUri, true, ".ls", "LS"); // Pass true for folder operations
    });
    
    const updateLsFilesFromRobot_Function = vscode.commands.registerCommand("extension.updateFilesFromRobotLsFiles", async (resourceUri) => {
        await f_updateFilesFromRobot(".ls", resourceUri);
    });

    const updateSelectedFileFromRobot_Function = vscode.commands.registerCommand("extension.updateSelectedFileFromRobot", async (uri) => {
        await f_updateSelectedFileFromRobot(uri, ".ls");
    });


    // Command for uploading a file
    let uploadFile_Function = vscode.commands.registerCommand('extension.uploadFileToRobot', async (uri) => {
        await f_uploadToRobot(uri, false); // false indicates it's a single file
    });

    // Command for uploading a folder
    let uploadFolder_Function = vscode.commands.registerCommand('extension.uploadFolderToRobot', async (uri) => {
        await f_uploadToRobot(uri, true); // true indicates it's a folder
    });

    registerDescriptionHints(context);

    const listLsFilesAndInsert_Function = vscode.commands.registerCommand(
        "extension.listLsFilesAndInsert",
        async () => {
            outputChannel.appendLine('listLsFilesAndInsert_Function');
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage("No active editor found.");
                return;
            }
    
            // Get the directory of the currently open file
            const currentFilePath = editor.document.uri.fsPath;
            const currentDir = path.dirname(currentFilePath);
    
            // Get all `.ls` files in the same directory
            const lsFiles = fs.readdirSync(currentDir)
                .filter(file => file.endsWith('.ls'))
                .map(file => path.parse(file).name); // Strip the `.ls` extension

            if (lsFiles.length === 0) {
                 vscode.window.showInformationMessage("No .ls files found in the current directory.");
                return;
            }
    
            // Show the list of `.ls` files in a selection box
            const selectedFile = await vscode.window.showQuickPick(lsFiles, {
                placeHolder: "Select a .ls file to insert its name",
            });
    
            if (!selectedFile) {
                return; // User canceled the selection
            }
    
            // Insert the selected file name at the cursor position
            const cursorPosition = editor.selection.active;
            editor.edit((editBuilder) => {
                editBuilder.insert(cursorPosition, selectedFile);
            });
    
            vscode.window.showInformationMessage(`Inserted file name: ${selectedFile}`);
        }
    );
    
    // Add all commands to the context subscriptions
    context.subscriptions.push( uploadFile_Function, 
                                uploadFolder_Function, 
                                downloadAll_Function, 
                                downloadLs_Function,
                                updateLsFilesFromRobot_Function,
                                updateSelectedFileFromRobot_Function,
                                listLsFilesAndInsert_Function);
}

// ---- I/O and register description hints ----------------------------------

const descriptionFileCache = new Map(); // filePath → { mtimeMs, descriptions }
let robotDescriptionDecoration;
let sharedDescriptionDecoration;

/** Reads a descriptions CSV, reusing the cached copy until the file changes. Missing file → empty. */
function readDescriptionsFile(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        descriptionFileCache.delete(filePath);
        return new Map();
    }
    const cached = descriptionFileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.descriptions;
    }
    try {
        const { descriptions, problems } = parseDescriptionsCsv(fs.readFileSync(filePath, 'utf8'));
        for (const problem of problems) {
            outputChannel.appendLine(`Warning: ${filePath}: ${problem}`);
        }
        outputChannel.appendLine(`Loaded ${descriptions.size} descriptions from ${filePath}`);
        descriptionFileCache.set(filePath, { mtimeMs: stat.mtimeMs, descriptions });
        return descriptions;
    } catch (error) {
        outputChannel.appendLine(`Warning: Failed to read ${filePath}: ${error.message}`);
        return new Map();
    }
}

/** The shared and robot description files that apply to a document. */
function descriptionSourcesFor(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
        return undefined;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const { robots } = readIpConfig(workspaceRoot);
    const robot = robotForPath(robots, workspaceRoot, path.dirname(uri.fsPath));
    return {
        workspaceRoot,
        robots,
        robot,
        sharedPath: getSharedDescriptionsPath(workspaceRoot),
        robotPath: robot ? getRobotDescriptionsPath(workspaceRoot, robot) : undefined
    };
}

/** Merged shared + robot descriptions for the sources (Map key → { text, source }). */
function readMergedDescriptions(sources) {
    return sources
        ? mergeDescriptions(readDescriptionsFile(sources.sharedPath), sources.robotPath ? readDescriptionsFile(sources.robotPath) : undefined)
        : new Map();
}

/** Description texts (Map key → text) for an LS file, for the LS Verifier's "descriptions" check. */
function descriptionTextsFor(uri) {
    const merged = readMergedDescriptions(descriptionSourcesFor(uri));
    return new Map([...merged].map(([key, entry]) => [key, entry.text]));
}

/** LS Verifier diagnostics from the "descriptions" check: their range covers exactly one inline comment such as DO[5:Clamp]. */
function inlineCommentForDiagnostic(document, diagnostic) {
    if (diagnostic.source !== 'LS Verifier' || diagnostic.range.start.line !== diagnostic.range.end.line) {
        return undefined;
    }
    return findInlineComments(document.lineAt(diagnostic.range.start.line).text)
        .find(found => found.start === diagnostic.range.start.character && found.end === diagnostic.range.end.character);
}

/** The file a key's description is saved to: the file it comes from now, else the robot's file, else shared.csv. */
function descriptionTargetFile(sources, descriptions, key) {
    if (descriptions.get(key)?.source === 'shared' || !sources.robotPath) {
        return sources.sharedPath;
    }
    return sources.robotPath;
}

/**
 * Saves descriptions ([{ key, text }]) for an LS document, each to its target file. Returns the files written,
 * or undefined when nothing was saved. A descriptions file open with unsaved changes is not overwritten.
 */
function saveDescriptions(sources, changes) {
    const descriptions = readMergedDescriptions(sources);
    const byFile = new Map();
    for (const change of changes) {
        const filePath = descriptionTargetFile(sources, descriptions, change.key);
        byFile.set(filePath, [...(byFile.get(filePath) || []), change]);
    }
    const relative = filePath => path.relative(sources.workspaceRoot, filePath).split(path.sep).join('/');
    for (const filePath of byFile.keys()) {
        const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath.toLowerCase() === filePath.toLowerCase());
        if (open?.isDirty) {
            vscode.window.showErrorMessage(`Save or undo your changes in ${relative(filePath)} first; the descriptions were not saved.`);
            return undefined;
        }
    }
    for (const [filePath, fileChanges] of byFile) {
        ensureDescriptionsFile(filePath);
        let text = fs.readFileSync(filePath, 'utf8');
        for (const change of fileChanges) {
            text = setDescriptionInCsv(text, change.key, change.text);
            outputChannel.appendLine(`Description ${change.key} = "${change.text}" saved to ${filePath}`);
        }
        fs.writeFileSync(filePath, text, 'utf8');
        descriptionFileCache.delete(filePath);
    }
    updateAllDescriptionDecorations();
    return [...byFile.keys()].map(relative);
}

/**
 * Runs a follow-up (usually a notification with buttons) without making the command wait for it. A notification that
 * times out into the notification center never resolves, and a command started from the Explorer keeps the
 * Explorer's progress bar running until it finishes.
 */
function inBackground(label, task) {
    Promise.resolve().then(task).catch(error => outputChannel.appendLine(`${label}: ${error.message}`));
}

/** Tells the user what was saved, with a button to send it to the robot. Does not wait for the answer. */
function reportSavedDescriptions(documentUri, summary, files) {
    inBackground('Send descriptions', async () => {
        const send = 'Send to Robot';
        const choice = await vscode.window.showInformationMessage(`${summary} Saved to ${files.join(' and ')}.`, send);
        if (choice === send) {
            await sendDescriptionsToRobot(vscode.Uri.file(path.dirname(documentUri.fsPath)));
        }
    });
}

/** The description key (bare DO[5] or inline DO[5:Clamp]) under a position, with its inline comment if any. */
function descriptionKeyAt(document, position) {
    const lineText = document.lineAt(position.line).text;
    const inline = findInlineComments(lineText).find(found => found.start <= position.character && position.character <= found.end);
    if (inline) {
        return inline;
    }
    return findDescriptionKeys(lineText).find(found => found.start <= position.character && position.character <= found.end + 1);
}

/**
 * Sets one description. uri/key come from a quick fix or hover link; from the Command Palette the key under
 * the cursor is used. Without text, asks for it.
 */
async function setDescription(uriArg, key, text) {
    const editor = vscode.window.activeTextEditor;
    const uri = typeof uriArg === 'string' ? vscode.Uri.parse(uriArg) : (uriArg instanceof vscode.Uri ? uriArg : editor?.document.uri);
    if (!uri) {
        vscode.window.showErrorMessage('Open an LS file and put the cursor on an I/O or register, for example DO[5].');
        return;
    }
    if (!key && editor && editor.document.uri.toString() === uri.toString()) {
        key = descriptionKeyAt(editor.document, editor.selection.active)?.key;
    }
    if (!key) {
        vscode.window.showErrorMessage('Put the cursor on an I/O or register, for example DO[5] or R[10], to set its description.');
        return;
    }
    const sources = descriptionSourcesFor(uri);
    if (!sources) {
        vscode.window.showErrorMessage('Open the job folder first. Descriptions are saved in its .vscode/descriptions folder.');
        return;
    }
    const descriptions = readMergedDescriptions(sources);
    if (text === undefined) {
        const target = path.relative(sources.workspaceRoot, descriptionTargetFile(sources, descriptions, key)).split(path.sep).join('/');
        text = await vscode.window.showInputBox({
            title: `Description for ${key}`,
            prompt: `Saved to ${target}`,
            value: descriptions.get(key)?.text || '',
            validateInput: value => value.trim() ? null : 'Enter a description.'
        });
        if (text === undefined) {
            return;
        }
    }
    text = text.trim();
    if (descriptions.get(key)?.text === text) {
        return;
    }
    const files = saveDescriptions(sources, [{ key, text }]);
    if (files) {
        reportSavedDescriptions(uri, `${key}: "${text}".`, files);
    }
}

/**
 * Inline comments in LS text that differ from the descriptions (Map key → { text, source }).
 * One change per key: the first comment in the file wins, and keys with conflicting comments are listed in conflicts.
 * Returns { changes: Map key → { key, text, current, line }, conflicts: Set of keys }.
 */
function lsCommentChanges(text, descriptions) {
    const changes = new Map();
    const conflicts = new Set();
    text.split(/\r?\n/).forEach((lineText, line) => {
        for (const found of findInlineComments(lineText)) {
            const entry = descriptions.get(found.key);
            if (entry && inlineCommentMatches(found.text, entry.text)) {
                continue;
            }
            const existing = changes.get(found.key);
            if (!existing) {
                changes.set(found.key, { key: found.key, text: found.text, current: entry?.text, line });
            } else if (existing.text !== found.text) {
                conflicts.add(found.key);
            }
        }
    });
    return { changes, conflicts };
}

/** Saves every inline comment in an LS file that differs from the descriptions, after the user picks which. */
async function updateDescriptionsFromLsFile(uriArg) {
    const uri = uriArg instanceof vscode.Uri ? uriArg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || !/\.ls$/i.test(uri.fsPath)) {
        vscode.window.showErrorMessage('Open or right-click an LS file to update descriptions from its comments.');
        return;
    }
    const sources = descriptionSourcesFor(uri);
    if (!sources) {
        vscode.window.showErrorMessage('Open the job folder first. Descriptions are saved in its .vscode/descriptions folder.');
        return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const { changes, conflicts } = lsCommentChanges(document.getText(), readMergedDescriptions(sources));
    if (changes.size === 0) {
        vscode.window.showInformationMessage(`Every comment in ${path.basename(uri.fsPath)} already matches the descriptions.`);
        return;
    }
    const items = [...changes.values()].map(change => ({
        label: change.key,
        description: `${change.current === undefined ? '(none)' : `"${change.current}"`} → "${change.text}"`,
        detail: conflicts.has(change.key) ? `Line ${change.line + 1}; other lines give ${change.key} a different comment` : `Line ${change.line + 1}`,
        picked: true,
        change
    }));
    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `Save ${items.length} comment(s) from ${path.basename(uri.fsPath)} as descriptions`
    });
    if (!picked || picked.length === 0) {
        return;
    }
    const files = saveDescriptions(sources, picked.map(item => item.change));
    if (files) {
        reportSavedDescriptions(uri, `Saved ${picked.length} description(s) from ${path.basename(uri.fsPath)}.`, files);
    }
}

/** Lightbulb actions in LS files: save a differing inline comment, or set the description of the key under the cursor. */
class DescriptionCodeActionProvider {
    provideCodeActions(document, range, context) {
        const actions = [];
        const ours = context.diagnostics.filter(diagnostic => inlineCommentForDiagnostic(document, diagnostic));
        for (const diagnostic of ours) {
            const found = inlineCommentForDiagnostic(document, diagnostic);
            const action = new vscode.CodeAction(`Save "${found.text}" as the description of ${found.key}`, vscode.CodeActionKind.QuickFix);
            action.command = { command: 'extension.setDescription', title: action.title, arguments: [document.uri, found.key, found.text] };
            action.diagnostics = [diagnostic];
            action.isPreferred = true;
            actions.push(action);
        }
        const allDiagnostics = vscode.languages.getDiagnostics(document.uri).filter(diagnostic => inlineCommentForDiagnostic(document, diagnostic));
        if (ours.length > 0 && allDiagnostics.length > 1) {
            const action = new vscode.CodeAction(`Save all ${allDiagnostics.length} differing comments in this file as descriptions…`, vscode.CodeActionKind.QuickFix);
            action.command = { command: 'extension.updateDescriptionsFromLsFile', title: action.title, arguments: [document.uri] };
            actions.push(action);
        }
        const atCursor = descriptionKeyAt(document, range.start);
        if (atCursor) {
            const action = new vscode.CodeAction(`Set description of ${atCursor.key}…`, vscode.CodeActionKind.RefactorRewrite);
            action.command = { command: 'extension.setDescription', title: action.title, arguments: [document.uri, atCursor.key] };
            actions.push(action);
        }
        return actions;
    }
}

function updateDescriptionDecorations(editor) {
    if (!editor || editor.document.languageId !== 'fanuctp') {
        return;
    }
    const sources = descriptionSourcesFor(editor.document.uri);
    const descriptions = readMergedDescriptions(sources);
    lsVerifier?.updateDescriptionIssues(editor.document);

    const robotDecorations = [];
    const sharedDecorations = [];
    if (descriptions.size > 0) {
        const workspaceRoot = sources.workspaceRoot;
        const relative = filePath => path.relative(workspaceRoot, filePath).split(path.sep).join('/');
        for (let line = 0; line < editor.document.lineCount; line++) {
            for (const found of findDescriptionKeys(editor.document.lineAt(line).text)) {
                const entry = descriptions.get(found.key);
                if (!entry) {
                    continue;
                }
                const isShared = entry.source === 'shared';
                const sourceText = isShared
                    ? `shared (${relative(sources.sharedPath)})`
                    : `${sources.robot.name} (${relative(sources.robotPath)})`;
                const editArgs = encodeURIComponent(JSON.stringify([editor.document.uri.toString(), found.key]));
                const hover = new vscode.MarkdownString(
                    `**${found.key}** ${entry.text}\n\nFrom ${sourceText} · [Edit description](command:extension.setDescription?${editArgs})`
                );
                hover.isTrusted = { enabledCommands: ['extension.setDescription'] };
                const decoration = {
                    range: new vscode.Range(line, found.start, line, found.end),
                    renderOptions: { after: { contentText: ` ${entry.text}` } },
                    hoverMessage: hover
                };
                (isShared ? sharedDecorations : robotDecorations).push(decoration);
            }
        }
    }
    editor.setDecorations(robotDescriptionDecoration, robotDecorations);
    editor.setDecorations(sharedDescriptionDecoration, sharedDecorations);
}

function updateAllDescriptionDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
        updateDescriptionDecorations(editor);
    }
}

function registerDescriptionHints(context) {
    const style = { margin: '0 0 0 0.2em', fontStyle: 'italic' };
    robotDescriptionDecoration = vscode.window.createTextEditorDecorationType({
        after: { ...style, color: new vscode.ThemeColor('robotFtp.robotDescriptionForeground') }
    });
    sharedDescriptionDecoration = vscode.window.createTextEditorDecorationType({
        after: { ...style, color: new vscode.ThemeColor('robotFtp.sharedDescriptionForeground') }
    });

    let pending;
    const scheduleUpdate = () => {
        clearTimeout(pending);
        pending = setTimeout(updateAllDescriptionDecorations, 250);
    };
    const refreshFromDisk = () => {
        descriptionFileCache.clear();
        scheduleUpdate();
    };

    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/{robot-ftp.json,descriptions/*.csv}');
    watcher.onDidChange(refreshFromDisk);
    watcher.onDidCreate(refreshFromDisk);
    watcher.onDidDelete(refreshFromDisk);

    context.subscriptions.push(
        robotDescriptionDecoration,
        sharedDescriptionDecoration,
        watcher,
        vscode.window.onDidChangeVisibleTextEditors(scheduleUpdate),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'fanuctp') {
                scheduleUpdate();
            }
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (/\.csv$/i.test(document.fileName) || path.basename(document.fileName) === 'robot-ftp.json') {
                refreshFromDisk();
            }
        }),
        vscode.commands.registerCommand('extension.editDescriptions', editDescriptions),
        vscode.commands.registerCommand('extension.createDescriptionsFromBackup', createDescriptionsFromBackup),
        vscode.commands.registerCommand('extension.getDescriptionsFromRobot', getDescriptionsFromRobot),
        // Menus pass (clicked uri, selected uris); only the uri is used, so the robot is always asked for.
        vscode.commands.registerCommand('extension.sendDescriptionsToRobot', resourceUri => sendDescriptionsToRobot(resourceUri)),
        vscode.commands.registerCommand('extension.setDescription', setDescription),
        vscode.commands.registerCommand('extension.updateDescriptionsFromLsFile', updateDescriptionsFromLsFile),
        vscode.languages.registerCodeActionsProvider('fanuctp', new DescriptionCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite]
        }),
        { dispose: () => clearTimeout(pending) }
    );
    updateAllDescriptionDecorations();
}

/** Creates or updates a descriptions CSV from the comments in a robot backup folder. */
async function createDescriptionsFromBackup(resourceUri) {
    let folderPath;
    if (resourceUri && fs.existsSync(resourceUri.fsPath)) {
        folderPath = fs.statSync(resourceUri.fsPath).isDirectory() ? resourceUri.fsPath : path.dirname(resourceUri.fsPath);
    } else {
        const picked = await vscode.window.showOpenDialog({
            defaultUri: defaultFolderUri(undefined),
            canSelectFiles: false, canSelectFolders: true, openLabel: 'Use this backup folder',
            title: 'Select a robot backup folder (from Get ALL Files from Robot)'
        });
        if (!picked || picked.length === 0) {
            return;
        }
        folderPath = picked[0].fsPath;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderPath))
        || await selectWorkspaceFolder(undefined);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open the job folder first. Descriptions are saved in its .vscode/descriptions folder.');
        return;
    }
    await importDescriptionsFromFolder(folderPath, workspaceFolder.uri.fsPath, folderPath, path.basename(folderPath));
}

/** Downloads only the comment files from the robot, then imports them like a backup. */
async function getDescriptionsFromRobot(resourceUri) {
    let ownerPath;
    if (resourceUri && fs.existsSync(resourceUri.fsPath)) {
        ownerPath = fs.statSync(resourceUri.fsPath).isDirectory() ? resourceUri.fsPath : path.dirname(resourceUri.fsPath);
    }
    const workspaceFolder = (ownerPath && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(ownerPath)))
        || await selectWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open the job folder first. Descriptions are saved in its .vscode/descriptions folder.');
        return;
    }
    ownerPath = ownerPath || workspaceFolder.uri.fsPath;

    const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-ftp-descriptions-'));
    let robotIp;
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Getting I/O and register comments from robot', cancellable: false },
            async progress => {
                await withRobotConnection(ownerPath, 'GetDescriptions', async (client, ipAddress) => {
                    robotIp = ipAddress;
                    await downloadCommentFiles(client, tempFolder, progress, ipAddress);
                });
            }
        );
        if (!robotIp) {
            return; // Connection failed or was cancelled; withRobotConnection already reported it.
        }
        await importDescriptionsFromFolder(tempFolder, workspaceFolder.uri.fsPath, ownerPath, `robot ${robotIp}`);
    } finally {
        fs.rmSync(tempFolder, { recursive: true, force: true });
    }
}

/** Downloads the robot's comment files (ioconfig.dg, numreg.va, ...) into folder. Returns how many were found. */
async function downloadCommentFiles(client, folder, progress, ipAddress) {
    const remoteFiles = (await client.list()).filter(file => file.isFile && BACKUP_FILES.includes(file.name.toLowerCase()));
    for (const file of remoteFiles) {
        progress?.report({ message: file.name });
        outputChannel.appendLine(`Downloading file: ${file.name}`);
        await client.downloadTo(path.join(folder, file.name), file.name);
    }
    outputChannel.appendLine(`Downloaded ${remoteFiles.length} of ${BACKUP_FILES.length} description files from ${ipAddress}.`);
    return remoteFiles.length;
}

/** The robot's current comments (Map key → text), read over FTP into a temporary folder. */
async function readRobotComments(client, progress, ipAddress) {
    const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-ftp-descriptions-'));
    try {
        await downloadCommentFiles(client, tempFolder, progress, ipAddress);
        return readBackupDescriptions(findBackupFiles(tempFolder)).descriptions;
    } finally {
        fs.rmSync(tempFolder, { recursive: true, force: true });
    }
}

/**
 * Sends the shared + robot descriptions to the robot as I/O and register comments.
 * Only rows that differ from the robot's current comments are sent, then the comments are read back to check them.
 */
/**
 * The descriptions that belong on a connected robot: the named robot's own file over shared.csv
 * (an unnamed IP gets shared.csv only). Returns { robot, local: Map key → text, fileList, robotLabel }.
 */
function descriptionsForRobot(workspaceRoot, ipAddress, picked) {
    const relative = filePath => path.relative(workspaceRoot, filePath).split(path.sep).join('/');
    const { robots } = readIpConfig(workspaceRoot);
    const robot = (picked.name && robots.find(candidate => candidate.name === picked.name))
        || robots.find(candidate => candidate.ip === ipAddress && candidate.port === picked.port);
    const sharedPath = getSharedDescriptionsPath(workspaceRoot);
    const robotPath = robot ? getRobotDescriptionsPath(workspaceRoot, robot) : undefined;
    const merged = mergeDescriptions(readDescriptionsFile(sharedPath), robotPath ? readDescriptionsFile(robotPath) : undefined);
    return {
        robot,
        local: new Map([...merged].map(([key, entry]) => [key, entry.text])),
        fileList: [robotPath, sharedPath].filter(Boolean).map(relative).join(' and '),
        robotLabel: robot ? `${robot.name} (${ipAddress})` : ipAddress
    };
}

/** knownRobot ({ ip, port, name }) connects without the robot picker, e.g. from the reminder after an upload. */
async function sendDescriptionsToRobot(resourceUri, knownRobot) {
    let ownerPath;
    if (resourceUri && fs.existsSync(resourceUri.fsPath)) {
        ownerPath = fs.statSync(resourceUri.fsPath).isDirectory() ? resourceUri.fsPath : path.dirname(resourceUri.fsPath);
    }
    const workspaceFolder = (ownerPath && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(ownerPath)))
        || await selectWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open the job folder first. Descriptions are read from its .vscode/descriptions folder.');
        return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    ownerPath = ownerPath || workspaceRoot;

    await withRobotConnection(ownerPath, 'SendDescriptions', async (client, ipAddress, picked) => {
        const { robot, local, fileList, robotLabel } = descriptionsForRobot(workspaceRoot, ipAddress, picked);
        if (!robot) {
            outputChannel.appendLine(`No named robot for ${ipAddress}; sending ${fileList} only.`);
        }
        if (local.size === 0) {
            vscode.window.showWarningMessage(`No descriptions to send. ${fileList} has no rows.`);
            return;
        }

        const httpPort = robot?.httpPort ?? 80;
        const plan = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Reading the comments on ${robotLabel}` },
            async progress => planDescriptionPush(local, await readRobotComments(client, progress, ipAddress))
        );

        if (plan.unsupported.length > 0) {
            outputChannel.appendLine(`Not sent (the robot's web comment tool cannot set these types): ${plan.unsupported.join(', ')}`);
        }
        if (plan.send.length === 0) {
            const skipped = plan.unsupported.length > 0 ? ` ${plan.unsupported.length} UI/UO row(s) differ but cannot be sent; see the Output panel.` : '';
            vscode.window.showInformationMessage(`${robotLabel} already has all ${plan.unchanged} description(s).${skipped}`);
            return;
        }

        const describeChange = item => `${item.key}: ${item.current === undefined ? '(none)' : `"${item.current}"`} → "${item.text}"`;
        outputChannel.appendLine(`Descriptions to send to ${robotLabel} (web port ${httpPort}):`);
        plan.send.forEach(item => outputChannel.appendLine(`  ${describeChange(item)}`));
        const shown = plan.send.slice(0, 12).map(describeChange);
        if (plan.send.length > shown.length) {
            shown.push(`… and ${plan.send.length - shown.length} more (see the Output panel)`);
        }
        const sendButton = 'Send';
        const choice = await vscode.window.showWarningMessage(
            `Send ${plan.send.length} description(s) to ${robotLabel}?`,
            {
                modal: true,
                detail: `${shown.join('\n')}\n\n${plan.unchanged} already match.${plan.unsupported.length ? ` ${plan.unsupported.length} UI/UO row(s) cannot be sent.` : ''} Comments on the robot that are not in ${fileList} are not changed.`
            },
            sendButton
        );
        if (choice !== sendButton) {
            return;
        }

        await pushDescriptionPlan(client, ipAddress, robot, robotLabel, plan);
    }, knownRobot);
}

/** Sends the planned comments over HTTP, then reads them back through the open FTP connection to check them. */
async function pushDescriptionPlan(client, ipAddress, robot, robotLabel, plan) {
    const httpPort = robot?.httpPort ?? 80;
    let sent = 0;
    let failure;
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Sending descriptions to ${robotLabel}`, cancellable: true },
        async (progress, token) => {
            for (const item of plan.send) {
                if (token.isCancellationRequested) {
                    break;
                }
                progress.report({ message: `${item.key} (${sent + 1} of ${plan.send.length})`, increment: 100 / plan.send.length });
                const error = await sendComment(ipAddress, httpPort, item);
                if (error) {
                    failure = { item, error };
                    break;
                }
                sent++;
            }
        }
    );
    outputChannel.appendLine(`Sent ${sent} of ${plan.send.length} description(s) to ${robotLabel}.`);
    if (failure) {
        outputChannel.appendLine(`ERROR sending ${failure.item.key}: ${failure.error}`);
        const hint = robot && !robot.httpPort && httpPort === 80 && /ECONNREFUSED|No answer/.test(failure.error)
            ? ` For RoboGuide or a port-forwarded robot, add "httpPort" to ${robot.name} in Edit Robot List.`
            : '';
        vscode.window.showErrorMessage(`Sent ${sent} of ${plan.send.length}. ${failure.item.key} failed: ${failure.error}${hint}`);
        if (sent === 0) {
            return;
        }
    }

    // Read the comments back. A robot cuts comments that are too long, so report any that differ.
    const sentItems = plan.send.slice(0, sent);
    const after = await readRobotComments(client, undefined, ipAddress);
    const different = sentItems.filter(item => after.get(item.key) !== item.text);
    for (const item of different) {
        outputChannel.appendLine(`Check: ${item.key} on the robot is "${after.get(item.key) ?? ''}", not "${item.text}" (too long for the robot's comment field?).`);
    }
    if (different.length > 0) {
        vscode.window.showWarningMessage(`Sent ${sent} description(s) to ${robotLabel}, but ${different.length} read back differently (${different.slice(0, 5).map(item => item.key).join(', ')}). See the Output panel.`);
    } else if (!failure) {
        vscode.window.showInformationMessage(`Sent ${sent} description(s) to ${robotLabel} and checked them.`);
    }
}

// ---- Reminder after an upload: descriptions that differ from the robot's comments ----

const SKIP_SEND_DESCRIPTIONS_REMINDER_KEY = 'robotFtp.skipSendDescriptionsReminder'; // workspace: "Don't Ask Again", all robots
let sendDescriptionsReminderSnoozed = false; // "Not This Session", all robots

function sendDescriptionsReminderOff() {
    return sendDescriptionsReminderSnoozed || Boolean(extensionContext.workspaceState.get(SKIP_SEND_DESCRIPTIONS_REMINDER_KEY));
}

/**
 * Called while still connected after an upload. Compares the descriptions with the robot's comments and returns
 * { robotLabel, count, fileList } when some differ, else undefined. Never throws: a failed check only logs.
 */
async function checkDescriptionsAfterUpload(client, directoryPath, ipAddress, picked) {
    try {
        if (sendDescriptionsReminderOff()) {
            return undefined;
        }
        const workspaceRoot = getWorkspaceRoot(directoryPath);
        if (!workspaceRoot) {
            return undefined;
        }
        const { local, fileList, robotLabel } = descriptionsForRobot(workspaceRoot, ipAddress, picked);
        if (local.size === 0) {
            return undefined; // No descriptions in this project: nothing to compare.
        }
        const plan = planDescriptionPush(local, await readRobotComments(client, undefined, ipAddress));
        outputChannel.appendLine(`Descriptions check after upload: ${plan.send.length} of ${local.size} differ from the comments on ${robotLabel}.`);
        return plan.send.length > 0 ? { robotLabel, count: plan.send.length, fileList } : undefined;
    } catch (error) {
        outputChannel.appendLine(`Descriptions check after upload skipped: ${error.message}`);
        return undefined;
    }
}

/**
 * Called while still connected after an upload when the user already chose to save LS comments and send them:
 * sends every description that differs from the robot's comments, without asking again. Never throws.
 */
async function sendDescriptionsAfterUpload(client, directoryPath, ipAddress, picked) {
    try {
        const workspaceRoot = getWorkspaceRoot(directoryPath);
        if (!workspaceRoot) {
            return;
        }
        const { robot, local, robotLabel } = descriptionsForRobot(workspaceRoot, ipAddress, picked);
        const plan = planDescriptionPush(local, await readRobotComments(client, undefined, ipAddress));
        if (plan.unsupported.length > 0) {
            outputChannel.appendLine(`Not sent (the robot's web comment tool cannot set these types): ${plan.unsupported.join(', ')}`);
        }
        if (plan.send.length === 0) {
            outputChannel.appendLine(`${robotLabel} already has all ${plan.unchanged} description(s).`);
            return;
        }
        plan.send.forEach(item => outputChannel.appendLine(`  Sending ${item.key}: ${item.current === undefined ? '(none)' : `"${item.current}"`} → "${item.text}"`));
        await pushDescriptionPlan(client, ipAddress, robot, robotLabel, plan);
    } catch (error) {
        outputChannel.appendLine(`Sending descriptions after upload failed: ${error.message}`);
        vscode.window.showErrorMessage(`The files were sent, but the descriptions were not: ${error.message}`);
    }
}

/** Asks to send descriptions that differ from the robot: Send Descriptions, Not This Session, or Don't Ask Again. */
async function offerToSendDescriptions(reminder, directoryPath, knownRobot) {
    const send = 'Send Descriptions';
    const notNow = 'Not This Session';
    const never = "Don't Ask Again";
    const choice = await vscode.window.showWarningMessage(
        `${reminder.count} description(s) in ${reminder.fileList} differ from the comments on ${reminder.robotLabel}. Send them to the robot?`,
        send, notNow, never
    );
    if (choice === send) {
        await sendDescriptionsToRobot(vscode.Uri.file(directoryPath), knownRobot);
    } else if (choice === notNow) {
        sendDescriptionsReminderSnoozed = true;
        outputChannel.appendLine('Will not ask to send descriptions after an upload again this session (any robot).');
    } else if (choice === never) {
        await extensionContext.workspaceState.update(SKIP_SEND_DESCRIPTIONS_REMINDER_KEY, true);
        outputChannel.appendLine('Will not ask to send descriptions after an upload again (any robot, this workspace). Turn it back on with MNAutomation → Reset Reminders.');
    }
}

/**
 * Reads the comment files in folderPath and saves them to a descriptions CSV.
 * ownerPath decides which robot's file is offered first; sourceLabel names the source in prompts.
 * When targetFilePath is given, that file is used without asking.
 */
async function importDescriptionsFromFolder(folderPath, workspaceRoot, ownerPath, sourceLabel, targetFilePath) {
    const relative = filePath => path.relative(workspaceRoot, filePath).split(path.sep).join('/');

    let files;
    try {
        files = findBackupFiles(folderPath);
    } catch (error) {
        vscode.window.showErrorMessage(`Could not read ${folderPath}: ${error.message}`);
        return;
    }
    if (Object.keys(files).length === 0) {
        vscode.window.showErrorMessage(
            `No description files found in ${sourceLabel}. Expected ${BACKUP_FILES.join(', ')}. For a backup folder, run "Get ALL Files from Robot" first and use the downloaded folder.`
        );
        return;
    }

    let backup;
    try {
        backup = readBackupDescriptions(files);
    } catch (error) {
        vscode.window.showErrorMessage(`Could not read the backup files: ${error.message}`);
        return;
    }
    const countText = Object.entries(backup.counts).map(([name, count]) => `${name}: ${count}`).join(', ');
    outputChannel.appendLine(`Descriptions from ${sourceLabel}: ${countText}`);
    if (backup.descriptions.size === 0) {
        vscode.window.showWarningMessage(`${sourceLabel} has no I/O or register comments.`);
        return;
    }

    // Target: the robot that owns this folder first, then shared, then other robots.
    const { robots } = readIpConfig(workspaceRoot);
    const folderRobot = robotForPath(robots, workspaceRoot, ownerPath);
    const items = [];
    if (folderRobot) {
        const filePath = getRobotDescriptionsPath(workspaceRoot, folderRobot);
        items.push({ label: folderRobot.name, description: `this folder · ${relative(filePath)}`, filePath });
    }
    for (const robot of robots) {
        if (robot !== folderRobot) {
            const filePath = getRobotDescriptionsPath(workspaceRoot, robot);
            items.push({ label: robot.name, description: relative(filePath), filePath });
        }
    }
    items.push({ label: 'Shared', description: `all robots · ${relative(getSharedDescriptionsPath(workspaceRoot))}`, filePath: getSharedDescriptionsPath(workspaceRoot) });

    const target = targetFilePath ? { filePath: targetFilePath } : await vscode.window.showQuickPick(items, {
        placeHolder: `Save ${backup.descriptions.size} descriptions from ${sourceLabel} to which file?`
    });
    if (!target) {
        return;
    }

    let existing = new Map();
    let droppedRows = 0;
    if (fs.existsSync(target.filePath)) {
        try {
            const parsed = parseDescriptionsCsv(fs.readFileSync(target.filePath, 'utf8'));
            existing = parsed.descriptions;
            droppedRows = parsed.problems.length;
        } catch (error) {
            vscode.window.showErrorMessage(`Could not read ${relative(target.filePath)}: ${error.message}`);
            return;
        }
    }

    let mode = 'replace';
    if (existing.size > 0 || droppedRows > 0) {
        const diff = compareDescriptions(existing, backup.descriptions);
        const dropped = droppedRows > 0 ? ` ${droppedRows} unreadable row(s) will be removed.` : '';
        const choice = await vscode.window.showQuickPick([
            {
                label: 'Merge', mode: 'merge',
                description: `${diff.added} new, ${diff.changed} changed, keep ${diff.kept} rows not in the backup`,
                detail: `Robot comments replace matching keys; your other rows stay.${dropped}`
            },
            {
                label: 'Replace', mode: 'replace',
                description: `file will hold only the ${backup.descriptions.size} backup descriptions`,
                detail: `Removes ${diff.kept} row(s) that are not in the backup.${dropped}`
            }
        ], { placeHolder: `${relative(target.filePath)} already has ${existing.size} descriptions` });
        if (!choice) {
            return;
        }
        mode = choice.mode;
    }

    const combined = combineDescriptions(existing, backup.descriptions, mode);
    try {
        fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
        fs.writeFileSync(target.filePath, serializeDescriptionsCsv(combined), 'utf8');
    } catch (error) {
        vscode.window.showErrorMessage(`Could not write ${relative(target.filePath)}: ${error.message}`);
        return;
    }
    descriptionFileCache.delete(target.filePath);
    updateAllDescriptionDecorations();
    outputChannel.appendLine(`Wrote ${combined.size} descriptions to ${target.filePath} (${mode}).`);
    vscode.window.showInformationMessage(`Saved ${combined.size} descriptions to ${relative(target.filePath)}.`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(target.filePath)));
    return target.filePath;
}

/** Opens (creating if needed) the shared or a robot's descriptions file. */
async function editDescriptions(resourceUri) {
    const targetUri = resourceUri || vscode.window.activeTextEditor?.document.uri;
    const workspaceFolder = await selectWorkspaceFolder(targetUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open a folder first. Descriptions are stored in the folder\'s .vscode/descriptions.');
        return;
    }
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const { robots } = readIpConfig(workspaceRoot);
    const isInWorkspace = targetUri && vscode.workspace.getWorkspaceFolder(targetUri)?.uri.fsPath === workspaceRoot;
    let folderRobot;
    if (isInWorkspace) {
        const isFolder = fs.existsSync(targetUri.fsPath) && fs.statSync(targetUri.fsPath).isDirectory();
        folderRobot = robotForPath(robots, workspaceRoot, isFolder ? targetUri.fsPath : path.dirname(targetUri.fsPath));
    }
    const relative = filePath => path.relative(workspaceRoot, filePath).split(path.sep).join('/');

    const items = [];
    if (folderRobot) {
        items.push({ label: folderRobot.name, description: `this folder · ${relative(getRobotDescriptionsPath(workspaceRoot, folderRobot))}`, filePath: getRobotDescriptionsPath(workspaceRoot, folderRobot) });
    }
    items.push({ label: 'Shared', description: `all robots · ${relative(getSharedDescriptionsPath(workspaceRoot))}`, filePath: getSharedDescriptionsPath(workspaceRoot) });
    for (const robot of robots) {
        if (robot !== folderRobot) {
            items.push({ label: robot.name, description: relative(getRobotDescriptionsPath(workspaceRoot, robot)), filePath: getRobotDescriptionsPath(workspaceRoot, robot) });
        }
    }

    const picked = items.length === 1
        ? items[0]
        : await vscode.window.showQuickPick(items, { placeHolder: 'Which descriptions do you want to edit?' });
    if (!picked) {
        return;
    }
    try {
        ensureDescriptionsFile(picked.filePath);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(picked.filePath)));
    } catch (error) {
        vscode.window.showErrorMessage(`Could not open descriptions: ${error.message}`);
    }
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getFileSize(filePath) {
    try {
        return fs.statSync(filePath).size;
    } catch (error) {
        outputChannel.appendLine(`Warning: Could not read size for ${filePath}: ${error.message}`);
        return 0;
    }
}

function trackTransferProgress(client, progress, totalBytes, actionLabel) {
    let lastPercent = 0;

    client.trackProgress((info) => {
        if (totalBytes > 0) {
            const percent = Math.min(100, (info.bytesOverall / totalBytes) * 100);
            const increment = Math.max(0, percent - lastPercent);
            lastPercent = percent;

            progress.report({
                message: `${actionLabel} ${formatBytes(info.bytesOverall)} of ${formatBytes(totalBytes)} (${Math.floor(percent)}%)`,
                increment
            });
        } else {
            progress.report({
                message: `${actionLabel} ${formatBytes(info.bytesOverall)}`
            });
        }
    });

    return (message) => {
        progress.report({
            message,
            increment: Math.max(0, 100 - lastPercent)
        });
    };
}

//*****************************************************************
//* This COde Works*/
/**
 * Execute an FTP operation with proper connection management.
 * Ensures the client is ALWAYS closed, even on error.
 * Includes connection timeout to prevent hanging.
 * 
 * @param {string} directoryPath - Directory to use for IP retrieval
 * @param {string} operationName - Name of operation for logging
 * @param {Function} callback - Async function that receives (client, ipAddress, robot) and performs FTP operations
 * @param {{ip: string, port: (number|undefined), name: (string|undefined)}} [knownRobot] - connect to this robot without asking
 * @returns {Promise<void>}
 */
async function withRobotConnection(directoryPath, operationName, callback, knownRobot) {
    let ipAddress;
    const client = new ftp.Client();
    const CONNECTION_TIMEOUT = 10000; // 10 seconds timeout
    
    try {
        // Get robot IP address (knownRobot { ip, port, name } skips the picker)
        const robot = typeof knownRobot?.ip === 'string' ? knownRobot : await getRobotIp(directoryPath);
        ipAddress = robot.ip;

        // Connect to robot with timeout. A robot's own port wins over the Port setting.
        const ftpConfig = getRobotConfig();
        const port = robot.port ?? ftpConfig.port;
        const robotLabel = robot.name ? `${robot.name} (${ipAddress}:${port})` : `${ipAddress}:${port}`;
        vscode.window.showInformationMessage(`Using robot ${robotLabel}`);
        outputChannel.appendLine(`${operationName}: connecting to ${robotLabel}`);
        
        client.ftp.verbose = true;
        
        // Create timeout promise
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT}ms - robot not responding`)), CONNECTION_TIMEOUT)
        );
        
        // Race between connection and timeout
        await Promise.race([
            client.access({
                host: ipAddress,
                port,
                user: ftpConfig.username,
                password: ftpConfig.password,
                secure: false
            }),
            timeoutPromise
        ]);

        vscode.window.showInformationMessage('Connected to the robot.');
        
        // Set binary mode
        await client.send("TYPE I");
        
        outputChannel.appendLine(`${operationName}: Starting operation...`);
        
        // Execute the provided callback
        await callback(client, ipAddress, robot);
        
        outputChannel.appendLine("BYE: Closing connection.");
    } catch (error) {
        vscode.window.showErrorMessage(`Error: ${error.message}`);
        outputChannel.appendLine(`ERROR in ${operationName}: ${error.message}`);
    } finally {
        // CRITICAL: Always close the connection, even on error
        if (client) {
            try {
                client.close();
            } catch (closeError) {
                outputChannel.appendLine(`Warning: Error closing connection: ${closeError.message}`);
            }
        }
    }
}

/**
 * Runs the LS verifier on every file before an upload. Returns false to cancel, true to upload, or 'sendDescriptions'
 * to upload and then send the descriptions (see checkLsCommentsBeforeUpload).
 * Errors ask "Send with Errors" or cancel; warnings alone do not stop the upload.
 */
async function checkLsFilesBeforeUpload(uris) {
    if (!lsVerifier || uris.length === 0) {
        return true;
    }
    let check;
    try {
        check = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Checking ${uris.length} LS file(s) before upload` },
            () => lsVerifier.checkFiles(uris)
        );
    } catch (error) {
        outputChannel.appendLine(`LS check before upload failed: ${error.message}`);
        const send = 'Send Without Checking';
        const choice = await vscode.window.showWarningMessage(
            `The LS files could not be checked before upload: ${error.message}`,
            { modal: true, detail: 'Fix the LS Verifier rules (MNAutomation → LS Checker → Edit LS Verifier Rules), or send without checking.' },
            send
        );
        return choice === send;
    }
    if (check.skipped) {
        outputChannel.appendLine('LS check before upload skipped: no verifier rules are enabled.');
        return true;
    }

    // Comments that differ from the descriptions get their own question below (unless made critical in the rules).
    const isDescriptionIssue = issue => issue.code === check.descriptionsRuleId && issue.severity !== 'critical';
    const descriptionFiles = check.results.filter(result => result.issues.some(isDescriptionIssue)).map(result => result.uri);
    check.results = check.results.map(result => ({ ...result, issues: result.issues.filter(issue => !isDescriptionIssue(issue)) }));

    const severityOf = issue => issue.severity || 'error';
    const count = (issues, severity) => issues.filter(issue => severityOf(issue) === severity).length;
    const isError = issue => severityOf(issue) === 'error';
    const isCritical = issue => severityOf(issue) === 'critical';
    const withCritical = check.results.filter(result => result.issues.some(isCritical));
    const withErrors = check.results.filter(result => result.issues.some(isError));
    const criticalCount = withCritical.reduce((sum, result) => sum + count(result.issues, 'critical'), 0);
    const errorCount = withErrors.reduce((sum, result) => sum + count(result.issues, 'error'), 0);
    const warningCount = check.results.reduce((sum, result) => sum + count(result.issues, 'warning'), 0);
    for (const result of check.results.filter(item => item.issues.length > 0)) {
        outputChannel.appendLine(`LS check: ${path.basename(result.uri.fsPath)}: ${count(result.issues, 'critical')} critical, ${count(result.issues, 'error')} error(s), ${count(result.issues, 'warning')} warning(s)`);
    }
    outputChannel.appendLine(`LS check before upload: ${uris.length} file(s), ${criticalCount} critical, ${errorCount} error(s), ${warningCount} warning(s).`);
    const listNames = results => results.slice(0, 5).map(result => path.basename(result.uri.fsPath)).join(', ')
        + (results.length > 5 ? `, and ${results.length - 5} more` : '');

    // Critical: never sent. One critical finding blocks the whole upload.
    if (withCritical.length > 0) {
        outputChannel.appendLine('Upload blocked: critical LS errors.');
        const showProblems = 'Show Problems';
        const choice = await vscode.window.showErrorMessage(
            `Upload blocked: ${withCritical.length} of ${uris.length} LS file(s) have critical errors (${criticalCount}): ${listNames(withCritical)}`,
            {
                modal: true,
                detail: 'Critical errors make the robot reject the file, so nothing was sent. Fix them and send again. They are listed in the Problems panel as "Critical:".'
            },
            showProblems
        );
        if (choice === showProblems) {
            await vscode.commands.executeCommand('workbench.actions.view.problems');
        }
        return false;
    }

    if (withErrors.length === 0) {
        if (warningCount > 0) {
            vscode.window.showInformationMessage(`LS check passed with ${warningCount} warning(s); uploading. See the Problems panel for details.`);
        }
        return checkLsCommentsBeforeUpload(descriptionFiles);
    }

    const send = 'Send with Errors';
    const showProblems = 'Show Problems';
    const choice = await vscode.window.showWarningMessage(
        `${withErrors.length} of ${uris.length} LS file(s) have format errors (${errorCount} error(s)): ${listNames(withErrors)}`,
        {
            modal: true,
            detail: 'Files with errors may fail to load on the robot. Cancel and fix them first, or send them anyway. The errors are listed in the Problems panel.'
        },
        send, showProblems
    );
    if (choice === send) {
        outputChannel.appendLine(`Sending ${withErrors.length} file(s) with LS errors at the user's request.`);
        return checkLsCommentsBeforeUpload(descriptionFiles);
    }
    if (choice === showProblems) {
        await vscode.commands.executeCommand('workbench.actions.view.problems');
    }
    return false;
}

/**
 * Before an upload: inline comments in the LS files (DO[5:Clamp]) that differ from the descriptions. The robot
 * ignores those comments, so offer to save them as descriptions first. Returns false to cancel, true to upload, or
 * 'sendDescriptions' to upload and then send the descriptions.
 */
async function checkLsCommentsBeforeUpload(uris) {
    const found = [];
    for (const uri of uris) {
        const sources = descriptionSourcesFor(uri);
        if (!sources) {
            continue;
        }
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const { changes, conflicts } = lsCommentChanges(text, readMergedDescriptions(sources));
        if (changes.size > 0) {
            found.push({ uri, sources, changes: [...changes.values()], conflicts });
        }
    }
    if (found.length === 0) {
        return true;
    }

    const total = found.reduce((sum, item) => sum + item.changes.length, 0);
    const lines = found.flatMap(item => item.changes.map(change =>
        `${path.basename(item.uri.fsPath)}: ${change.key} "${change.text}" (description: ${change.current === undefined ? 'none' : `"${change.current}"`})`
        + (item.conflicts.has(change.key) ? ', other lines differ' : '')));
    const shown = lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n…and ${lines.length - 12} more` : '');
    outputChannel.appendLine(`LS comments that differ from the descriptions:\n${lines.join('\n')}`);

    const save = 'Save and Send to Robot';
    const sendOnly = 'Send Without Saving';
    const choice = await vscode.window.showWarningMessage(
        `${total} comment(s) in the LS file(s) differ from the descriptions.`,
        {
            modal: true,
            detail: `${shown}\n\nThe robot ignores comments typed in LS files. Save and Send to Robot saves them to the descriptions, sends the LS file(s), then sends the changed descriptions to the robot.`
        },
        save, sendOnly
    );
    if (choice === sendOnly) {
        outputChannel.appendLine('Sending without saving the differing LS comments as descriptions.');
        return true;
    }
    if (choice !== save) {
        return false;
    }
    const saved = new Set();
    for (const item of found) {
        const files = saveDescriptions(item.sources, item.changes);
        if (!files) {
            return false; // A descriptions file has unsaved edits; saveDescriptions already said so.
        }
        files.forEach(file => saved.add(file));
    }
    outputChannel.appendLine(`Saved ${total} description(s) to ${[...saved].join(' and ')}; they are sent to the robot after the upload.`);
    return 'sendDescriptions';
}

/**
 * Upload a file or folder to the robot.
 */
async function f_uploadToRobot(uri, isFolder) {
    if (!uri || !uri.fsPath) {
        vscode.window.showErrorMessage('Please select a file or folder to upload.');
        return;
    }

    const directoryPath = isFolder ? uri.fsPath : path.dirname(uri.fsPath);
    const selectedPath = uri.fsPath;
    let transfer;
    let descriptionsReminder;
    let uploadRobot;

    // Check every LS file before connecting; stop here if the user cancels.
    let lsUris;
    if (isFolder) {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        lsUris = entries
            .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.ls'))
            .map(([name]) => vscode.Uri.file(path.join(selectedPath, name)));
    } else {
        lsUris = /\.ls$/i.test(selectedPath) ? [uri] : [];
    }
    const lsCheck = await checkLsFilesBeforeUpload(lsUris);
    if (!lsCheck) {
        outputChannel.appendLine('Upload cancelled after the LS check.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Uploading files to robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(directoryPath, 'Upload', async (client, ipAddress, robot) => {
                const sentFiles = [];
                // Upload either a file or a folder
                if (isFolder) {
                    const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(selectedPath));
                    const lsFiles = files.filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.ls'));
                    const totalFiles = lsFiles.length;
                    let uploadedCount = 0;
                    const totalBytes = lsFiles.reduce((sum, [fileName]) => sum + getFileSize(path.join(selectedPath, fileName)), 0);

                    if (totalFiles === 0) {
                        vscode.window.showInformationMessage('No .LS files found in the selected folder.');
                        return;
                    }

                    try {
                        const completeProgress = trackTransferProgress(client, progress, totalBytes, 'Uploading');

                        for (const [fileName] of lsFiles) {
                            const localPath = path.join(selectedPath, fileName);
                            outputChannel.appendLine(`Uploading file: ${fileName}`);
                            await client.uploadFrom(localPath, fileName);
                            sentFiles.push(localPath);
                            uploadedCount++;
                            outputChannel.appendLine(`Uploaded ${uploadedCount} of ${totalFiles}: ${fileName}`);
                        }

                        completeProgress(`${uploadedCount} of ${totalFiles} files uploaded`);
                    } finally {
                        client.trackProgress();
                    }
                } else {
                    // Single file upload
                    const totalBytes = getFileSize(selectedPath);
                    outputChannel.appendLine(`Uploading file: ${path.basename(selectedPath)}`);
                    try {
                        const completeProgress = trackTransferProgress(client, progress, totalBytes, 'Uploading');
                        await client.uploadFrom(selectedPath, path.basename(selectedPath));
                        sentFiles.push(selectedPath);
                        completeProgress('Upload complete');
                    } finally {
                        client.trackProgress();
                    }
                }
                
                vscode.window.showInformationMessage(`File(s) uploaded successfully to ${ipAddress}`);
                transfer = { kind: 'upload', operation: 'Upload', files: sentFiles, folder: directoryPath, robotName: robot.name, ip: ipAddress };
                // While still connected: send the descriptions the user chose to save, or check whether they differ.
                uploadRobot = { ip: ipAddress, port: robot.port, name: robot.name };
                if (lsCheck === 'sendDescriptions') {
                    progress.report({ message: 'Sending descriptions' });
                    await sendDescriptionsAfterUpload(client, directoryPath, ipAddress, robot);
                } else {
                    progress.report({ message: 'Checking descriptions' });
                    descriptionsReminder = await checkDescriptionsAfterUpload(client, directoryPath, ipAddress, robot);
                }
            });
        }
    );

    // Follow-up questions run on their own so the command ends now, even if a notification is ignored.
    if (transfer) {
        inBackground('Git', () => commitTransfer(transfer));
    }
    if (descriptionsReminder) {
        inBackground('Descriptions reminder', () => offerToSendDescriptions(descriptionsReminder, directoryPath, uploadRobot));
    }
}

async function f_downloadFromRobot(destinationUri, isFolder, fileType, saveType) {
    const directoryPath = isFolder ? destinationUri.fsPath : path.dirname(destinationUri.fsPath);
    const destinationPath = destinationUri.fsPath;

    // Create a subfolder labeled with today's date and handle existing folders
    const today = new Date();
    const baseFolderName = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}` + "-" + saveType;
    let counter = 1;
    let folderName = `${baseFolderName}_${String(counter).padStart(2, '0')}`;

    while (fs.existsSync(path.join(destinationPath, folderName))) {
        folderName = `${baseFolderName}_${String(counter).padStart(2, '0')}`;
        counter++;
    }

    // Layout "fixed": one folder per download type (ALL or LS), overwritten each time so git shows the changes.
    const layout = vscode.workspace.getConfiguration('robotFtp', destinationUri).get('downloadLayout', 'dated');
    const dateFolderPath = layout === 'fixed' ? path.join(destinationPath, saveType) : path.join(destinationPath, folderName);
    fs.mkdirSync(dateFolderPath, { recursive: true });
    let missingDescriptions;
    let transfer;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading files from robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(directoryPath, 'Download', async (client, ipAddress, robot) => {
                const receivedFiles = [];
                const fileList = await client.list();

                // Count matching files for progress tracking
                const filesToDownload = fileList.filter(file => {
                    if (!file.isFile) return false;
                    return fileType === "*" || file.name.toLowerCase().endsWith(fileType.toLowerCase());
                });
                
                const totalFiles = filesToDownload.length;
                let downloadedCount = 0;
                const totalBytes = filesToDownload.reduce((sum, file) => sum + (file.size || 0), 0);

                if (totalFiles === 0) {
                    vscode.window.showInformationMessage(`No ${fileType === "*" ? "matching" : fileType} files found on the robot.`);
                    return;
                }

                try {
                    const completeProgress = trackTransferProgress(client, progress, totalBytes, 'Downloading');

                    for (const file of filesToDownload) {
                        const localPath = path.join(dateFolderPath, file.name);
                        outputChannel.appendLine(`Downloading file: ${file.name}`);
                        await client.downloadTo(localPath, file.name);
                        receivedFiles.push(localPath);
                        downloadedCount++;
                        outputChannel.appendLine(`Downloaded ${downloadedCount} of ${totalFiles}: ${file.name}`);
                    }

                    completeProgress(`${downloadedCount} of ${totalFiles} files downloaded`);
                } finally {
                    client.trackProgress();
                }
                
                // Sort into sub-folders by type (Programs, System, Diagnostics, …) unless the user wants a flat folder.
                let savedFiles = receivedFiles;
                const sortConfig = vscode.workspace.getConfiguration('robotFtp', destinationUri);
                if (sortConfig.get('downloadSort', 'sorted') === 'sorted') {
                    try {
                        savedFiles = sortDownloadedFiles(dateFolderPath, receivedFiles, {
                            folders: sortConfig.get('downloadFolders', DEFAULT_FOLDERS),
                            systemPrograms: sortConfig.get('systemPrograms', DEFAULT_SYSTEM_PROGRAMS)
                        });
                        outputChannel.appendLine(`Sorted ${savedFiles.length} file(s) into sub-folders of ${dateFolderPath}`);
                    } catch (error) {
                        outputChannel.appendLine(`Warning: Could not sort the downloaded files: ${error.message}`);
                        vscode.window.showWarningMessage(`Files were downloaded but could not all be sorted into sub-folders: ${error.message}`);
                        // Some files may already be moved: use whatever is in the download folder now.
                        savedFiles = listFilesRecursive(dateFolderPath).map(relative => path.join(dateFolderPath, relative));
                    }
                }

                vscode.window.showInformationMessage(`${fileType === "*" ? "All" : fileType} files downloaded successfully to ${dateFolderPath}`);
                transfer = { kind: 'download', operation: fileType === '*' ? 'Download all files' : 'Download LS files', files: savedFiles, folder: dateFolderPath, robotName: robot.name, ip: ipAddress };

                // If this robot has no descriptions yet, get its comment files while still connected.
                missingDescriptions = findRobotMissingDescriptions(destinationPath, ipAddress);
                if (missingDescriptions) {
                    missingDescriptions.ipAddress = ipAddress;
                    if (fileType === '*') {
                        missingDescriptions.sourceFolder = dateFolderPath;
                    } else {
                        missingDescriptions.sourceFolder = await downloadDescriptionFiles(client, fileList);
                        missingDescriptions.isTemp = true;
                    }
                }
            });
        }
    );

    // Follow-up questions run on their own so the command ends now, even if a notification is ignored.
    // The download is offered for commit right away; a descriptions file created later is offered on its own.
    if (transfer) {
        inBackground('Git', () => commitTransfer(transfer));
    }
    if (missingDescriptions) {
        inBackground('Create descriptions', async () => {
            const descriptionsFile = await offerToCreateDescriptions(missingDescriptions, destinationPath);
            if (descriptionsFile && transfer) {
                await commitTransfer({ ...transfer, operation: `Create descriptions for ${transfer.robotName || transfer.ip}`, files: [descriptionsFile] });
            }
        });
    }
}

const SKIP_DESCRIPTIONS_PROMPT_KEY = 'robotFtp.skipDescriptionsPrompt';

/**
 * Copies a sorted backup into one flat folder next to it ("<name>-Restore"), the layout a FANUC controller
 * expects when restoring from a USB stick or memory card. The sorted backup is not changed.
 */
async function makeRestoreFolder(resourceUri) {
    if (!resourceUri || !fs.existsSync(resourceUri.fsPath) || !fs.statSync(resourceUri.fsPath).isDirectory()) {
        vscode.window.showErrorMessage('Right-click a backup folder (from Get ALL Files from Robot) to make a restore folder.');
        return;
    }
    const source = resourceUri.fsPath;
    try {
        const { copies, duplicates } = planRestoreFolder(source);
        if (copies.length === 0) {
            vscode.window.showWarningMessage(`${path.basename(source)} has no files.`);
            return;
        }
        let target = `${source}-Restore`;
        for (let n = 2; fs.existsSync(target); n++) {
            target = `${source}-Restore_${String(n).padStart(2, '0')}`;
        }
        if (duplicates.length > 0) {
            const go = 'Make Restore Folder';
            const answer = await vscode.window.showWarningMessage(
                `${duplicates.length} file name(s) appear in more than one sub-folder: ${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ', …' : ''}`,
                { modal: true, detail: 'A flat folder can hold only one file with each name. The first one found is copied and the others are skipped.' },
                go
            );
            if (answer !== go) return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Making restore folder ${path.basename(target)}` },
            async progress => {
                fs.mkdirSync(target, { recursive: true });
                copies.forEach((copy, index) => {
                    fs.copyFileSync(copy.from, path.join(target, copy.name));
                    if (index % 25 === 0) progress.report({ message: `${index + 1} of ${copies.length}` });
                });
            }
        );
        outputChannel.appendLine(`Restore folder: copied ${copies.length} file(s) from ${source} to ${target}${duplicates.length ? `; skipped duplicates: ${duplicates.join(', ')}` : ''}`);
        const reveal = 'Show in File Explorer';
        inBackground('Restore folder', async () => {
            const choice = await vscode.window.showInformationMessage(
                `Made restore folder ${path.basename(target)} with ${copies.length} file(s), all in one folder. Copy its contents to a USB stick or memory card to restore the controller.`,
                reveal
            );
            if (choice === reveal) {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
            }
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Could not make the restore folder: ${error.message}`);
    }
}

/** Turns back on every "Don't remind me" / "Don't ask again" choice. */
async function resetReminders() {
    const turnedOff = [];
    if (extensionContext.globalState.get(GIT_UNAVAILABLE_DONT_REMIND_KEY, false)) {
        turnedOff.push('the warning that Git is not available');
    }
    const skippedRobots = extensionContext.workspaceState.get(SKIP_DESCRIPTIONS_PROMPT_KEY, []);
    if (skippedRobots.length > 0) {
        turnedOff.push(`the question to create descriptions for ${skippedRobots.join(', ')} (this workspace)`);
    }
    if (sendDescriptionsReminderOff()) {
        turnedOff.push('the reminder to send changed descriptions after an upload');
    }
    if (turnedOff.length === 0) {
        vscode.window.showInformationMessage('No Robot FTP reminders are turned off.');
        return;
    }
    await extensionContext.globalState.update(GIT_UNAVAILABLE_DONT_REMIND_KEY, undefined);
    await extensionContext.workspaceState.update(SKIP_DESCRIPTIONS_PROMPT_KEY, undefined);
    await extensionContext.workspaceState.update(SKIP_SEND_DESCRIPTIONS_REMINDER_KEY, undefined);
    sendDescriptionsReminderSnoozed = false;
    gitUnavailableWarned = false;
    outputChannel.appendLine(`Reminders turned back on: ${turnedOff.join('; ')}`);
    vscode.window.showInformationMessage(`Turned back on: ${turnedOff.join('; ')}.`);
}

/**
 * After a download: the named robot (by folder, then by IP) whose descriptions file is missing or empty,
 * unless the user chose "Don't ask again" for it. Returns { workspaceRoot, robot, filePath } or undefined.
 */
function findRobotMissingDescriptions(destinationPath, ipAddress) {
    const workspaceRoot = getWorkspaceRoot(destinationPath);
    if (!workspaceRoot) {
        return undefined;
    }
    const { robots } = readIpConfig(workspaceRoot);
    const robot = robotForPath(robots, workspaceRoot, destinationPath) || robots.find(candidate => candidate.ip === ipAddress);
    if (!robot) {
        outputChannel.appendLine(`No named robot for ${ipAddress}; skipping the descriptions check. Save the robot with a name to use descriptions.`);
        return undefined;
    }
    const skipped = extensionContext.workspaceState.get(SKIP_DESCRIPTIONS_PROMPT_KEY, []);
    if (skipped.includes(robot.name.toLowerCase())) {
        return undefined;
    }
    const filePath = getRobotDescriptionsPath(workspaceRoot, robot);
    try {
        if (fs.existsSync(filePath) && parseDescriptionsCsv(fs.readFileSync(filePath, 'utf8')).descriptions.size > 0) {
            return undefined;
        }
    } catch (error) {
        outputChannel.appendLine(`Warning: Could not read ${filePath}: ${error.message}`);
        return undefined;
    }
    return { workspaceRoot, robot, filePath };
}

/** Downloads the comment files listed in fileList into a new temp folder. Returns the folder path. */
async function downloadDescriptionFiles(client, fileList) {
    const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-ftp-descriptions-'));
    try {
        for (const file of fileList.filter(item => item.isFile && BACKUP_FILES.includes(item.name.toLowerCase()))) {
            await client.downloadTo(path.join(tempFolder, file.name), file.name);
        }
    } catch (error) {
        outputChannel.appendLine(`Warning: Could not download description files: ${error.message}`);
    }
    return tempFolder;
}

async function offerToCreateDescriptions(missing, destinationPath) {
    const { workspaceRoot, robot, filePath, sourceFolder, isTemp, ipAddress } = missing;
    try {
        const relativePath = path.relative(workspaceRoot, filePath).split(path.sep).join('/');
        const create = 'Create';
        const dontAsk = `Don't ask again for ${robot.name}`;
        const choice = await vscode.window.showInformationMessage(
            `Robot ${robot.name} has no descriptions yet. Create ${relativePath} from the robot's I/O and register comments?`,
            create, 'Not now', dontAsk
        );
        if (choice === create) {
            return await importDescriptionsFromFolder(sourceFolder, workspaceRoot, destinationPath, `robot ${robot.name} (${ipAddress})`, filePath);
        } else if (choice === dontAsk) {
            const skipped = extensionContext.workspaceState.get(SKIP_DESCRIPTIONS_PROMPT_KEY, []);
            await extensionContext.workspaceState.update(SKIP_DESCRIPTIONS_PROMPT_KEY, [...skipped, robot.name.toLowerCase()]);
            outputChannel.appendLine(`Will not ask again to create descriptions for ${robot.name}. Use MNAutomation → Descriptions → Get Descriptions from Robot to create them later.`);
        }
        return undefined;
    } finally {
        if (isTemp) {
            fs.rmSync(sourceFolder, { recursive: true, force: true });
        }
    }
}

async function f_updateFilesFromRobot(fileType, resourceUri) {
    const selectedFolders = await vscode.window.showOpenDialog({
        defaultUri: defaultFolderUri(resourceUri),
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select Folder to Save Files"
    });

    if (!selectedFolders || selectedFolders.length === 0) {
        vscode.window.showErrorMessage("Please select a folder from the Explorer or via the file picker.");
        return;
    }

    const destinationPath = selectedFolders[0].fsPath;
    let transfer;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Updating files from robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(destinationPath, 'Update', async (client, ipAddress, robot) => {
                const receivedFiles = [];
                const fileList = await client.list();

                // Get the list of files already downloaded (existing in the local folder)
                const downloadedFiles = new Set();
                const existingFiles = fs.readdirSync(destinationPath);
                existingFiles.forEach(file => downloadedFiles.add(file.toLowerCase()));

                // Count matching files for progress tracking
                const filesToUpdate = fileList.filter(file => {
                    if (!file.isFile) return false;
                    if (fileType !== "*" && !file.name.toLowerCase().endsWith(fileType.toLowerCase())) return false;
                    return downloadedFiles.has(file.name.toLowerCase());
                });
                
                const totalFiles = filesToUpdate.length;
                let updatedCount = 0;
                const totalBytes = filesToUpdate.reduce((sum, file) => sum + (file.size || 0), 0);

                if (totalFiles === 0) {
                    vscode.window.showInformationMessage(`No existing ${fileType === "*" ? "matching" : fileType} files found to update in ${destinationPath}`);
                    return;
                }

                try {
                    const completeProgress = trackTransferProgress(client, progress, totalBytes, 'Updating');

                    for (const file of fileList) {
                        if (file.isFile && (fileType === "*" || file.name.toLowerCase().endsWith(fileType.toLowerCase()))) {
                            if (!downloadedFiles.has(file.name.toLowerCase())) {
                                outputChannel.appendLine(`File not in list, skipping: ${file.name}`);
                                continue;
                            }

                            const localPath = path.join(destinationPath, file.name);
                            outputChannel.appendLine(`Updating file: ${file.name}`);
                            await client.downloadTo(localPath, file.name);
                            receivedFiles.push(localPath);
                            updatedCount++;
                            outputChannel.appendLine(`Updated ${updatedCount} of ${totalFiles}: ${file.name}`);
                        }
                    }

                    completeProgress(`${updatedCount} of ${totalFiles} files updated`);
                } finally {
                    client.trackProgress();
                }

                vscode.window.showInformationMessage(`${fileType === "*" ? "All" : fileType} files updated successfully in ${destinationPath}`);
                transfer = { kind: 'download', operation: 'Update LS files', files: receivedFiles, folder: destinationPath, robotName: robot.name, ip: ipAddress };
            });
        }
    );

    if (transfer) {
        inBackground('Git', () => commitTransfer(transfer));
    }
}

async function f_updateSelectedFileFromRobot(uri, fileType) {
    const directoryPath = path.dirname(uri.fsPath);

    const selectedFolder = await vscode.window.showOpenDialog({
        defaultUri: defaultFolderUri(uri),
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select Folder to Save the File"
    });

    if (!selectedFolder || selectedFolder.length === 0) {
        vscode.window.showErrorMessage("Please select a folder from the Explorer or via the file picker.");
        return;
    }

    const destinationPath = selectedFolder[0].fsPath;
    const selectedPath = uri.fsPath;
    const selectedFile = path.basename(selectedPath);
    let transfer;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading file from robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(directoryPath, 'UpdateSelected', async (client, ipAddress, robot) => {
                const fileList = await client.list();

                const filteredFiles = fileList.filter(file => 
                    file.isFile && (fileType === "*" || file.name.toLowerCase().endsWith(fileType.toLowerCase()))
                );

                if (filteredFiles.length === 0) {
                    vscode.window.showInformationMessage(`No files of type "${fileType}" found on the robot.`);
                    return;
                }

                const remoteFile = filteredFiles.find(file => file.name.toLowerCase() === selectedFile.toLowerCase());

                if (!remoteFile) {
                    vscode.window.showInformationMessage(`File "${selectedFile}" was not found on the robot.`);
                    return;
                }

                const localPath = path.join(destinationPath, selectedFile);
                outputChannel.appendLine(`Downloading file: ${selectedFile}`);
                try {
                    const completeProgress = trackTransferProgress(client, progress, remoteFile.size || 0, 'Downloading');
                    await client.downloadTo(localPath, remoteFile.name);
                    completeProgress('Download complete');
                } finally {
                    client.trackProgress();
                }

                vscode.window.showInformationMessage(`File "${selectedFile}" downloaded successfully to ${destinationPath}`);
                transfer = { kind: 'download', operation: `Update ${selectedFile}`, files: [localPath], folder: destinationPath, robotName: robot.name, ip: ipAddress };
            });
        }
    );

    if (transfer) {
        inBackground('Git', () => commitTransfer(transfer));
    }
}

// ---- Git commits after robot transfers ------------------------------------

let gitUnavailableWarned = false;
const GIT_UNAVAILABLE_DONT_REMIND_KEY = 'robotFtp.git.dontRemindUnavailable';
const GIT_INSTALL_URL = 'https://git-scm.com/install';

/** VS Code's built-in Git extension API, or undefined (warns once per session). */
async function getGitApi() {
    try {
        const extension = vscode.extensions.getExtension('vscode.git');
        if (extension) {
            const exports = extension.isActive ? extension.exports : await extension.activate();
            if (exports?.enabled) {
                const api = exports.getAPI(1);
                if (api.state !== 'initialized') {
                    await new Promise(resolve => {
                        const timer = setTimeout(resolve, 5000);
                        const listener = api.onDidChangeState(state => {
                            if (state === 'initialized') {
                                clearTimeout(timer);
                                listener.dispose();
                                resolve();
                            }
                        });
                    });
                }
                return api;
            }
        }
    } catch (error) {
        outputChannel.appendLine(`Git: could not load the Git extension: ${error.message}`);
    }
    // Once per session, unless the user chose "Don't Remind Me". Commits start working by themselves once git is available.
    if (!gitUnavailableWarned && !extensionContext.globalState.get(GIT_UNAVAILABLE_DONT_REMIND_KEY, false)) {
        gitUnavailableWarned = true;
        const dontRemind = 'Don\'t Remind Me';
        vscode.window.showWarningMessage(
            `Robot FTP: robot transfers can't be committed because Git isn't installed or VS Code's Git is turned off. [Install Git](${GIT_INSTALL_URL}), or turn on the setting git.enabled. Transfers still work.`,
            'OK', dontRemind
        ).then(async choice => {
            if (choice === dontRemind) {
                await extensionContext.globalState.update(GIT_UNAVAILABLE_DONT_REMIND_KEY, true);
                outputChannel.appendLine('Git: will not remind again that Git is unavailable.');
            }
        });
    }
    outputChannel.appendLine('Git: not available (not installed or turned off); skipping the commit.');
    return undefined;
}

/** The SVN working copy root at or above folderPath (a folder containing .svn), or undefined. */
function findSvnRoot(folderPath) {
    let current = path.resolve(folderPath);
    for (;;) {
        if (fs.existsSync(path.join(current, '.svn'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

/** Nearest folder at or above folderPath that contains .git. */
function findGitRoot(folderPath) {
    let current = path.resolve(folderPath);
    for (;;) {
        if (fs.existsSync(path.join(current, '.git'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function adaptRepository(repository) {
    const paths = changes => (changes || []).map(change => change.uri.fsPath);
    return {
        root: repository.rootUri.fsPath,
        branch: () => repository.state.HEAD?.name,
        hasRemote: () => repository.state.remotes.length > 0,
        refresh: () => repository.status(),
        changedPaths: () => [...paths(repository.state.workingTreeChanges), ...paths(repository.state.untrackedChanges)],
        stagedPaths: () => paths(repository.state.indexChanges),
        add: files => repository.add(files),
        unstage: files => repository.revert(files),
        commit: message => repository.commit(message),
        push: () => repository.push(),
        showInSourceControl: async message => {
            repository.inputBox.value = message;
            await vscode.commands.executeCommand('workbench.view.scm');
        }
    };
}

function gitAdapter(api) {
    return {
        findRepo: async folder => {
            const root = findGitRoot(folder);
            if (!root) {
                return null;
            }
            const rootUri = vscode.Uri.file(root);
            const repository = api.getRepository(rootUri) || await api.openRepository(rootUri);
            return repository ? adaptRepository(repository) : null;
        },
        initChoices: folder => initChoicesFor(folder, getWorkspaceRoot(folder)),
        // Inside an SVN working copy: don't offer to create a git repository there.
        skipInitReason: folder => {
            const svnRoot = findSvnRoot(folder);
            return svnRoot ? `${folder} is in an SVN working copy (${svnRoot})` : undefined;
        },
        init: async folder => {
            const repository = await api.init(vscode.Uri.file(folder));
            outputChannel.appendLine(`Git: initialized a repository in ${folder}`);
            if (!repository) {
                return null;
            }
            const repo = adaptRepository(repository);
            const gitignore = writeGitignore(folder);
            repo.createdFiles = gitignore ? [gitignore] : [];
            return repo;
        }
    };
}

/** Adds robotFtp.git.ignorePatterns to <folder>/.gitignore. Returns its path when something was written. */
function writeGitignore(folder) {
    const patterns = vscode.workspace.getConfiguration('robotFtp.git', vscode.Uri.file(folder)).get('ignorePatterns', DEFAULT_IGNORE_PATTERNS);
    const filePath = path.join(folder, '.gitignore');
    try {
        const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
        const { text, added } = mergeGitignore(existing, patterns);
        if (added.length === 0) {
            return undefined;
        }
        fs.writeFileSync(filePath, text, 'utf8');
        outputChannel.appendLine(`Git: added ${added.join(', ')} to ${filePath}`);
        return filePath;
    } catch (error) {
        outputChannel.appendLine(`Warning: Could not write ${filePath}: ${error.message}`);
        return undefined;
    }
}

const gitUi = {
    input: options => vscode.window.showInputBox({ ...options, ignoreFocusOut: true }),
    choose: (message, buttons, options = {}) => vscode.window.showInformationMessage(message, { modal: !!options.modal }, ...buttons),
    pick: (items, options) => vscode.window.showQuickPick(items, { ...options, ignoreFocusOut: true }),
    info: message => vscode.window.showInformationMessage(message),
    warn: message => vscode.window.showWarningMessage(message)
};

function getGitSettings(folder) {
    const config = vscode.workspace.getConfiguration('robotFtp.git', vscode.Uri.file(folder));
    return {
        onDownload: config.get('onDownload', 'prompt'),
        onUpload: config.get('onUpload', 'prompt'),
        commitMode: config.get('commitMode', 'auto'),
        messageTemplate: config.get('messageTemplate', DEFAULT_TEMPLATE),
        push: config.get('push', 'never'),
        offerInit: config.get('offerInit', true)
    };
}

/** Offers a commit for a finished transfer. Never throws. */
async function commitTransfer(result) {
    try {
        const settings = getGitSettings(result.folder);
        const mode = result.kind === 'upload' ? settings.onUpload : settings.onDownload;
        if (mode !== 'prompt' || result.files.length === 0) {
            return;
        }
        const api = await getGitApi();
        if (!api) {
            return;
        }
        const status = await offerCommit({ git: gitAdapter(api), ui: gitUi, settings, result });
        outputChannel.appendLine(`Git after ${result.operation}: ${status}`);
    } catch (error) {
        outputChannel.appendLine(`Git: ${error.message}`);
        vscode.window.showErrorMessage(`Git commit failed: ${error.message}`);
    }
}

const RECENT_IPS_STATE_KEY = 'robotFtp.recentIps';
const BUILT_IN_IPS = [
    { ip: '192.168.10.124', description: 'Default IP address' },
    { ip: '192.168.95.112', description: 'Aggressive Hydraulics' },
    { ip: '127.0.0.2', description: 'RoboGuide LoopBack' }
];

/** The workspace folder path that holds the robot list for directoryPath, or undefined outside any workspace folder. */
function getWorkspaceRoot(directoryPath) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(directoryPath));
    return workspaceFolder ? workspaceFolder.uri.fsPath : undefined;
}

function readIpConfig(workspaceRoot) {
    try {
        if (!workspaceRoot) {
            return { robots: [], recent: cleanRecentIps(extensionContext.globalState.get(RECENT_IPS_STATE_KEY, [])) };
        }
        const config = readProjectConfig(workspaceRoot);
        for (const problem of config.problems) {
            outputChannel.appendLine(`Warning: ${getProjectIpsPath(workspaceRoot)}: ${problem}`);
        }
        return config;
    } catch (error) {
        outputChannel.appendLine(`Warning: Failed to read robot list: ${error.message}`);
        vscode.window.showWarningMessage(`Could not read the robot list: ${error.message}`);
        return { robots: [], recent: [] };
    }
}

async function saveRecentIp(workspaceRoot, ipAddress) {
    try {
        let updatedIps;
        if (workspaceRoot) {
            updatedIps = saveProjectRecentIp(workspaceRoot, ipAddress);
        } else {
            updatedIps = addRecentIp(extensionContext.globalState.get(RECENT_IPS_STATE_KEY, []), ipAddress);
            await extensionContext.globalState.update(RECENT_IPS_STATE_KEY, updatedIps);
        }
        const location = workspaceRoot ? getProjectIpsPath(workspaceRoot) : 'VS Code global state';
        outputChannel.appendLine(`Recent robot IPs updated (${location}): ${updatedIps.join(', ')}`);
    } catch (error) {
        outputChannel.appendLine(`Warning: Failed to save recent IP history: ${error.message}`);
    }
}

/** After a custom IP is entered, optionally save it as a named robot. Returns the port to use (undefined = setting). */
async function offerToSaveRobot(workspaceRoot, directoryPath, ipAddress, robots) {
    const choice = await vscode.window.showQuickPick(
        [
            { label: 'Use once', description: 'Only add it to the recent list', save: false },
            { label: 'Save as a named robot', description: 'Keep it in this project\'s robot list', save: true }
        ],
        { placeHolder: `Save ${ipAddress} as a named robot?` }
    );
    if (!choice || !choice.save) {
        return undefined;
    }

    const name = await vscode.window.showInputBox({
        prompt: 'Robot name (e.g., ST02)',
        validateInput: value => value.trim() ? null : 'Enter a name.'
    });
    if (!name) {
        return undefined;
    }
    const existing = robots.find(robot => robot.name.toLowerCase() === name.trim().toLowerCase());
    if (existing) {
        const replace = await vscode.window.showWarningMessage(
            `A robot named "${existing.name}" (${existing.ip}) already exists. Replace it?`, { modal: true }, 'Replace'
        );
        if (replace !== 'Replace') {
            return undefined;
        }
    }

    const folderItems = [
        { label: 'No folder', description: 'Do not sort this robot first in any folder', folder: undefined },
        ...folderChoices(workspaceRoot, directoryPath).map(folder => ({
            label: folder, description: 'Sort this robot first for commands in this folder', folder
        }))
    ];
    const folderPick = await vscode.window.showQuickPick(folderItems, {
        placeHolder: 'Which folder belongs to this robot?'
    });
    if (!folderPick) {
        return undefined;
    }

    const portInput = await vscode.window.showInputBox({
        prompt: `FTP port for this robot. Leave blank to use the Port setting (currently ${getRobotConfig().port}).`,
        placeHolder: 'e.g., 9125 for RoboGuide',
        validateInput: value => !value.trim() || isValidPort(Number(value.trim())) ? null : 'Enter a port from 1 to 65535, or leave blank.'
    });
    if (portInput === undefined) {
        return undefined;
    }
    const port = portInput.trim() ? Number(portInput.trim()) : undefined;

    try {
        saveProjectRobot(workspaceRoot, { name: name.trim(), ip: ipAddress, folder: folderPick.folder, port });
        outputChannel.appendLine(`Saved robot ${name.trim()} (${ipAddress}) to ${getProjectIpsPath(workspaceRoot)}`);
    } catch (error) {
        vscode.window.showErrorMessage(`Could not save the robot: ${error.message}`);
    }
    return port;
}

/**
 * Prompt for the robot to connect to. Named robots and recent IPs come from the project's .vscode/robot-ftp.json.
 *
 * @param {string} directoryPath - The folder the command runs on. Its workspace folder selects the robot list, and it decides which robot is sorted first.
 * @returns {Promise<{ip: string, port: (number|undefined), name: (string|undefined)}>} - port undefined means use the Port setting.
 */
async function getRobotIp(directoryPath) {
    const workspaceRoot = getWorkspaceRoot(directoryPath);
    const { robots, recent } = readIpConfig(workspaceRoot);
    const ipOptions = buildIpOptions({ robots, recent, workspaceRoot, targetPath: directoryPath, builtIns: BUILT_IN_IPS });

    const selected = await vscode.window.showQuickPick(ipOptions, {
        placeHolder: 'Select a robot or recent IP, or choose "Other" to enter an IP address.',
        matchOnDescription: true
    });

    if (!selected) {
        throw new Error('An IP address selection is required.');
    }

    let ip = selected.ip;
    let port = selected.port;

    if (selected.kind === OTHER_OPTION) {
        const customIp = await vscode.window.showInputBox({
            prompt: 'Enter the custom IP address:',
            placeHolder: 'e.g., 192.168.1.1',
            validateInput: value => IP_PATTERN.test(value) ? null : 'Please enter a valid IP address.'
        });

        if (!customIp) {
            throw new Error('A custom IP address is required.');
        }

        ip = customIp;
        if (workspaceRoot) {
            port = await offerToSaveRobot(workspaceRoot, directoryPath, ip, robots);
        }
    }

    await saveRecentIp(workspaceRoot, ip);
    return { ip, port, name: selected.robotName };
}

async function openRobotList(resourceUri) {
    const workspaceFolder = await selectWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('Open a folder first. The robot list is stored in the folder\'s .vscode/robot-ftp.json.');
        return;
    }
    try {
        const filePath = ensureProjectFile(workspaceFolder.uri.fsPath);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath)));
    } catch (error) {
        vscode.window.showErrorMessage(`Could not open the robot list: ${error.message}`);
    }
}

/**
 * Get FTP configuration from VS Code settings.
 * 
 * @returns {Object} - Object containing port, username, and password
 */
function getRobotConfig() {
    const config = vscode.workspace.getConfiguration('robotFtp');
    return {
        port: config.get('port', 21),
        username: config.get('username', 'Administrator'),
        password: config.get('password', '')
    };
}


function deactivate() {}

module.exports = {
    activate,
    deactivate
};
