const fs = require('fs');
const path = require('path');

const DESCRIPTIONS_DIR = path.join('.vscode', 'descriptions');
const SHARED_FILE = 'shared.csv';
const CSV_HEADER = 'Key,Description\n';

/** Register and I/O types that get description hints. R must come after PR and SR so the longer names win. */
const DESCRIPTION_TYPES = ['DI', 'DO', 'RI', 'RO', 'AI', 'AO', 'GI', 'GO', 'UI', 'UO', 'PR', 'SR', 'R', 'F'];
const TYPE_PATTERN = DESCRIPTION_TYPES.join('|');
const KEY_PATTERN = new RegExp(`^\\s*(${TYPE_PATTERN})\\s*\\[\\s*(\\d+)\\s*\\]\\s*$`, 'i');

function normalizeKey(key) {
    const match = KEY_PATTERN.exec(String(key || ''));
    return match ? `${match[1].toUpperCase()}[${Number(match[2])}]` : undefined;
}

/** Minimal CSV parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const source = text.replace(/^﻿/, '');

    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (inQuotes) {
            if (ch === '"' && source[i + 1] === '"') {
                field += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && source[i + 1] === '\n') {
                i++;
            }
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += ch;
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
}

/**
 * Parses a Key,Description CSV. Returns { descriptions: Map<key, text>, problems: string[] }.
 * Keys are normalized to upper case, e.g. "do[ 1 ]" → "DO[1]". A later row wins over an earlier one.
 */
function parseDescriptionsCsv(text) {
    const descriptions = new Map();
    const problems = [];
    const rows = parseCsvRows(text);
    if (rows.length === 0) {
        return { descriptions, problems };
    }

    const header = rows[0].map(cell => cell.trim().toLowerCase());
    const keyColumn = header.indexOf('key');
    const descriptionColumn = header.indexOf('description');
    if (keyColumn < 0 || descriptionColumn < 0) {
        problems.push('The first row must be the header "Key,Description".');
        return { descriptions, problems };
    }

    rows.slice(1).forEach((cells, index) => {
        const rawKey = (cells[keyColumn] || '').trim();
        const text = (cells[descriptionColumn] || '').trim();
        const key = normalizeKey(rawKey);
        if (!key) {
            problems.push(`Row ${index + 2}: "${rawKey}" is not a supported key (${DESCRIPTION_TYPES.join(', ')} followed by [number]).`);
            return;
        }
        if (text) {
            descriptions.set(key, text);
        }
    });
    return { descriptions, problems };
}

/** Shared descriptions first, then robot descriptions override the same keys. */
function mergeDescriptions(shared, robot) {
    const merged = new Map();
    for (const [key, text] of shared || []) {
        merged.set(key, { text, source: 'shared' });
    }
    for (const [key, text] of robot || []) {
        merged.set(key, { text, source: 'robot' });
    }
    return merged;
}

/** A remark line: the statement starts with "!", e.g. "  1:  !Open gripper ;". A "!" elsewhere is the NOT operator. */
const REMARK_LINE = /^\s*(\d+\s*:\s*)?!/;

/**
 * Finds description keys in one line of an LS file. Remark lines are skipped.
 * Returns [{ key, start, end }], where end is the index of the closing bracket.
 * Keys that already carry a robot comment (DO[1:Clamp]) are skipped.
 */
function findDescriptionKeys(lineText) {
    const results = [];
    if (REMARK_LINE.test(lineText)) {
        return results;
    }
    const pattern = new RegExp(`\\b(${TYPE_PATTERN})\\[(\\d+)\\]`, 'gi');
    let match;
    while ((match = pattern.exec(lineText)) !== null) {
        results.push({
            key: `${match[1].toUpperCase()}[${Number(match[2])}]`,
            start: match.index,
            end: match.index + match[0].length - 1
        });
    }
    return results;
}

/** I/O keys carry a state before the comment in LS files: DO[17: * :Gripper Open], DO[1:ON :Clamp], DO[2:OFF:Clamp]. */
const IO_STATE = /^\s*(?:ON|OFF|\*)\s*:(.*)$/i;
const IO_STATE_ONLY = /^\s*(?:ON|OFF|\*)\s*$/i;
const IO_TYPES = new Set(['DI', 'DO', 'RI', 'RO', 'AI', 'AO', 'GI', 'GO', 'UI', 'UO', 'F']);

/**
 * Finds inline comments in one line of an LS file: R[10:Pick Number], DO[17: * :Gripper Open], GI[1:Part ID].
 * Remark lines are skipped. Returns [{ key, text, start, end }], where start..end (exclusive) covers "DO[...]".
 * Keys with an empty comment are skipped.
 */
