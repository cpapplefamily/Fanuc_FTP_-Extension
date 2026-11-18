import { defineConfig } from '@vscode/test-cli';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Integration tests run in a fresh copy of test/fixtures/workspace, so tests can change its files.
const workspace = path.join(os.tmpdir(), 'robot-ftp-test-workspace');
fs.rmSync(workspace, { recursive: true, force: true });
fs.cpSync('test/fixtures/workspace', workspace, { recursive: true });

export default defineConfig({
	files: 'test/**/*.test.js',
	workspaceFolder: workspace,
	mocha: { ui: 'tdd', timeout: 20000 }
});
