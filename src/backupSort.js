const fs = require('fs');
const path = require('path');

/**
 * Sorts the files of a "Get ALL Files" / "Get All LS Files" download into sub-folders by type.
 * Rules are based on 44 backups from 15 robots (see .agents/BackupFolders.md).
 */

// Folder template: category → folder (relative, "/" allowed). "" keeps files at the top level.
// "tp" is the sub-folder for .tp binaries inside the folder of their matching .ls.
const DEFAULT_FOLDERS = {
    programs: 'Programs',
    tp: 'TP',
    registers: 'Registers',
    io: 'IO',
    karel: 'KAREL',
    vision: 'Vision',
    web: 'Web',
    systemPrograms: 'System/Programs',
    systemVariables: 'System/Variables',
    systemConfig: 'System/Config',
    diagnostics: 'Diagnostics',
    other: 'Other'
};

// FANUC-supplied TP programs (name without extension, * and ? wildcards, any case).
const DEFAULT_SYSTEM_PROGRAMS = ['-BCKED*-', 'SV_ADJST', 'GETDATA', 'SENDDATA', 'SENDEVNT', 'SENDSYSV', 'REQMENU', 'CLSKP*'];

const REGISTERS = /^(numreg|posreg|strreg|palreg)\.(va|vr)$/;
const IO_FILES = /^(diocfgsv\.(io|va)|ioconfig\.dg|iostate\.dg|iostatus\.cm)$/;

function wildcard(pattern) {
    const escaped = String(pattern).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Category of one file. lsInfo(baseName) returns { isProgram } for the matching .ls, or undefined.
 * hasFile(lowerName) tells whether a file exists in the download.
 */
function categoryOf(name, { lsInfo = () => undefined, hasFile = () => false, systemPrograms = DEFAULT_SYSTEM_PROGRAMS } = {}) {
    const lower = name.toLowerCase();
    const ext = path.extname(lower);
    const base = lower.slice(0, lower.length - ext.length);
    if (REGISTERS.test(lower)) return 'registers';
    if (IO_FILES.test(lower)) return 'io';
    if (ext === '.ls' || ext === '.tp') {
        if (systemPrograms.some(pattern => wildcard(pattern).test(base))) return 'systemPrograms';
        const info = lsInfo(base);
        if (ext === '.ls' && info && !info.isProgram) return 'diagnostics'; // ERRALL, LOGBOOK, …: listings, not programs
        return 'programs';
    }
    if (ext === '.pc' || ((ext === '.vr' || ext === '.va') && hasFile(`${base}.pc`))) return 'karel';
    if (ext === '.dg' || ext === '.zip') return 'diagnostics';
    if (ext === '.sv' || ext === '.vr' || ext === '.va') return 'systemVariables';
    if (ext === '.stm' || ext === '.gif' || /^panel\d+\.dt$/.test(lower)) return 'web';
    if (['.vd', '.vda', '.cam'].includes(ext)) return 'vision';
    if (['.df', '.dt', '.xml', '.cm', '.dat', '.io'].includes(ext)) return 'systemConfig';
    return 'other';
}

function cleanFolder(value) {
    return String(value ?? '').replace(/\\/g, '/').split('/').map(part => part.trim()).filter(part => part && part !== '.' && part !== '..').join('/');
}

/** Relative folder (OS separators) for a file, using the template. .tp files go in the "tp" sub-folder of their category. */
function folderFor(name, category, folders = DEFAULT_FOLDERS) {
    const merged = { ...DEFAULT_FOLDERS, ...(folders || {}) };
    const parts = [cleanFolder(merged[category] ?? merged.other)];
    if (path.extname(name).toLowerCase() === '.tp') parts.push(cleanFolder(merged.tp));
    return parts.filter(Boolean).join('/').split('/').filter(Boolean).join(path.sep);
}

/** Reads the start of an .ls file to tell a TP program (/PROG header) from a text listing. */
function readLsInfo(filePath) {
    try {
        const head = fs.readFileSync(filePath, 'latin1').slice(0, 4096);
        return { isProgram: /^\s*\/PROG\s+\S+/m.test(head) };
    } catch {
        return undefined;
    }
}

/**
 * Moves the downloaded files into sub-folders. files: absolute paths, all directly in `folder`.
 * Returns the new absolute paths in the same order. Existing files are replaced.
 */
function sortDownloadedFiles(folder, files, { folders = DEFAULT_FOLDERS, systemPrograms = DEFAULT_SYSTEM_PROGRAMS } = {}) {
    const names = new Set(files.map(file => path.basename(file).toLowerCase()));
    const lsPath = new Map(files.filter(file => /\.ls$/i.test(file)).map(file => [path.basename(file).toLowerCase().slice(0, -3), file]));
    const infoCache = new Map();
    const lsInfo = base => {
        if (!lsPath.has(base)) return undefined;
        if (!infoCache.has(base)) infoCache.set(base, readLsInfo(lsPath.get(base)));
        return infoCache.get(base);
    };
    return files.map(file => {
        const name = path.basename(file);
        const category = categoryOf(name, { lsInfo, hasFile: lower => names.has(lower), systemPrograms });
        const relative = folderFor(name, category, folders);
        if (!relative) return file;
        const targetDir = path.join(folder, relative);
        fs.mkdirSync(targetDir, { recursive: true });
        const target = path.join(targetDir, name);
        fs.renameSync(file, target);
        return target;
    });
}

/** All files under folder (recursively, skipping .git), relative paths. */
function listFilesRecursive(folder) {
    const out = [];
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const relative = prefix ? path.join(prefix, entry.name) : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
            else if (entry.isFile()) out.push(relative);
        }
    };
    walk(folder, '');
    return out;
}

/**
 * Plans a flat restore copy: every file from the sorted backup in one folder, as the controller expects.
 * Returns { copies: [{ from, name }], duplicates: [names that appear more than once] }.
 */
function planRestoreFolder(sourceFolder) {
    const seen = new Map();
    const duplicates = new Set();
    const copies = [];
    for (const relative of listFilesRecursive(sourceFolder)) {
        const name = path.basename(relative);
        const key = name.toLowerCase();
        if (seen.has(key)) {
            duplicates.add(name);
            continue;
        }
        seen.set(key, relative);
        copies.push({ from: path.join(sourceFolder, relative), name });
    }
    return { copies, duplicates: [...duplicates] };
}

module.exports = {
    DEFAULT_FOLDERS,
    DEFAULT_SYSTEM_PROGRAMS,
    categoryOf,
    folderFor,
    sortDownloadedFiles,
    listFilesRecursive,
    planRestoreFolder
};
