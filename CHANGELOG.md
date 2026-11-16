# Change Log

All notable changes to the "robot-ftp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.8.6-dev] - 2026-11-16

- Add **Get Descriptions from Robot**: connects to the robot, downloads only the five comment files, and saves the comments to a descriptions file.
- Add **Create Descriptions from Backup**: reads the I/O and register comments from a robot backup folder (`ioconfig.dg`, `iostate.dg`, `numreg.va`, `posreg.va`, `strreg.va`) and saves them to a robot's descriptions file or `shared.csv`. If the file already has descriptions, choose **Merge** (keep your other rows) or **Replace**.
- Move the description commands into a **MNAutomation → Descriptions** submenu.

## [0.8.5-dev] - 2026-11-16

- Fix: descriptions were missing after a NOT operator, e.g. `IF (!DO[17]) THEN`. Only lines whose statement starts with `!` are treated as remarks.

## [0.8.4-dev] - 2026-11-16

- Move I/O and register descriptions to `.vscode/descriptions`: one CSV per named robot (`<name>.csv`), plus an optional `shared.csv` for all robots. The robot is found from the open LS file's folder, like the IP picker. A robot can point to another file with `"descriptions"` in `robot-ftp.json`.
- Shared descriptions are shown in their own color. Both colors can be changed (`robotFtp.robotDescriptionForeground`, `robotFtp.sharedDescriptionForeground`), and hovering shows the source file.
- Add descriptions for `RI`, `RO`, `AI`, `AO`, `GI`, `GO`, `UI`, `UO`, `PR`, and `SR` (in addition to `DI`, `DO`, `R`, `F`).
- Descriptions update when you switch files or save a CSV, instead of loading once at startup.
- Add **Edit Descriptions** to the MNAutomation menu. Remove **Select CSV File For Hints**. Old `descriptions.csv` files are ignored and no blank CSV files are created next to LS files.
- Fix: **List ls Programs** (Ctrl+Shift+L) was not registered when no file was open at startup.

## [0.8.3-dev] - 2026-11-16

- Add named robots to `.vscode/robot-ftp.json`. Each robot has a name and IP, and optionally a folder and an FTP port. Named robots stay in the list permanently, unlike the last-five recent IPs.
- The robot whose folder contains the current file or folder is listed first in the picker.
- A robot's own `port` is used when set; when it is missing or `null`, the `robotFtp.port` setting is used.
- After entering a custom IP, you can save it as a named robot with a folder and port.
- Add **Edit Robot List** to the MNAutomation menu.

## [0.8.2-dev] - 2026-11-16

- Recent robot IPs are now shared across the whole project in `.vscode/robot-ftp.json`, so every command (including sending an LS file from a new or dated download folder) shows them. Outside a workspace folder they are kept in VS Code storage. Per-folder `recent-ips.json` files are no longer read or created.

## [0.8.1-dev] - 2026-11-16

- Remove `ip.txt` support. The robot IP is always chosen from the picker, which lists recent IPs from `recent-ips.json`. Existing `ip.txt` files are ignored.

## [0.8.0-dev] - 2026-11-16

- Add "Robot FTP Settings" to the MNAutomation context menu to open this extension's settings.

## [0.7.1-dev] - 2026-11-08

- Accept robot-wrapped multi-line `--eg:` remarks (bare `:` continuation lines, `;` only on the last line) and skip code checks inside remark text.

- Require /APPL between /ATTR and /MN while accepting repeated /APPL headers produced by robot round trips.

- Add configurable LS checks for section structure, program names, delimiters, labels/jumps, position references, motion fields, and local program calls. Preserve existing rules when upgrading; omit line-number checks.

## [0.7.0-dev] - 2026-11-05

- Add LS verification with editable JSON rules and Problems-panel diagnostics for missing colons and final semicolons in the /MN section.

## [0.6.0-dev] - 2026-11-05

- Prompt for and validate a 16-character FANUC program comment after rename validation, updating the LS COMMENT attribute.

- Add Rename LS File to the Explorer context menu, validating FANUC program names up to 36 characters and updating the /PROG header.

## [0.6.0] - 2026-11-05

- Log the descriptions-loaded message only once per extension activation.

## Previous releases

- Initial release
- 0.3.0 Added ip.txt file check to get a default IP if the FIle exsists and if not will prompt user if we should create one. 
- 0.3.4 Adds Get Update for This LS file
- 0.4.3 Adds FTP connection settings, connection timeout handling, and byte-level transfer progress for large uploads/downloads.
- 0.4.4 Adds recent robot IP history with `recent-ips.json` and the last five valid addresses shown in the IP picker.
- 0.5.0 Adds three-level snippet loading: built-in defaults, persistent user/global snippets, and native project-only `.vscode` snippets. Additional external Fanuc snippet files can also be loaded and automatically reloaded.
