# Robot File Sync Extension for Visual Studio Code

## Overview
This Visual Studio Code extension allows you to interact with a Fanuc robot via FTP for uploading and downloading files. It provides several commands to upload files, download files, and update existing files from the robot, as well as manage descriptions from a CSV file. The extension also integrates inlay hints into the editor for quick reference of descriptions related to certain keywords.

## Features

### Download Files:
- Download all files from the robot.
- Download `.ls` files from the robot.
- Update files from the robot into a selected folder.
- Show byte-level progress while large files are downloading.

### Upload Files:
- Upload individual files or folders to the robot.
- Show byte-level progress while large files are uploading.

### CSV Descriptions:
- Select and load a CSV file that contains descriptions for robot programs.
- Automatically reload the descriptions when the CSV file changes.

### Inlay Hints:
- The extension provides inlay hints for specific keywords (e.g., `DO[x]` or `DI[x]`) based on descriptions from the CSV file.

### File Insertion:
- Insert `.ls` file names into the current document by selecting from a list.

## Commands

1. **`extension.downloadAllFiles`**
   - Downloads all files from the robot to a user-selected folder.

2. **`extension.downloadLsFiles`**
   - Downloads all `.ls` files from the robot to a user-selected folder.

3. **`extension.updateFilesFromRobotLsFiles`**
   - Updates `.ls` files from the robot into a selected folder.

4. **`extension.uploadFileToRobot`**
   - Uploads a single file to the robot.

5. **`extension.uploadFolderToRobot`**
   - Uploads an entire folder to the robot.

6. **`extension.selectCSVFile`**
   - Prompts the user to select a CSV file containing descriptions. Automatically loads the descriptions and watches for changes.

7. **`extension.listLsFilesAndInsert`**
   - Lists `.ls` files in the current directory and allows the user to insert the file name into the active editor.

## File Descriptions
The CSV file used for descriptions should have two columns:

- **Key**: A unique identifier (e.g., `DO[1]` or `DI[1]`).
- **Description**: A textual description corresponding to the key.

### Example of the CSV format:
Key,Description
DO[1],Digital output 1
DI[1],Digital input 1

## Setup Instructions

### Install the Extension:
Install the extension directly from Visual Studio Code's Extensions Marketplace.

### Configure FTP Settings:
The extension can be configured using VS Code settings. You can customize the FTP connection parameters:

- **`robotFtp.port`** (number, default: `21`)
  - The FTP port used by your robot (standard FTP port is 21)
  - **Note:** Fanuc R-30iB/RoboGuide uses non-standard port **9125** - set this if using RoboGuide
  - Set in VS Code settings: `"robotFtp.port": 21` (or `9125` for RoboGuide)

- **`robotFtp.username`** (string, default: `"Administrator"`)
  - The FTP username for your robot
  - Set in VS Code settings: `"robotFtp.username": "Administrator"`

- **`robotFtp.password`** (string, default: `""`)
  - The FTP password for your robot (blank for RoboGuide)
  - Set in VS Code settings: `"robotFtp.password": ""`

The extension will also prompt for an IP address of the robot. The default IP is 192.168.10.124, but you can also enter a custom IP. Once entered, the IP is saved to an `ip.txt` file in your workspace.

### Example Configuration (Standard Robot):
```json
{
    "robotFtp.port": 21,
    "robotFtp.username": "Administrator",
    "robotFtp.password": ""
}
```

### Example Configuration (RoboGuide):
```json
{
    "robotFtp.port": 9125,
    "robotFtp.username": "Administrator",
    "robotFtp.password": ""
}
```

Or configure via Settings UI: Search for "robotFtp" in VS Code settings.

### CSV File:
The extension expects a CSV file with descriptions. You can either use the default descriptions.csv or select a custom CSV file using the extension.selectCSVFile command.

### Commands and Usage:
Use the commands available in the command palette or keybindings to interact with the robot, upload/download files, or insert descriptions into your code.

# Snippet Triggers and Descriptions

1. **Set Frames**  
   - **Trigger**: `set frames`  
   - **Description**: Set Up Frames

2. **If () THEN**  
   - **Trigger**: `IF`  
   - **Description**: IF then, Endif

3. **If () THEN ELSE**  
   - **Trigger**: `IF`  
   - **Description**: IF then, Else, Endif

4. **If (Chooser) THEN**  
   - **Trigger**: `IF`  
   - **Description**: IF Chooser then, Endif

5. **If (Chooser) THEN ELSE**  
   - **Trigger**: `IF`  
   - **Description**: IF Chooser then, Else, Endif

6. **Header**  
   - **Trigger**: `Header`  
   - **Description**: Main Header

7. **Multi Line Text**  
   - **Trigger**: `--eg:`  
   - **Description**: Multi Line Text

8. **To DO**  
   - **Trigger**: `To do`  
   - **Description**: Must Return to Complete

9. **Label**  
   - **Trigger**: `LBL[]`  
   - **Description**: Add label

10. **Jump Label**  
    - **Trigger**: `JMP LBL[]`  
    - **Description**: Add Jump label

11. **Jump Label With Label**  
    - **Trigger**: `JMP LBL[]`  
    - **Description**: Add Jump label

12. **Wait Sec**  
    - **Trigger**: `WAIT`  
    - **Description**: Add Jump label

13. **CALL**  
    - **Trigger**: `CALL `  
    - **Description**: Call Program

## Acknowledgments

This extension's syntax highlighting is based on the work from [TPSyntaxHighlighter](https://github.com/alek5k/TPSyntaxHighlighter). We appreciate the contributions made by the original author. 
