# Robot FTP Extension - Upgrade Roadmap & Ideas

This document outlines potential upgrades and enhancements for future versions of the Robot FTP extension.

## Version 0.4.0 Ideas (Next Major Release)

### Priority: HIGH - Core Improvements
- [ ] **Connection Retry Logic**: Implement exponential backoff for failed FTP connections
  - Current: Single attempt, fails immediately
  - Proposed: Retry 3 times with increasing delays
  - Benefit: More reliable in unstable network conditions
  
- [ ] **Transfer Progress Indication**: Show progress bar during file uploads/downloads
  - Current: No feedback during transfer
  - Proposed: VS Code progress indicator or status bar update
  - Benefit: Better UX, users know extension is working

- [ ] **Batch Operations Summary**: Create a report file after uploads/downloads
  - Current: Just success/error messages
  - Proposed: Log file with timestamps, file counts, sizes
  - Benefit: Audit trail, better debugging

- [ ] **File Conflict Handling**: Handle existing files gracefully
  - Current: Overwrites without asking
  - Proposed: Ask user (overwrite/skip/rename)
  - Benefit: Prevent accidental data loss

### Priority: MEDIUM - User Experience
- [ ] **Recent IPs History**: Remember last 5 robot IPs used
  - Current: Single IP from ip.txt or default
  - Proposed: Quick pick from recent IPs
  - Benefit: Faster switching between robots
  
- [ ] **Sidebar File Browser**: VS Code sidebar view showing robot files
  - Current: Manual file selection
  - Proposed: Tree view of robot file system
  - Benefit: Easier discovery and management
  
- [ ] **Drag-and-Drop Upload**: Upload files by dragging into editor
  - Current: Right-click context menu only
  - Proposed: Support drag operations
  - Benefit: More intuitive for casual users

- [ ] **CSV Validation Tool**: Check CSV format before loading
  - Current: Silent fail if malformed
  - Proposed: Validation with detailed errors
  - Benefit: Easier debugging of description files

### Priority: MEDIUM - Features
- [ ] **Multiple File Type Support**: Add .PRG, .JOB, .SRC files
  - Current: Primarily .LS files
  - Proposed: Configuration for supported types
  - Benefit: More complete robot file sync

- [ ] **Scheduled Sync**: Periodic auto-sync from robot
  - Current: Manual downloads only
  - Proposed: Background timer that syncs changes
  - Benefit: Keep local cache current

- [ ] **Diff Before Upload**: Show what will change before upload
  - Current: Uploads immediately
  - Proposed: Preview differences like git diff
  - Benefit: Prevent unintended overwrites

### Priority: LOW - Advanced Features
- [ ] **Connection Pool**: Reuse FTP connections for multiple operations
  - Current: New connection per operation
  - Proposed: Keep connection open for batch ops
  - Benefit: Performance improvement

- [ ] **Encryption for Credentials**: Secure password storage
  - Current: Hardcoded anonymous/anonymous
  - Proposed: VS Code secret storage API
  - Benefit: Support authenticated robots

- [ ] **Network Diagnostics**: Ping robot, test connection quality
  - Current: Try and fail if can't connect
  - Proposed: Diagnostic tool to troubleshoot
  - Benefit: Better support for connectivity issues

- [ ] **Syntax Highlighting Improvements**: Better TP language support
  - Current: Basic TextMate grammar
  - Proposed: Enhanced grammar with scoping
  - Benefit: Better color coding

## Version 0.5.0+ Ideas (Future)

- **VS Code Web Support**: Make extension compatible with VS Code Web
- **Multi-Robot Dashboard**: Manage multiple robots simultaneously
- **Version Control Integration**: Track robot file changes like git
- **Remote Debugging**: Debug TP programs with breakpoints
- **Package Manager**: Download/install program packages
- **Collaboration Features**: Share robot files with team

## Bug Fixes Backlog

- [ ] Path handling for files with spaces on Windows
- [ ] Long filename support for downloads
- [ ] Timeout handling for slow networks
- [ ] Binary file format validation
- [ ] IPv6 address support
- [ ] CSV encoding issues (UTF-8 vs ASCII)

## Documentation Improvements

- [ ] Video tutorial: "Getting Started with Robot FTP"
- [ ] Troubleshooting guide: Common connection issues
- [ ] Examples: Sample CSV descriptions
- [ ] FAQ: Common questions from users
- [ ] API Reference: For developers extending the extension

## Testing Improvements

- [ ] Unit tests for IP validation
- [ ] Integration tests with mock FTP server
- [ ] E2E tests with real robot (if available)
- [ ] Performance tests for large files
- [ ] Cross-platform testing on Mac/Linux

## Release Management

### Current Process
1. Make changes to code
2. Update CHANGELOG.md
3. Increment version in package.json
4. Run `vsce package` to create .vsix
5. Manual upload to marketplace

### Improvements to Consider
- [ ] Automate versioning from git tags
- [ ] Generate release notes from CHANGELOG
- [ ] Create GitHub Actions workflow
- [ ] Publish directly to VS Code Marketplace
- [ ] Create binary releases for different platforms

## How to Use This Document

1. **For Planning**: Use this as inspiration for next sprint
2. **For Decisions**: Prioritize based on user feedback
3. **For Issues**: Link GitHub issues to items here
4. **For Contributions**: Use as starter list for community PRs

## Feedback Channels

- GitHub Issues: Report bugs and feature requests
- Discussions: Ask questions and share ideas
- User Surveys: Gather requirements from actual users
- Usage Analytics: Track which features are most used

