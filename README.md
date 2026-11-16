# Robot File Sync Extension for Visual Studio Code

## Overview
This Visual Studio Code extension allows you to interact with a Fanuc robot via FTP for uploading and downloading files. It provides several commands to upload files, download files, and update existing files from the robot, and shows I/O and register descriptions from per-robot CSV files next to the matching code in the editor.

## Features

### Download Files:
- Download all files from the robot.
- Download `.ls` files from the robot.
- Update files from the robot into a selected folder.
- Show byte-level progress while large files are downloading.

### Upload Files:
- Upload individual files or folders to the robot.
- Before anything is sent, every LS file is checked with the LS verifier. **Critical** findings block the upload. If a file has errors, you choose **Send with Errors** or cancel; files with errors may fail to load on the robot. Warnings do not stop the upload.
- Show byte-level progress while large files are uploading.

### I/O and Register Descriptions:
- Show a description after `DI`, `DO`, `RI`, `RO`, `AI`, `AO`, `GI`, `GO`, `UI`, `UO`, `R`, `PR`, `SR`, and `F` references, e.g. `DO[1 Clamp closed]`.
- One CSV file per named robot, plus an optional shared file for all robots. **Tan** descriptions come from the robot's own file and **pink** descriptions come from the shared file (see [What the colors mean](#what-the-colors-mean)).
- Descriptions reload automatically when the CSV files are saved.

