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
    getSharedDescriptionsPath, getRobotDescriptionsPath, ensureDescriptionsFile
} = require('./descriptions');
const {
    BACKUP_FILES, findBackupFiles, readBackupDescriptions, compareDescriptions, combineDescriptions, serializeDescriptionsCsv
} = require('./backupDescriptions');
const {
    loadSnippetDefinitions,
    PROJECT_SNIPPETS_TEMPLATE,
    USER_SNIPPETS_TEMPLATE
} = require('./externalSnippets');

const outputChannel = vscode.window.createOutputChannel("Robot File Sync");
let extensionContext;

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
    registerLsVerifier(vscode, context, outputChannel);
    context.subscriptions.push(vscode.commands.registerCommand(
        'extension.renameLsFile', createRenameLsCommand(vscode, outputChannel)
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'extension.openSettings',
        () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
    ));
    context.subscriptions.push(vscode.commands.registerCommand('extension.editRobotList', openRobotList));

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
        const selectedFiles = await vscode.window.showOpenDialog({
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

    const downloadAll_Function = vscode.commands.registerCommand("extension.downloadAllFiles", async () => {
        // Prompt the user to select a folder
        const destinationFolder = await vscode.window.showOpenDialog({
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
    const downloadLs_Function = vscode.commands.registerCommand("extension.downloadLsFiles", async () => {
        // Prompt the user to select a folder
        const destinationFolder = await vscode.window.showOpenDialog({
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
    
    const updateLsFilesFromRobot_Function = vscode.commands.registerCommand("extension.updateFilesFromRobotLsFiles", async () => {
        await f_updateFilesFromRobot(".ls");
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

function updateDescriptionDecorations(editor) {
    if (!editor || editor.document.languageId !== 'fanuctp') {
        return;
    }
    const sources = descriptionSourcesFor(editor.document.uri);
    const descriptions = sources
        ? mergeDescriptions(readDescriptionsFile(sources.sharedPath), sources.robotPath ? readDescriptionsFile(sources.robotPath) : undefined)
        : new Map();

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
                const decoration = {
                    range: new vscode.Range(line, found.start, line, found.end),
                    renderOptions: { after: { contentText: ` ${entry.text}` } },
                    hoverMessage: new vscode.MarkdownString(`**${found.key}** ${entry.text}\n\nFrom ${sourceText}`)
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
                    const remoteFiles = (await client.list()).filter(file => file.isFile && BACKUP_FILES.includes(file.name.toLowerCase()));
                    for (const file of remoteFiles) {
                        progress.report({ message: file.name });
                        outputChannel.appendLine(`Downloading file: ${file.name}`);
                        await client.downloadTo(path.join(tempFolder, file.name), file.name);
                    }
                    outputChannel.appendLine(`Downloaded ${remoteFiles.length} of ${BACKUP_FILES.length} description files from ${ipAddress}.`);
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
 * @param {Function} callback - Async function that receives (client, ipAddress) and performs FTP operations
 * @returns {Promise<void>}
 */
async function withRobotConnection(directoryPath, operationName, callback) {
    let ipAddress;
    const client = new ftp.Client();
    const CONNECTION_TIMEOUT = 10000; // 10 seconds timeout
    
    try {
        // Get robot IP address
        const robot = await getRobotIp(directoryPath);
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
        await callback(client, ipAddress);
        
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
 * Upload a file or folder to the robot.
 */
async function f_uploadToRobot(uri, isFolder) {
    if (!uri || !uri.fsPath) {
        vscode.window.showErrorMessage('Please select a file or folder to upload.');
        return;
    }

    const directoryPath = isFolder ? uri.fsPath : path.dirname(uri.fsPath);
    const selectedPath = uri.fsPath;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Uploading files to robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(directoryPath, 'Upload', async (client, ipAddress) => {
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
                        completeProgress('Upload complete');
                    } finally {
                        client.trackProgress();
                    }
                }
                
                vscode.window.showInformationMessage(`File(s) uploaded successfully to ${ipAddress}`);
            });
        }
    );
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

    const dateFolderPath = path.join(destinationPath, folderName);
    fs.mkdirSync(dateFolderPath, { recursive: true });
    let missingDescriptions;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading files from robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(directoryPath, 'Download', async (client, ipAddress) => {
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
                        downloadedCount++;
                        outputChannel.appendLine(`Downloaded ${downloadedCount} of ${totalFiles}: ${file.name}`);
                    }

                    completeProgress(`${downloadedCount} of ${totalFiles} files downloaded`);
                } finally {
                    client.trackProgress();
                }
                
                vscode.window.showInformationMessage(`${fileType === "*" ? "All" : fileType} files downloaded successfully to ${dateFolderPath}`);

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

    if (missingDescriptions) {
        await offerToCreateDescriptions(missingDescriptions, destinationPath);
    }
}

const SKIP_DESCRIPTIONS_PROMPT_KEY = 'robotFtp.skipDescriptionsPrompt';

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
            await importDescriptionsFromFolder(sourceFolder, workspaceRoot, destinationPath, `robot ${robot.name} (${ipAddress})`, filePath);
        } else if (choice === dontAsk) {
            const skipped = extensionContext.workspaceState.get(SKIP_DESCRIPTIONS_PROMPT_KEY, []);
            await extensionContext.workspaceState.update(SKIP_DESCRIPTIONS_PROMPT_KEY, [...skipped, robot.name.toLowerCase()]);
            outputChannel.appendLine(`Will not ask again to create descriptions for ${robot.name}. Use MNAutomation → Descriptions → Get Descriptions from Robot to create them later.`);
        }
    } finally {
        if (isTemp) {
            fs.rmSync(sourceFolder, { recursive: true, force: true });
        }
    }
}

async function f_updateFilesFromRobot(fileType) {
    const selectedFolders = await vscode.window.showOpenDialog({
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

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Updating files from robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(destinationPath, 'Update', async (client) => {
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
                            updatedCount++;
                            outputChannel.appendLine(`Updated ${updatedCount} of ${totalFiles}: ${file.name}`);
                        }
                    }

                    completeProgress(`${updatedCount} of ${totalFiles} files updated`);
                } finally {
                    client.trackProgress();
                }

                vscode.window.showInformationMessage(`${fileType === "*" ? "All" : fileType} files updated successfully in ${destinationPath}`);
            });
        }
    );
}

async function f_updateSelectedFileFromRobot(uri, fileType) {
    const directoryPath = path.dirname(uri.fsPath);

    const selectedFolder = await vscode.window.showOpenDialog({
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

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading file from robot',
            cancellable: false
        },
        async (progress) => {
            await withRobotConnection(directoryPath, 'UpdateSelected', async (client) => {
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
            });
        }
    );
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
