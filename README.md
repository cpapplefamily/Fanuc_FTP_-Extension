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

### Verify an LS file

Right-click an LS file and select **MNAutomation → Verify LS File**. Results appear in the Problems panel with clickable line locations. The verifier checks the current editor contents, including unsaved changes. It does not modify the program. Run verification again after editing; old diagnostics are cleared when the document changes.

The initial rules check nonblank lines within `/MN`, stopping at the next section such as `/POS` or `/END`. Each line must contain a colon and end with a semicolon. All text before the first colon is ignored, so `123: CALL MAIN ;` is valid. Trailing whitespace is ignored. A missing `/MN` section is reported separately. Passing these checks is not a full FANUC syntax validation.

Choose **MNAutomation → Edit LS Verifier Rules** to open your `ls-verifier-rules.json`. It is created on first use in the extension's user storage and shared across workspaces in the current VS Code profile. Rules are read on each verification, including unsaved edits; save the file to persist changes. Invalid rule files report an error instead of silently using defaults.

The JSON contains `version: 2` and a `rules` array. Each rule has a unique `id`, an `enabled` boolean, a `check`, a `message`, and an optional `severity` (`error` or `warning`). Literal `startsWith` / `endsWith` checks also require `section: "MN"` and a literal `value`. The template is in `src/lsVerifierRules.json`. Existing version 1 files are upgraded once: your rules and disabled settings are preserved, and missing advanced checks are appended. Save pending rules edits before upgrading.

Additional configurable checks:

| Check | What it checks | Default severity |
| --- | --- | --- |
| `sections` | Required `/PROG`, `/ATTR`, `/APPL`, `/MN`, `/END` sections and order; repeated `/APPL` headers are allowed between `/ATTR` and `/MN`. Also checks other required-section duplicates, optional `/POS` placement, and content after `/END`. | Error |
| `programName` | FANUC program name validity and case-insensitive match with the LS filename | Error |
| `delimiters` | Unclosed or mismatched brackets, parentheses, and quotes in MN instructions; ignores comments and bracket descriptions | Error |
| `labels` | Duplicate literal `LBL[n]` definitions and literal `JMP LBL[n]` targets without a definition | Error |
| `positions` | Literal `P[n]` references without matching definitions in `/POS` | Error |
| `motion` | Missing/unrecognized position, speed, or termination fields on J/L/C/A motion instructions | Warning |
| `calls` | Literal CALL/RUN targets without a matching local LS, TP, or PC filename | Warning |

Local calls are searched in the selected file's workspace folder, or its containing directory when outside a workspace. Indirect register-based calls, jumps, and positions cannot be resolved statically; `PR[n]` is not required in `/POS`. Motion checks recognize common numeric/register speeds and FINE/CNT/CR termination, including continuation lines for circular moves. Controller-specific forms may need review. The original per-line semicolon rule remains independently configurable and can flag continuation lines that omit a semicolon. Line numbers are never validated. These checks do not replace the controller's loader/compiler.

Motion syntax reference: [FANUC R-30iB basic operator's manual](https://robochallenge.pl/wp-content/uploads/2021/10/R-30iB_Plus_basic_operator_manual_B-83284EN_09_Robo_Challenge.pdf).

### Rename an LS program

Right-click an `.ls` or `.LS` file in Explorer and choose **MNAutomation → Rename LS File**. Enter a name without the extension. Names may contain 1–36 letters, numbers, or underscores, cannot start with a number, and cannot use reserved names such as `CON`, `NUL`, `COM1`, or `LPT1`. This targets newer FANUC controllers supporting 36-character names; older controllers may require shorter names.

After the name passes validation, a second prompt lets you edit the program comment. Comments allow up to 16 characters including letters, numbers, spaces, underscores, `@`, or `*`; leave blank for no comment. Spaces count toward the limit. The existing comment is prefilled. Cancelling either prompt leaves the file unchanged.

The command renames the local file and updates its `/PROG` header and `/ATTR` `COMMENT` field, preserving the extension and other contents. Save pending edits first. Existing filenames are protected, including case-insensitive matches. Calls to the program in other files and programs on the robot are not renamed.

Naming rules: [FANUC R-30iB operator's manual, section 4.1.1](https://robochallenge.pl/wp-content/uploads/2021/10/R-30iB_Plus_basic_operator_manual_B-83284EN_09_Robo_Challenge.pdf).

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

The extension will also prompt for an IP address of the robot. The default IP is 192.168.10.124, but you can also enter a custom IP. Once entered, the IP is saved to an `ip.txt` file in your workspace. The extension also creates `recent-ips.json` next to `ip.txt`, keeps the last five valid robot IPs there, and shows them first the next time you choose an IP.

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

Fanuc snippets are loaded in three additive levels:

1. **Built-in** — Defaults supplied by the extension.
2. **User/global** — An editable `fanuc-snippets.code-snippets` file loaded in every workspace for the current VS Code profile. Run **Open User Fanuc Snippets** to edit it. The file is watched for saved changes and never overwritten during extension updates.
3. **Project** — A `.vscode/fanuc-snippets.code-snippets` file loaded only in the selected workspace. Run **Create/Open Project Fanuc Snippets File** to create it with a starter framework or open the existing file without overwriting it. VS Code loads this file natively; use `"scope": "fanuctp"` on its snippet entries.

On standard Windows VS Code installations, the managed file is stored beneath `%APPDATA%\Code\User\globalStorage\coreyapplegate.robot-ftp`. Use the command instead of relying on that exact path because profiles, VS Code Insiders, and remote environments use different storage roots.

You can additionally run **Load External Fanuc Snippets** and select a `.code-snippets` or `.json` file from Documents, OneDrive, or a network location. The external file augments both the defaults and managed user snippets. Its absolute path is saved under `robotFtp.externalSnippetsFile`. Run **Clear External Fanuc Snippets** to stop loading only the external file.

External files use the standard VS Code snippet format:

```json
{
  "Pulse Output": {
    "prefix": "PULSE",
    "body": [
      ":  PULSE DO[${1:1}] FOR ${2:0.5}sec ;"
    ],
    "description": "Pulse a digital output"
  }
}
```

For a project-only file, add the Fanuc language scope:

```json
{
  "Project Initialization": {
    "scope": "fanuctp",
    "prefix": "PROJECT INIT",
    "body": [
      ":  UFRAME_NUM=${1:1} ;",
      ":  UTOOL_NUM=${2:1} ;"
    ],
    "description": "Project-specific initialization"
  }
}
```

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

## Publishing

Marketplace releases use Microsoft Entra workload identity federation through Azure Pipelines; no Personal Access Token is stored in the repository or pipeline. See [Secure Visual Studio Marketplace publishing](docs/secure-publishing.md) for setup and release instructions.
