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
    getSharedDescriptionsPath,
    getRobotDescriptionsPath,
    ensureDescriptionsFile
};
