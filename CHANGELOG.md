# Change Log

All notable changes to the "robot-ftp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