### Git Commits:
- After a download or upload, enter a commit message and the transferred files are committed. See [Git integration](#git-integration).

### File Insertion:
- Insert `.ls` file names into the current document by selecting from a list.

## Commands

### Verify an LS file

Right-click an LS file and select **MNAutomation → LS Checker → Verify LS File**. Results appear in the Problems panel with clickable line locations. The verifier checks the current editor contents, including unsaved changes. It does not modify the program. Run verification again after editing; old diagnostics are cleared when the document changes.

The initial rules check nonblank lines within `/MN`, stopping at the next section such as `/POS` or `/END`. Each line must contain a colon and end with a semicolon. All text before the first colon is ignored, so `123: CALL MAIN ;` is valid. Trailing whitespace is ignored. A missing `/MN` section is reported separately.

Long `--eg:` remarks exported from the robot wrap at about 80 characters. Each continuation line starts with a bare `:` and has no `;`; only the last line ends with `;`. The verifier accepts this format. Every `--eg:` line still needs its own leading instruction `:` (for example `12:  --eg: text`); the colon inside `--eg:` does not count. It reports a missing `;` only when a wrapped remark never reaches its closing line. Remark text is not checked as code, so references like `P[1]` or `LBL[9]` inside a remark are ignored. Passing these checks is not a full FANUC syntax validation.

Choose **MNAutomation → LS Checker → Edit LS Verifier Rules** to open your `ls-verifier-rules.json`. It is created on first use in the extension's user storage and shared across workspaces in the current VS Code profile. Rules are read on each verification, including unsaved edits; save the file to persist changes. Invalid rule files report an error instead of silently using defaults.

The JSON contains `version: 4` and a `rules` array. Each rule has a unique `id`, an `enabled` boolean, a `check`, a `message`, and an optional `severity` (`critical`, `error` or `warning`, see [Severity levels](#severity-levels)). Literal `startsWith` / `endsWith` checks also require `section: "MN"` and a literal `value`. The template is in `src/lsVerifierRules.json`. Older files (version 1 to 3) are upgraded once, the next time the rules are used: your rules, messages, severities and disabled settings are preserved, and missing checks are added. Version 3 adds `jumpTargets`, which was part of `labels` before; it starts with the same `enabled` and `severity` as your `labels` rule. Version 4 adds `extraColon`. Save pending rules edits before upgrading.

### Severity levels

Each rule has a `severity` that decides what happens when it finds something:

| Severity | Problems panel | When sending to the robot |
|---|---|---|
| `critical` | Error, message starts with **Critical:** | **Blocked.** Nothing is sent until it is fixed. No way to send anyway. |
| `error` | Error | Asks: **Send with Errors** or cancel |
| `warning` | Warning | Sent; a short message mentions the warnings |

Use `critical` for problems that make the robot reject the file. By default `extraColon` and `delimiters` are critical. Change any rule's level in **Edit LS Verifier Rules**. A rules file that already exists keeps its own settings when the defaults change; see [When the defaults change](#when-the-defaults-change).

### When the defaults change

Your rules file is yours: installing a new version never overwrites it. New checks are added to it automatically. When a new version changes the **default** of an existing check (for example `extraColon` from `error` to `critical`), the next verification or upload shows a list:

> **New LS verifier defaults**
> ☑ extraColon: severity error → critical
> ☑ delimiters: severity error → critical

Only rules that still have the old default are listed; a rule you changed yourself is never touched. Uncheck any change to keep your current setting, then press **Enter**. Press **Esc** to keep everything as it is. You are asked once per update.

### Reset the rules to the defaults

**MNAutomation → LS Checker → Reset LS Verifier Rules to Defaults** replaces your rules file with the built-in defaults. It asks first, and saves your current file as a backup (`ls-verifier-rules.backup-<date>.json` in the same folder) so your changes can be restored. **Open Backup** in the message that follows shows it.

The LS checker commands are in the **MNAutomation → LS Checker** submenu: **Verify LS File** (on LS files), **Edit LS Verifier Rules**, and **Reset LS Verifier Rules to Defaults**.

Additional configurable checks:

| Check | What it checks | Default severity |
| --- | --- | --- |
| `sections` | Required `/PROG`, `/ATTR`, `/APPL`, `/MN`, `/END` sections and order; repeated `/APPL` headers are allowed between `/ATTR` and `/MN`. Also checks other required-section duplicates, optional `/POS` placement, and content after `/END`. | Error |
| `programName` | FANUC program name validity and case-insensitive match with the LS filename | Error |
| `delimiters` | Unclosed or mismatched brackets, parentheses, and quotes in MN instructions; ignores comments and bracket descriptions | **Critical** |
| `extraColon` | A second `:` right after the line number, e.g. `1: :!text ;` (see [Common LS errors](#common-ls-errors)) | **Critical** |
| `labels` | Duplicate literal `LBL[n]` definitions | Error |
| `jumpTargets` | Literal `JMP LBL[n]` without a matching `LBL[n]` in the program (see [Common LS errors](#common-ls-errors)) | Error |
| `positions` | Literal `P[n]` references without matching definitions in `/POS` | Error |
| `motion` | Missing/unrecognized position, speed, or termination fields on J/L/C/A motion instructions | Warning |
| `calls` | Literal CALL/RUN targets without a matching local LS, TP, or PC filename | Warning |

Local calls are searched in the selected file's workspace folder, or its containing directory when outside a workspace. Indirect register-based calls, jumps, and positions cannot be resolved statically; `PR[n]` is not required in `/POS`. Motion checks recognize common numeric/register speeds and FINE/CNT/CR termination, including continuation lines for circular moves. Controller-specific forms may need review. The semicolon rule accepts a line without `;` when the next line continues the instruction (starts with `:` and has no line number), as in two-line circular moves. Line numbers are never validated. These checks do not replace the controller's loader/compiler.

Motion syntax reference: [FANUC R-30iB basic operator's manual](https://robochallenge.pl/wp-content/uploads/2021/10/R-30iB_Plus_basic_operator_manual_B-83284EN_09_Robo_Challenge.pdf).

### Common LS errors

Errors the verifier often finds in real programs, what they mean, and what to do.

#### `LS jump targets: JMP LBL[n] has no matching label.`

```
   9:  IF R[13:Part in Grip]=1 AND R[15:Part in Regrip2]=0,JMP LBL[40] ;
  10:  JMP LBL[404] ;
```

The program jumps to a label that is not defined anywhere in the program. The robot **loads** the file, but if that line runs, the program stops with a "label not found" alarm. Programmers sometimes use this on purpose as a crude "should never get here" stop; more often a `LBL[404:...]` error handler is missing.

What to do:
- Add the missing label, for example `LBL[404:Unknown state] ;` with a fault message or `ABORT` after it, or
- if the jump is intentional, change how the verifier reports it (below).

**Changing the severity of this check:**

1. Right-click any LS file and choose **MNAutomation → LS Checker → Edit LS Verifier Rules**.
2. Find the `jumpTargets` rule:
   ```json
   {
     "id": "jumpTargets",
     "enabled": true,
     "check": "jumpTargets",
     "severity": "error",
     "message": "LS jump targets:"
   }
   ```
3. Change `"severity"` to `"warning"`: it still shows in the Problems panel, but no longer stops an upload with the **Send with Errors** question. Set it to `"critical"` to never allow sending a file with this problem. Or set `"enabled": false` to turn the check off.
4. Save the file. The next verification or upload uses the new setting.

#### `LS extra colon: Only one ":" may follow the line number.`

```
   1: :!------------------------ ;
```

The line has two colons after the line number. The robot **rejects the file** on upload, so this check is **critical** by default: the file cannot be sent until it is fixed. The usual cause is inserting a snippet on a line that already has a line number: snippet lines start with `:`, so `1: ` plus `:!---` becomes `1: :!---`.

What to do: remove the extra `:` so the line reads `1: !------------------------ ;`. To avoid it, insert snippets on an empty line (see [Using a snippet](#using-a-snippet)).

Lines that start with `:` and have no line number, such as `   :  !-----MAIN PROGRAM----- ;` or the second line of a circular move, are fine.

Every check in the rules file works the same way: `"severity"` is `"critical"`, `"error"` or `"warning"` (see [Severity levels](#severity-levels)), and `"enabled"` turns it on or off.

### Check before upload

**Send This LS File** and **Send Folder** run the LS verifier on every LS file before connecting to the robot (the saved file, which is what gets sent).

- **Critical errors found:** the upload is **blocked**. A dialog lists the files and says nothing was sent. Choose **Show Problems** to see them. This applies to the whole upload: with **Send Folder**, one file with a critical error stops every file from being sent.
- **No errors:** the upload starts. If there were only warnings, a short message says so.
- **Errors found:** a dialog lists the files with errors and warns that **files with errors may fail to load on the robot**. Choose:
  - **Send with Errors**: upload everything anyway.
  - **Show Problems**: cancel and open the Problems panel to fix them.
  - **Cancel**: do nothing.
- The issues stay in the Problems panel either way.

The check uses the same rules as **Verify LS File** (edit them with **Edit LS Verifier Rules**). If no rules are enabled, the check is skipped.

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

6. **`extension.editDescriptions`** (MNAutomation → Descriptions → **Edit Descriptions**)
   - Opens the descriptions file for the robot of the selected folder, the shared file, or another robot's file. Creates the file with a `Key,Description` header if it does not exist.

7. **`extension.getDescriptionsFromRobot`** (MNAutomation → Descriptions → **Get Descriptions from Robot**)
   - Connects to the robot, downloads only its I/O and register comment files, and saves the comments to a descriptions file. See [Create descriptions from the robot](#create-descriptions-from-the-robot).

   **`extension.createDescriptionsFromBackup`** (MNAutomation → Descriptions → **Create Descriptions from Backup**)
   - Does the same from a backup folder you already downloaded.

8. **`extension.listLsFilesAndInsert`**
   - Lists `.ls` files in the current directory and allows the user to insert the file name into the active editor.

## I/O and Register Descriptions

Descriptions are stored in the project's `.vscode/descriptions` folder:

```
.vscode/
  robot-ftp.json        robot list (names, IPs, folders)
  descriptions/
    shared.csv          descriptions for every robot (optional)
    ST02.csv            descriptions for robot ST02
    St04.csv            descriptions for robot St04
```

When an LS file is open, the extension finds its robot the same way the IP picker does: the named robot whose `folder` contains the file (see [Robots and IP addresses](#robots-and-ip-addresses)). It then loads `shared.csv` first and that robot's file on top, so a robot's own description replaces the shared one for the same key. Files that are not inside any robot folder only use `shared.csv`.

### What the colors mean

> **PINK = shared description** (from `.vscode/descriptions/shared.csv`)
>
> **TAN = this robot's own description** (from `.vscode/descriptions/<robot name>.csv`)

![Description colors: tan for robot descriptions, pink for shared descriptions](docs/images/description-colors.png)

In this example the open LS file belongs to robot `RG`:

| Line | Description | Color | Comes from |
|---|---|---|---|
| `DO[18 Gripper Close]=OFF` | Gripper Close | **Pink** | `shared.csv` (every robot) |
| `DO[17 Gripper Open]=ON` | Gripper Open | **Tan** | `RG.csv` (only this robot) |

- If both files have the same key, the robot's file wins and the description shows in **tan**.
- Not sure where a description comes from? **Hover over it.** The tooltip names the file.
- These are the default colors with VS Code's standard dark theme. Tan is your theme's normal inlay hint color, so it can look different in other themes. Pink is set by this extension (a darker magenta in light themes).

To change the colors, add them to your VS Code settings:

```json
"workbench.colorCustomizations": {
  "robotFtp.robotDescriptionForeground": "#4EC9B0",
  "robotFtp.sharedDescriptionForeground": "#C586C0"
}
```

A robot's file is named after the robot (`<name>.csv`). To use a different file, add `"descriptions": "path/to/file.csv"` (relative to the workspace folder) to that robot in `.vscode/robot-ftp.json`.

Run **MNAutomation → Descriptions → Edit Descriptions** to open or create the right file. Old `descriptions.csv` files next to LS files are no longer read; copy their rows into `.vscode/descriptions/<robot>.csv` or `shared.csv`.

### Create descriptions from the robot

The robot already has comments for its I/O and registers. Copy them into a descriptions file instead of typing them. All description commands are in the **MNAutomation → Descriptions** menu:

| Command | Use it when |
|---|---|
| **Get Descriptions from Robot** | You can connect to the robot. Downloads only the five comment files, nothing else. |
| **Create Descriptions from Backup** | You already have a backup folder (for example from **Get ALL Files from Robot**). Right-click that folder. |
| **Edit Descriptions** | You want to open a descriptions file and edit it by hand. |

**Get Descriptions from Robot:**

1. Right-click the robot's folder (for example `Robots/ST02`) and run **MNAutomation → Descriptions → Get Descriptions from Robot**.
2. Pick the robot in the IP picker. The robot that owns the folder is listed first.
3. Pick the file to save to. Again, the robot that owns the folder is listed first; you can also pick another robot or `shared.csv`.
4. If the file already has descriptions, choose:
   - **Merge**: the robot's comments replace matching keys; rows you added that are not on the robot stay.
   - **Replace**: the file holds only the robot's comments.

The downloaded files are deleted when it is done. The descriptions file opens, and the descriptions appear in your LS files right away.

**Automatic prompt after a download:** after **Get ALL Files from Robot** or **Get All LS Files from Robot**, the extension checks whether that robot has a descriptions file. The robot is the one whose folder holds the download, or the named robot with the IP you picked. If its file is missing or has no rows, you are asked:

- **Create**: saves the robot's comments to `.vscode/descriptions/<robot>.csv` right away, with no second IP prompt. After an LS-only download, the five comment files are fetched in the same connection and deleted afterwards.
- **Not now**: asks again after the next download.
- **Don't ask again for \<robot\>**: stops asking for that robot in this workspace. You can still use **Get Descriptions from Robot** at any time.

Downloads from an IP that is not a named robot are not checked, because descriptions belong to a named robot.

**Create Descriptions from Backup** works the same way, starting from step 3: right-click a backup folder such as `2026-11-16-ALL_01` and run **MNAutomation → Descriptions → Create Descriptions from Backup**.

| File on the robot / in the backup | Descriptions read |
|---|---|
| `ioconfig.dg` | `DI`, `DO`, `GI`, `GO`, `UI`, `UO`, `AI`, `AO` |
| `iostate.dg` | Adds `RI`, `RO`, and flags (`F`), plus any I/O missing from `ioconfig.dg` |
| `numreg.va` | `R` |
| `posreg.va` | `PR` (group 1) |
| `strreg.va` | `SR` |

Only items with a comment are added. Comments that are only spaces are skipped. If some of these files are missing from the folder, the command uses the ones it finds.

### CSV format

Two columns, with a `Key,Description` header row:

```csv
Key,Description
DO[1],Clamp closed
DI[1],Part present
R[10],Part count
PR[3],"Pounce, above fixture"
```

- **Key**: one of `DI`, `DO`, `RI`, `RO`, `AI`, `AO`, `GI`, `GO`, `UI`, `UO`, `R`, `PR`, `SR`, `F`, followed by `[number]`. Upper or lower case both work.
- **Description**: the text to show. Put it in double quotes if it contains a comma.

Descriptions are not shown inside `!` remarks, or on references that already carry a robot comment such as `DO[1:Clamp]`.

## Git integration

Keep a history of every trip to the robot. After a robot transfer finishes **without errors**, the extension asks for a commit message and commits **only the files from that transfer**:

| Command | What gets committed |
|---|---|
| Get ALL Files / Get All LS Files | The downloaded files (plus the robot's descriptions file if you just created it) |
| Get Update LS Folder / Get Update For This LS File | The updated files that changed |
| Send This LS File / Send Folder | Uploaded files that had uncommitted edits. If they were already committed, nothing is recorded. |

1. A message box opens with a suggested message, for example `Download LS files ST02 (192.168.1.12) 2026-11-16 09:05`. Edit it if you like.
2. Press **Enter** to commit, or **Esc** to skip. Nothing is staged if you skip.

Details:

- It commits to the **current branch** of the repository that holds the files. Other changes in the repository are left alone. If other files were already staged, you choose **Commit anyway** or **Only robot files**.
- If the files are not in a git repository, it offers to create one, in the workspace folder or in the download folder. The new repository gets a `.gitignore` with the patterns from `robotFtp.git.ignorePatterns`, and it is included in the first commit. If the folder already had other files (earlier downloads, `.vscode` settings and descriptions), you choose whether the first commit includes **all files** or **only this transfer**. After that, each commit includes only that transfer's files.
- If the robot files match the last commit, it says so and does not commit.
- It uses VS Code's built-in Git, with your git name, email and credentials. Commits show up in the Source Control view right away.

### Settings

| Setting | Default | Options |
|---|---|---|
| `robotFtp.git.onDownload` | `prompt` | `off` to never commit after downloads and updates |
| `robotFtp.git.onUpload` | `prompt` | `off` to never commit after uploads |
| `robotFtp.git.commitMode` | `auto` | `confirm`: after the message, ask **Commit** or **Open Source Control** first |
| `robotFtp.git.messageTemplate` | `${operation} ${robot} ${date}` | Variables: `${operation}`, `${robot}` (name and IP), `${name}`, `${ip}`, `${date}`, `${count}`, `${folder}` |
| `robotFtp.git.push` | `never` | `ask` or `always` push after committing. Repositories without a remote are never pushed. |
| `robotFtp.git.offerInit` | `true` | `false` to never offer to create a repository |
| `robotFtp.git.ignorePatterns` | `*.Sem`, `*.Wrk` | Patterns written to `.gitignore` when the extension creates a repository. Add your own in Settings (search for *ignorePatterns*, then **Add Item**). |
| `robotFtp.downloadLayout` | `dated` | `fixed`: see below |

All settings can be set per workspace, so one customer project can turn commits off without affecting others.

### Without Git, or in SVN folders

Only the commit prompts need Git. Downloads, uploads, the LS checker, descriptions and snippets work the same without it.

- **Git not installed, or VS Code's Git turned off (`git.enabled`):** transfers work normally and are not committed. The first transfer in each VS Code session shows a warning with a link to [install Git](https://git-scm.com/install). Choose **OK** to be reminded next session, or **Don't Remind Me** to stop the warning. Once Git is installed, commits start working without changing any setting.
- **SVN working copies** (a `.svn` folder in the transfer folder or above it): the extension never offers to create a git repository there. If the folder is also inside a git repository, that repository is still used.
- To stop all commit prompts in a workspace, set `robotFtp.git.onDownload` and `robotFtp.git.onUpload` to `off`.

**Turning reminders back on:** **MNAutomation → Reset Robot FTP Reminders** turns back on every "Don't Remind Me" / "Don't ask again" choice: the Git warning, and the question to create descriptions for a robot (in the current workspace).

### Files git should ignore

When the extension creates a repository, it writes `.gitignore` in the repository folder with the patterns from `robotFtp.git.ignorePatterns`. The defaults are `*.Sem` and `*.Wrk` (PLC work files). If a `.gitignore` is already there, only patterns that are missing are added.

To change the list, open Settings, search for **ignorePatterns**, and use **Add Item**, or edit `settings.json`:

```json
"robotFtp.git.ignorePatterns": ["*.Sem", "*.Wrk", "*.bak", "Backup/"]
```

Patterns use the normal [.gitignore syntax](https://git-scm.com/docs/gitignore). Changing the setting does not edit `.gitignore` files in repositories that already exist; edit those files directly.

### Dated or fixed download folders

By default each download goes into a new dated folder such as `2026-11-16-ALL_01`. In git, every backup then shows up as hundreds of **new** files, which makes it hard to see what changed on the robot.

Set `robotFtp.downloadLayout` to `fixed` to download into one folder instead: `ALL` or `LS` inside the folder you choose (for example `ST02/LS`). Each download overwrites it, so git shows exactly which programs changed since the last visit, and git keeps the dated history. Files that were deleted on the robot are not deleted locally.

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

### Robots and IP addresses

Every robot command asks which robot to use. The list comes from `.vscode/robot-ftp.json` in the workspace folder, so it is shared by every folder in the project:

```json
{
  "robots": [
    { "name": "ST02", "ip": "192.168.1.12", "folder": "Robots/ST02", "port": null },
    { "name": "St04", "ip": "192.168.1.14", "folder": "Robots/St04", "port": 21 },
    { "name": "RoboGuide", "ip": "127.0.0.2", "folder": null, "port": 9125 }
  ],
  "recent": ["192.168.1.14", "192.168.1.12"]
}
```

- **`robots`**: named robots for the job. They are never removed automatically.
  - `folder` (optional, relative to the workspace folder): when a command runs anywhere inside this folder, this robot is listed first and marked *this folder*. If several folders match, the deepest one wins.
  - `port` (optional): the FTP port for this robot. Leave it out or set it to `null` to use the `robotFtp.port` setting.
- **`recent`**: the last five IPs used in the project, newest first.

The picker lists, in order: the robot for the current folder, recent IPs (with the robot name when known), the other named robots, the built-in IPs (192.168.10.124, RoboGuide 127.0.0.2), and **Other**. Choosing **Other** lets you type an IP and then save it as a named robot, choosing its folder and port.

Use **MNAutomation → Edit Robot List** to open the file and rename robots, change IPs, or set folders and ports. Commit the file to the job's repository to share the robot list with your team.

The file is only written when you use an IP or save a robot. Outside an open workspace folder, recent IPs are kept in VS Code's own storage and named robots are not available. Old `ip.txt` and `recent-ips.json` files are no longer used and can be deleted.

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

### Descriptions:
See [I/O and Register Descriptions](#io-and-register-descriptions).

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
    "prefix": "projinit",
    "body": [
      ":  UFRAME_NUM=${1:1} ;",
      ":  UTOOL_NUM=${2:1} ;"
    ],
    "description": "Project-specific initialization"
  }
}
```

### Using a snippet

1. On an empty line, type the trigger, for example `frames`. Don't type the leading `:`; the snippet adds it.
2. Pick the snippet from the suggestion list (it has a snippet icon) and press **Tab** or **Enter**. Press **Ctrl+Space** if the list does not open.
3. Press **Tab** to move between the fields in the snippet.

> **Tip: press Ctrl+Space to show the snippets.** If the suggestion list does not appear while you type, press **Ctrl+Space** to open it (also **Ctrl+Space** on Mac). This is most useful for triggers that contain a space, such as `set frames`: the list closes when you type the space and only comes back once the whole trigger is typed. Pressing **Ctrl+Space** brings it back at any point.
>
> **Use one-word triggers when you can.** The one-word triggers below (`frames`, `todo`, `LBL`, `JMP`, `eg`) show up as soon as you start typing. The same advice applies to snippets you add in your own files.
>
> **Grey italic text is not a snippet.** Text that appears in grey italics as you type comes from an AI inline-suggestion tool such as GitHub Copilot, not from this extension. Press **Esc** to dismiss it.

### Built-in snippets

1. **Set Frames**  
   - **Trigger**: `frames` or `setframes`  
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
   - **Trigger**: `eg`  
   - **Description**: Multi Line Text

8. **To DO**  
   - **Trigger**: `todo`  
   - **Description**: Must Return to Complete

9. **Label**  
   - **Trigger**: `LBL`  
   - **Description**: Add label

10. **Jump Label**  
    - **Trigger**: `JMP` or `jmplbl`  
    - **Description**: Add Jump label

11. **Jump Label With Label**  
    - **Trigger**: `JMP` or `jmplbl`  
    - **Description**: Add Jump label

12. **Wait Sec**  
    - **Trigger**: `WAIT`  
    - **Description**: Wait for a number of seconds

13. **CALL**  
    - **Trigger**: `CALL`  
    - **Description**: Call Program

## Acknowledgments

This extension's syntax highlighting is based on the work from [TPSyntaxHighlighter](https://github.com/alek5k/TPSyntaxHighlighter). We appreciate the contributions made by the original author. 

## Publishing

Marketplace releases use Microsoft Entra workload identity federation through Azure Pipelines; no Personal Access Token is stored in the repository or pipeline. See [Secure Visual Studio Marketplace publishing](docs/secure-publishing.md) for setup and release instructions.
