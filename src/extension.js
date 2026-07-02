const vscode = require('vscode');
const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser'); // Install csv-parser for reading CSV files

const outputChannel = vscode.window.createOutputChannel("Robot File Sync");



// Make the activate function async
async function activate(context) {
    outputChannel.show();
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
        await f_updateFilesFromRobot( true, ".ls", "LS"); // Pass true for folder operations
    });

    const updateSelectedFileFromRobot_Function = vscode.commands.registerCommand("extension.updateSelectedFileFromRobot", async (uri) => {
        await f_updateSelectedFileFromRobot(uri, ".ls", "LS"); // Pass true for folder operations
    });


    // Command for uploading a file
    let uploadFile_Function = vscode.commands.registerCommand('extension.uploadFileToRobot', async (uri) => {
        await f_uploadToRobot(uri, false); // false indicates it's a single file
    });

    // Command for uploading a folder
    let uploadFolder_Function = vscode.commands.registerCommand('extension.uploadFolderToRobot', async (uri) => {
        await f_uploadToRobot(uri, true); // true indicates it's a folder
    });

    // Command for selecting CSV file
    let selectCSVFile_Function = vscode.commands.registerCommand('extension.selectCSVFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            outputChannel.appendLine('No active editor found.');
            return;
        }

        // Allow the user to choose a CSV file
        const csvFilePath = await selectCSVFile();

        if (csvFilePath) {
            // Load descriptions from the selected CSV file
            descriptions = await loadDescriptions(csvFilePath);

            // Watch for changes in the selected CSV file
            watchCSVFile(csvFilePath);

            vscode.window.showInformationMessage(`Descriptions loaded from: ${csvFilePath}`);

            // Manually trigger an update of the inlay hints
            updateInlayHints();
        } else {
            vscode.window.showErrorMessage('No CSV file selected.');
        }
    });

    // Listen for the active text editor to ensure a document is open
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        outputChannel.appendLine('No active editor found.');
        return;
    }

    // Load descriptions from the default CSV file located in the same folder as the document
    const directory = path.dirname(editor.document.uri.fsPath); // Get the directory of the current open document
    const defaultCSVPath = path.join(directory, 'descriptions.csv');
    descriptions = await loadDescriptions(defaultCSVPath);
    watchCSVFile(defaultCSVPath);

    // Register inlay hints provider
    const provider = vscode.languages.registerInlayHintsProvider('*', {
    provideInlayHints(document, range, token) {
        const hints = [];
        const regex = /\b(?:do|DI|R|F)\[(\d+)\]/gi;

        // Iterate through each line in the document
        for (let lineNum = range.start.line; lineNum <= range.end.line; lineNum++) {
            const line = document.lineAt(lineNum);
            let match;

            // Match DO[x] patterns in the line (case-insensitive)
            while ((match = regex.exec(line.text.toLowerCase())) !== null) {
                const fullMatch = match[0]; // Full match like "DO[1]" or "do[1]"
                const matchStart = match.index;
                const matchEnd = matchStart + fullMatch.length;
            
                if (descriptions[fullMatch]) {
                    outputChannel.appendLine('Hint loaded:' + fullMatch);
                    // Position the hint just inside the closing bracket
                    const hintPosition = new vscode.Position(lineNum, matchEnd - 1);

                    // Create an inlay hint
                    hints.push(
                        new vscode.InlayHint(
                            hintPosition, // Position inside the closing bracket
                            ` ${descriptions[fullMatch]}`, // Hint content
                            vscode.InlayHintKind.Type // Type of hint
                        )
                    );
                }else{
                    //outputChannel.appendLine('Hint Not loaded:' + fullMatch);
                }
            }
        }
        return hints;
    }
    });

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
    
    // Add all commands and the inlay hint provider to the context subscriptions
    context.subscriptions.push( uploadFile_Function, 
                                uploadFolder_Function, 
                                selectCSVFile_Function, 
                                provider, 
                                downloadAll_Function, 
                                downloadLs_Function,
                                updateLsFilesFromRobot_Function,
                                updateSelectedFileFromRobot_Function,
                                listLsFilesAndInsert_Function);
}

let descriptions = {}; // Store the descriptions