function findInlineComments(lineText) {
    const results = [];
    if (REMARK_LINE.test(lineText)) {
        return results;
    }
    const pattern = new RegExp(`\\b(${TYPE_PATTERN})\\[(\\d+):([^\\]]*)\\]`, 'gi');
    let match;
    while ((match = pattern.exec(lineText)) !== null) {
        const type = match[1].toUpperCase();
        let content = match[3];
        if (IO_TYPES.has(type)) {
            const state = IO_STATE.exec(content);
            if (state) {
                content = state[1];
            } else if (IO_STATE_ONLY.test(content)) {
                content = ''; // GI[1: * ]: a state and no comment
            }
        }
        const text = content.trim();
        if (text) {
            results.push({
                key: `${type}[${Number(match[2])}]`,
                text,
                start: match.index,
                end: match.index + match[0].length
            });
        }
    }
    return results;
}

/**
 * Shortest comment that can be a robot cut-off. Robots cut long comments short in LS files, e.g. PR[79:S201 PIC Y OFF]
 * for "S201 PIC Y OFFST" (cut-offs seen in real files are 14 characters). Shorter comments must match exactly,
 * so an edit such as DO[15:newer] → DO[15:new] is still caught.
 */
const MIN_CUT_OFF_LENGTH = 12;

/** True when an inline comment agrees with a description: the same text, or a long comment the robot cut short. */
function inlineCommentMatches(comment, description) {
    if (typeof description !== 'string') {
        return false;
    }
    return description === comment || (comment.length >= MIN_CUT_OFF_LENGTH && description.startsWith(comment));
}

function csvField(value) {
    return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Sets one description in CSV text and returns the new text. Replaces that key's first row (later duplicate
 * rows for the key are removed so the new text wins) or appends a row. Other rows, their order and the
 * line endings stay as they are. Empty or missing text gets the header first.
 */
function setDescriptionInCsv(csvText, key, text) {
    const source = (csvText || '').replace(/^﻿/, '');
    const newline = /\r\n/.test(source) ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
    }
    if (lines.length === 0) {
        lines.push('Key,Description');
    }

    const header = (parseCsvRows(lines[0])[0] || []).map(cell => cell.trim().toLowerCase());
    const keyColumn = header.indexOf('key');
    const descriptionColumn = header.indexOf('description');
    if (keyColumn < 0 || descriptionColumn < 0) {
        throw new Error('The first row must be the header "Key,Description".');
    }
    const makeRow = keyText => {
        const cells = new Array(header.length).fill('');
        cells[keyColumn] = keyText;
        cells[descriptionColumn] = csvField(text);
        return cells.join(',');
    };

    let replaced = false;
    const output = [lines[0]];
    for (const line of lines.slice(1)) {
        // Continuation lines of a quoted multi-line field never parse to a key, so they are kept as they are.
        const cells = parseCsvRows(line)[0] || [];
        if (normalizeKey(cells[keyColumn]) === key) {
            if (!replaced) {
                output.push(makeRow(cells[keyColumn].trim()));
                replaced = true;
            }
            continue;
        }
        output.push(line);
    }
    if (!replaced) {
        output.push(makeRow(key));
    }
    return output.join(newline) + newline;
}

function safeFileName(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

function getSharedDescriptionsPath(workspaceRoot) {
    return path.join(workspaceRoot, DESCRIPTIONS_DIR, SHARED_FILE);
}

/** A robot's descriptions file: its "descriptions" path when set, otherwise .vscode/descriptions/<name>.csv. */
function getRobotDescriptionsPath(workspaceRoot, robot) {
    if (robot.descriptions) {
        return path.resolve(workspaceRoot, robot.descriptions);
    }
    return path.join(workspaceRoot, DESCRIPTIONS_DIR, `${safeFileName(robot.name)}.csv`);
}

/** Creates the file with only the header row when it does not exist. Returns its path. */
function ensureDescriptionsFile(filePath) {
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, CSV_HEADER, 'utf8');
    }
    return filePath;
}

module.exports = {
    DESCRIPTION_TYPES,
    DESCRIPTIONS_DIR,
    normalizeKey,
    parseCsvRows,
    parseDescriptionsCsv,
    mergeDescriptions,
    findDescriptionKeys,
    findInlineComments,
    inlineCommentMatches,
    csvField,
    setDescriptionInCsv,
    getSharedDescriptionsPath,
    getRobotDescriptionsPath,
    ensureDescriptionsFile
};
