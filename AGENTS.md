# Fanuc FTP Extension - Custom Agents

## Overview
These custom agents are designed to help with specific upgrade and maintenance tasks for the Robot FTP extension. Use these agent names when working on targeted improvements.

---

## Agent 1: FTP-FeatureDeveloper
**Purpose**: Add new FTP commands or improve existing file transfer logic  
**Best For**: Adding download variants, upload improvements, new file operations

**Focus Areas**:
- Enhance FTP operations in `src/extension.js`
- Add new commands in `package.json`
- Register new command handlers in `activate()`
- Handle edge cases (file conflicts, permissions, timeouts)

**Example Tasks**:
- "Add resumable uploads for large files"
- "Implement folder download filtering by date"
- "Add connection retry logic with exponential backoff"
- "Create batch upload with progress bar"

---

## Agent 2: DescriptionManager
**Purpose**: Improve CSV descriptions, inlay hints, and code completion features  
**Best For**: Enhancements to description loading, hint rendering, and related functionality

**Focus Areas**:
- `loadDescriptions()` - CSV parsing and validation
- `watchCSVFile()` - file monitoring and reloading
- Inlay hints provider in `activate()`
- CSV format improvements
- Hint rendering and positioning

**Example Tasks**:
- "Add support for multiple description formats (JSON, YAML)"
- "Implement fuzzy search in descriptions"
- "Add hover tooltips with full descriptions"
- "Create description validation and error reporting"

---

## Agent 3: IPManagement
**Purpose**: Handle robot IP address configuration and connectivity  
**Best For**: Improving IP detection, validation, storage, and connection management

**Focus Areas**:
- `getRobotIp()` - IP retrieval and validation
- IP persistence in `ip.txt` file
- Connection establishment and error handling
- IP validation regex and patterns

**Example Tasks**:
- "Add IP address history and recent connections"
- "Implement automatic IP discovery via network scan"
- "Add connection health check before operations"
- "Create IP settings UI panel"

---

## Agent 4: UIEnhancements
**Purpose**: Improve user experience and VS Code UI integration  
**Best For**: Adding new UI elements, improving command visibility, better status reporting

**Focus Areas**:
- Context menu commands in `package.json`
- Keybindings and shortcuts
- Output channel logging and formatting
- Error messages and user feedback
- Status bar indicators

**Example Tasks**:
- "Add progress indicator during file transfers"
- "Create custom sidebar view for robot file browser"
- "Add configuration panel for extension settings"
- "Implement file sync status monitoring"

---

## Agent 5: QualityAssurance
**Purpose**: Testing, bug fixes, error handling, and code quality  
**Best For**: Improving reliability, reducing errors, adding test coverage

**Focus Areas**:
- Error handling and edge cases
- Test file: `test/extension.test.js`
- Error messages and validation
- Path handling (spaces, special characters)
- Cross-platform compatibility

**Example Tasks**:
- "Add comprehensive error handling to FTP operations"
- "Create unit tests for IP validation"
- "Fix file path handling for Windows/Mac/Linux"
- "Add timeout handling for FTP operations"

---

## Agent 6: Documentation & Release
**Purpose**: Maintain documentation, version control, and release process  
**Best For**: Updating docs, managing versions, preparing releases

**Focus Areas**:
- `README.md` - user documentation
- `CHANGELOG.md` - version history
- `package.json` - version field
- Code comments and inline documentation
- Release workflow

**Example Tasks**:
- "Document new features in README"
- "Update changelog for release 0.4.0"
- "Add code comments explaining complex functions"
- "Create migration guide from 0.3.x to 0.4.0"

---

## Agent 7: SyntaxHighlighting
**Purpose**: Improve Fanuc TP language support, syntax highlighting, and snippets  
**Best For**: Enhancing language support and developer experience

**Focus Areas**:
- `syntaxes/fanuctp.tmLanguage.json` - TextMate grammar
- `snippets/snippets.code-snippets` - code snippets
- `language-configuration.json` - language settings
- Fanuc TP syntax and keywords

**Example Tasks**:
- "Add new keywords to syntax highlighting"
- "Create advanced snippets for common patterns"
- "Add debugging support hints"
- "Improve bracket matching and indentation"

---

## How to Use These Agents

### Example Usage in Chat:
```
@FTP-FeatureDeveloper
Add a new command to batch upload multiple .LS files with a summary report.
Should show progress and create a log file.
```

```
@DescriptionManager
Improve the CSV description loading to support JSON format as well,
with better error reporting if the file is malformed.
```

### When Choosing an Agent:
- **Multiple FTP operations?** → FTP-FeatureDeveloper
- **CSV/hints/descriptions?** → DescriptionManager
- **Robot connectivity/IP issues?** → IPManagement
- **UX/UI improvements?** → UIEnhancements
- **Bugs/errors/testing?** → QualityAssurance
- **Docs/versions?** → Documentation & Release
- **Language highlighting/snippets?** → SyntaxHighlighting

### General Work Without Specific Agent:
Use the default agent (Copilot) with the `.instructions.md` guidance for general tasks.

---

## Agent Capability Summary

| Agent | Modifies | Tests | References |
|-------|----------|-------|-----------|
| FTP-FeatureDeveloper | extension.js, package.json | FTP connections | basic-ftp |
| DescriptionManager | extension.js | CSV parsing | csv-parser |
| IPManagement | extension.js, ip.txt | IP validation | vscode.window |
| UIEnhancements | package.json, extension.js | Commands | TextMate theme |
| QualityAssurance | extension.js, test/ | All functions | Test framework |
| Documentation & Release | README.md, CHANGELOG.md | N/A | package.json |
| SyntaxHighlighting | syntaxes/, snippets/ | Grammar | TextMate syntax |