// Function to load descriptions from the CSV file
async function loadDescriptions(csvFilePath) {
    return new Promise((resolve, reject) => {
        const newDescriptions = {};

        // Check if the CSV file exists
        if (!fs.existsSync(csvFilePath)) {
            console.error(`CSV file not found at ${csvFilePath}`);
            outputChannel.appendLine(`CSV file not found at ${csvFilePath}`);
            
            // Create a blank CSV file with headers if it doesn't exist
            const headers = 'Key,Description\n'; // Add headers to the blank CSV file
            fs.writeFileSync(csvFilePath, headers, 'utf8');
            console.log(`Blank CSV file with headers created at ${csvFilePath}`);
            outputChannel.appendLine(`Blank CSV file with headers created at ${csvFilePath}`);
 
             return resolve(newDescriptions); // Return empty descriptions if file doesn't exist
        }

        // Read and parse the CSV file
        fs.createReadStream(csvFilePath)
            .pipe(csv())
            .on('data', (row) => {
                //outputChannel.appendLine('row.Key:', row.Key);
                //outputChannel.appendLine('row.Description:', row.Description);
                
                if (row.Key && row.Description) {
                    newDescriptions[row.Key.toLowerCase()] = row.Description;
                    //outputChannel.appendLine('newDescriptions: ', newDescriptions);
                    
                }
            })
            .on('end', () => {
                outputChannel.appendLine('Descriptions loaded:' + newDescriptions);
                resolve(newDescriptions);
            })
            .on('error', (err) => {
                console.error('Error reading CSV file:', err);
                reject(err);
            });
    });
}

// Watch for changes in the CSV file
function watchCSVFile(csvFilePath) {
    // Watch the CSV file for changes
    fs.watch(csvFilePath, { persistent: true }, async (eventType) => {
        if (eventType === 'change') {
            outputChannel.appendLine('CSV file has been modified. Reloading data...');
            // Reload descriptions from the CSV file
            descriptions = await loadDescriptions(csvFilePath);
            vscode.window.showInformationMessage('CSV file updated. Descriptions reloaded.');

            // Manually trigger an update of the inlay hints
            updateInlayHints();
        }
    });
}

// Function to allow users to select a CSV file
async function selectCSVFile() {
    const selectedFileUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        filters: {
            'CSV Files': ['csv']
        }
    });

    if (selectedFileUri && selectedFileUri.length > 0) {
        return selectedFileUri[0].fsPath;
    }

    return null; // No file selected
}

// Force an update of the inlay hints
function updateInlayHints() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        // This will force a re-calculation of inlay hints
        editor.document.save().then(() => {
            // After saving, the inlay hints should update automatically
            vscode.window.showInformationMessage('Inlay hints updated.');
        });
    }
}

//*****************************************************************
//* This COde Works*/
/**
 * Execute an FTP operation with proper connection management.
 * Ensures the client is ALWAYS closed, even on error.
 * 
 * @param {string} directoryPath - Directory to use for IP retrieval
 * @param {string} operationName - Name of operation for logging
 * @param {Function} callback - Async function that receives (client, ipAddress) and performs FTP operations
 * @returns {Promise<void>}
 */
async function withRobotConnection(directoryPath, operationName, callback) {
    let ipAddress;
    const client = new ftp.Client();
    
    try {
        // Get robot IP address
        ipAddress = await getRobotIp(directoryPath);
        vscode.window.showInformationMessage(`Using IP address: ${ipAddress}`);
        
        // Connect to robot
        const ftpConfig = getRobotConfig();
        client.ftp.verbose = true;
        await client.access({
            host: ipAddress,
            port: ftpConfig.port,
            user: ftpConfig.username,
            password: ftpConfig.password,
            secure: false
        });

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

    await withRobotConnection(directoryPath, 'Upload', async (client, ipAddress) => {
        // Upload either a file or a folder
        if (isFolder) {
            const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(selectedPath));
            const lsFiles = files.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.LS'));

            for (const [fileName] of lsFiles) {
                const localPath = path.join(selectedPath, fileName);
                outputChannel.appendLine(`Uploading file: ${fileName}`);
                await client.uploadFrom(localPath, fileName);
            }
        } else {
            // Single file upload
            outputChannel.appendLine(`Uploading file: ${path.basename(selectedPath)}`);
            await client.uploadFrom(selectedPath, path.basename(selectedPath));
        }
        
        vscode.window.showInformationMessage(`File(s) uploaded successfully to ${ipAddress}`);
    });
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

    await withRobotConnection(directoryPath, 'Download', async (client, ipAddress) => {
        const fileList = await client.list();

        for (const file of fileList) {
            if (file.isFile) {
                if (fileType === "*" || file.name.toLowerCase().endsWith(fileType.toLowerCase())) {
                    const localPath = path.join(dateFolderPath, file.name);
                    outputChannel.appendLine(`Downloading file: ${file.name}`);
                    await client.downloadTo(localPath, file.name);
                }
            }
        }
        
        vscode.window.showInformationMessage(`${fileType === "*" ? "All" : fileType} files downloaded successfully to ${dateFolderPath}`);
    });
}

