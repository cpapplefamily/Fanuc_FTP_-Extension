const fs = require('fs');
const path = require('path');

/**
 * Builds description CSVs from a robot backup ("Get ALL Files from Robot").
 *
 *   ioconfig.dg  DIN[  17]  Gripper Open                        DI, DO, GI, GO, UI, UO, AI, AO
 *   iostate.dg   FLG[   1] OFF  Cross Present   FLG[ 513] OFF   adds RI, RO, F (two entries per line)
 *   numreg.va    [4] = 217  'Part Count'                        R
 *   posreg.va    [1,1] =   'Home'   Group: 1                    PR (group 1)
 *   strreg.va    [1] = text  'Comment'                          SR
 */
const BACKUP_FILES = ['ioconfig.dg', 'iostate.dg', 'numreg.va', 'posreg.va', 'strreg.va'];

/** Robot I/O names in .dg files → description key types. SI/SO and unknown names are skipped. */
const IO_TYPE_MAP = {
    DIN: 'DI', DOUT: 'DO', DI: 'DI', DO: 'DO',
    RI: 'RI', RO: 'RO', RDI: 'RI', RDO: 'RO',
    AIN: 'AI', AOUT: 'AO', AI: 'AI', AO: 'AO',
    GIN: 'GI', GOUT: 'GO', GI: 'GI', GO: 'GO',
    UI: 'UI', UO: 'UO',
    FLG: 'F', F: 'F'
};

/** Order used when writing a CSV. */
const TYPE_ORDER = ['DI', 'DO', 'RI', 'RO', 'AI', 'AO', 'GI', 'GO', 'UI', 'UO', 'F', 'R', 'PR', 'SR'];

function addComment(map, type, index, comment) {
    const text = (comment || '').trim();
    if (type && text) {
        map.set(`${type}[${Number(index)}]`, text);
    }
}

/** ioconfig.dg: one "TYPE[ n]  comment" per line. Range lines ("DIN 1 - 16 RACK...") are ignored. */
function parseIoConfig(text) {
    const map = new Map();
    for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Z]+)\[\s*(\d+)\]\s?(.*)$/.exec(line);
        if (match) {
            addComment(map, IO_TYPE_MAP[match[1]], match[2], match[3]);
        }
    }
    return map;
}

/** iostate.dg: "TYPE[ n] STATE  comment", where STATE is ON, OFF, or a number; may hold two entries per line. */
function parseIoState(text) {
    const map = new Map();
    const entry = /([A-Z]+)\[\s*(\d+)\]\s+(?:ON|OFF|-?\d+)(.*?)(?=\s[A-Z]+\[\s*\d+\]|$)/g;
    for (const line of text.split(/\r?\n/)) {
        let match;
        while ((match = entry.exec(line)) !== null) {
            addComment(map, IO_TYPE_MAP[match[1]], match[2], match[3]);
        }
    }
    return map;
}

/** numreg.va / strreg.va: "[n] = value  'comment'"; the comment is the last quoted text on the line. */
function parseRegisterVa(text, type) {
    const map = new Map();
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*\[(\d+)\]\s*=.*'([^']*)'\s*$/.exec(line);
        if (match) {
            addComment(map, type, match[1], match[2]);
        }
    }
    return map;
}

/** posreg.va: "[group,n] = 'comment' ..."; only group 1, since PR[n] in a program means group 1. */
function parsePosRegVa(text) {
    const map = new Map();
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*\[1,(\d+)\]\s*=\s*'([^']*)'/.exec(line);
        if (match) {
            addComment(map, 'PR', match[1], match[2]);
        }
    }
    return map;
}

/** Finds backup files in a folder, ignoring case. Returns { 'ioconfig.dg': fullPath, ... } for files that exist. */
function findBackupFiles(folderPath) {
    const found = {};
    for (const name of fs.readdirSync(folderPath)) {
        const lower = name.toLowerCase();
        if (BACKUP_FILES.includes(lower)) {
            found[lower] = path.join(folderPath, name);
        }
    }
    return found;
}

/**
 * Reads every backup file found and returns { descriptions: Map<key, text>, counts: { fileName: n } }.
 * iostate.dg only fills keys that ioconfig.dg did not have.
 */
function readBackupDescriptions(files, readFile = filePath => fs.readFileSync(filePath, 'utf8')) {
    const descriptions = new Map();
    const counts = {};
    const take = (fileName, map, overwrite) => {
        let added = 0;
        for (const [key, text] of map) {
            if (overwrite || !descriptions.has(key)) {
                descriptions.set(key, text);
                added++;
            }
        }
        counts[fileName] = added;
    };
    if (files['ioconfig.dg']) take('ioconfig.dg', parseIoConfig(readFile(files['ioconfig.dg'])), true);
    if (files['iostate.dg']) take('iostate.dg', parseIoState(readFile(files['iostate.dg'])), false);
    if (files['numreg.va']) take('numreg.va', parseRegisterVa(readFile(files['numreg.va']), 'R'), true);
    if (files['posreg.va']) take('posreg.va', parsePosRegVa(readFile(files['posreg.va'])), true);
    if (files['strreg.va']) take('strreg.va', parseRegisterVa(readFile(files['strreg.va']), 'SR'), true);
    return { descriptions, counts };
}

/** Compares backup descriptions with an existing file. */
function compareDescriptions(existing, incoming) {
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    for (const [key, text] of incoming) {
        if (!existing.has(key)) added++;
        else if (existing.get(key) !== text) changed++;
        else unchanged++;
    }
    const kept = [...existing.keys()].filter(key => !incoming.has(key)).length;
    return { added, changed, unchanged, kept };
}

/** Merge: backup wins for its keys, other existing rows are kept. Replace: backup only. */
function combineDescriptions(existing, incoming, mode) {
    return mode === 'replace' ? new Map(incoming) : new Map([...existing, ...incoming]);
}

function sortKey(key) {
    const match = /^([A-Z]+)\[(\d+)\]$/.exec(key);
    const order = match ? TYPE_ORDER.indexOf(match[1]) : -1;
    return [order < 0 ? TYPE_ORDER.length : order, match ? Number(match[2]) : 0];
}

function csvField(value) {
    return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Writes Key,Description CSV text, sorted by type (DI, DO, ... R, PR, SR) and then number. */
function serializeDescriptionsCsv(descriptions) {
    const keys = [...descriptions.keys()].sort((a, b) => {
        const [typeA, indexA] = sortKey(a);
        const [typeB, indexB] = sortKey(b);
        return typeA - typeB || indexA - indexB;
    });
    return ['Key,Description', ...keys.map(key => `${key},${csvField(descriptions.get(key))}`)].join('\n') + '\n';
}

module.exports = {
    BACKUP_FILES,
    parseIoConfig,
    parseIoState,
    parseRegisterVa,
    parsePosRegVa,
    findBackupFiles,
    readBackupDescriptions,
    compareDescriptions,
    combineDescriptions,
    serializeDescriptionsCsv
};