async function f_updateFilesFromRobot(isFolder, fileType, saveType) {
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

    await withRobotConnection(destinationPath, 'Update', async (client, ipAddress) => {
        const fileList = await client.list();

        // Get the list of files already downloaded (existing in the local folder)
        const downloadedFiles = new Set();
        const existingFiles = fs.readdirSync(destinationPath);
        existingFiles.forEach(file => downloadedFiles.add(file.toLowerCase()));

        for (const file of fileList) {
            if (file.isFile) {
                if (fileType === "*" || file.name.toLowerCase().endsWith(fileType.toLowerCase())) {
                    if (downloadedFiles.has(file.name.toLowerCase())) {
                        const localPath = path.join(destinationPath, file.name);
                        outputChannel.appendLine(`Updating file: ${file.name}`);
                        await client.downloadTo(localPath, file.name);
                    } else {
                        outputChannel.appendLine(`File not in list, skipping: ${file.name}`);
                    }
                }
            }
        }

        vscode.window.showInformationMessage(`${fileType === "*" ? "All" : fileType} files updated successfully in ${destinationPath}`);
    });
}

async function f_updateSelectedFileFromRobot(uri, fileType, saveType) {
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

    await withRobotConnection(directoryPath, 'UpdateSelected', async (client, ipAddress) => {
        const fileList = await client.list();

        const filteredFiles = fileList.filter(file => 
            file.isFile && (fileType === "*" || file.name.toLowerCase().endsWith(fileType.toLowerCase()))
        );

        if (filteredFiles.length === 0) {
            vscode.window.showInformationMessage(`No files of type "${fileType}" found on the robot.`);
            return;
        }

        const localPath = path.join(destinationPath, selectedFile);
        outputChannel.appendLine(`Downloading file: ${selectedFile}`);
        await client.downloadTo(localPath, selectedFile);

        vscode.window.showInformationMessage(`File "${selectedFile}" downloaded successfully to ${destinationPath}`);
    });
}

/**
 * Retrieve or prompt for the robot's IP address.
 * 
 * @param {string} directoryPath - The directory path where ip.txt should be located.
 * @param {string} defaultIp - The default IP address to use if no file exists.
 * @returns {Promise<string>} - The selected or entered IP address.
 */
async function getRobotIp(directoryPath, defaultIp = "192.168.10.124") {
    const fileName = "ip.txt";
    const filePath = path.join(directoryPath, fileName);

    let fileIpAddress;

    // Check if ip.txt exists in the directory
    if (fs.existsSync(filePath)) {
        try {
            const fileContent = fs.readFileSync(filePath, 'utf8').trim();
            if (fileContent) {
                fileIpAddress = fileContent;
            } else {
                vscode.window.showWarningMessage(`The file ${fileName} is empty.`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to read ${fileName}: ${error.message}`);
        }
    } else {
        const createFile = await vscode.window.showQuickPick(
            [
                { label: 'Yes', description: `Create ${fileName}` },
                { label: 'No', description: 'Do not create the file' }
            ],
            {
                placeHolder: `The file ${fileName} was not found. Would you like to create it?`,
                canPickMany: false
            }
        );

        if (createFile && createFile.label === 'Yes') {
            const newIp = await vscode.window.showInputBox({
                prompt: 'Enter an IP address to save in the new file:',
                placeHolder: `e.g., ${defaultIp}`,
                value: defaultIp,
                validateInput: value => {
                    const ipPattern = /^(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)$/;
                    return ipPattern.test(value) ? null : 'Please enter a valid IP address.';
                }
            });

            if (newIp) {
                try {
                    // Ensure the directory exists
                    fs.mkdirSync(directoryPath, { recursive: true });
                    // Create the file with the entered IP address
                    fs.writeFileSync(filePath, newIp, 'utf8');
                    vscode.window.showInformationMessage(`File ${fileName} created at ${filePath} with IP address: ${newIp}`);
                    fileIpAddress = newIp;
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to create ${fileName}: ${error.message}`);
                }
            } else {
                vscode.window.showWarningMessage('No IP address entered. File creation skipped.');
            }
        } else {
            vscode.window.showInformationMessage('File creation skipped.');
        }
    }

    if (!fileIpAddress) {
        // Prompt user to select or enter an IP address if no IP is retrieved from the file
        const ipOptions = [
            { label: defaultIp, description: 'Default IP address' },
            { label: "192.168.95.112", description: 'Aggressive Hydraulics' },
            { label: "127.0.0.2", description: 'RoboGuide LoopBack' },
            { label: 'Other', description: 'Enter a custom IP address' }
        ];

        const selectedIp = await vscode.window.showQuickPick(ipOptions, {
            placeHolder: 'Select the robot\'s IP address or choose "Other" to enter a custom IP.',
            canPickMany: false
        });

        if (!selectedIp) {
            throw new Error('An IP address selection is required.');
        }

        let ipAddress = selectedIp.label;

        if (ipAddress === 'Other') {
            const customIp = await vscode.window.showInputBox({
                prompt: 'Enter the custom IP address:',
                placeHolder: 'e.g., 192.168.1.1',
                validateInput: value => {
                    const ipPattern = /^(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)$/;
                    return ipPattern.test(value) ? null : 'Please enter a valid IP address.';
                }
            });

            if (!customIp) {
                throw new Error('A custom IP address is required.');
            }

            ipAddress = customIp;
        }

        return ipAddress;
    }

    return fileIpAddress;
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
