const fs = require('fs');
const path = require('path');

const IP_PATTERN = /^(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)$/;
const MAX_RECENT_IPS = 5;
const PROJECT_IPS_FILE = path.join('.vscode', 'robot-ftp.json');
const OTHER_OPTION = 'other';

function cleanRecentIps(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    const seen = new Set();
    return list
        .filter(ip => typeof ip === 'string' && IP_PATTERN.test(ip) && !seen.has(ip) && seen.add(ip))
        .slice(0, MAX_RECENT_IPS);
}

function addRecentIp(list, ip) {
    return cleanRecentIps([ip, ...cleanRecentIps(list).filter(existing => existing !== ip)]);
}

function isValidPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Keeps robots with a name and a valid IP. `folder` is optional (relative to the workspace folder).
 * `port` is optional; missing or null means "use the robotFtp.port setting".
 * Returns { robots, problems } so the caller can report skipped entries.
 */
function cleanRobots(list) {
    const robots = [];
    const problems = [];
    if (list === undefined) {
        return { robots, problems };
    }
    if (!Array.isArray(list)) {
        return { robots, problems: ['"robots" must be an array.'] };
    }
    list.forEach((entry, index) => {
        const where = `robots[${index}]`;
        if (!entry || typeof entry !== 'object') {
            problems.push(`${where} is not an object.`);
            return;
        }
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) {
            problems.push(`${where} has no name.`);
            return;
        }
        if (typeof entry.ip !== 'string' || !IP_PATTERN.test(entry.ip)) {
            problems.push(`${where} (${name}) has an invalid IP address.`);
            return;
        }
        const robot = { name, ip: entry.ip };
        if (typeof entry.folder === 'string' && entry.folder.trim()) {
            robot.folder = entry.folder.trim();
        } else if (entry.folder !== undefined && entry.folder !== null && entry.folder !== '') {
            problems.push(`${where} (${name}) has an invalid folder; ignoring it.`);
        }
        if (isValidPort(entry.port)) {
            robot.port = entry.port;
        } else if (entry.port !== undefined && entry.port !== null) {
            problems.push(`${where} (${name}) has an invalid port; using the Port setting.`);
        }
        robots.push(robot);
    });
    return { robots, problems };
}

function getProjectIpsPath(workspaceRoot) {
    return path.join(workspaceRoot, PROJECT_IPS_FILE);
}

/** Reads the project file. Never creates it. Returns {} when it is missing. */
function readProjectFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(`${filePath} must contain a JSON object.`);
    }
    return data;
}

function writeProjectFile(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Returns { robots, recent, problems } for the workspace folder. */
function readProjectConfig(workspaceRoot) {
    const data = readProjectFile(getProjectIpsPath(workspaceRoot));
    const { robots, problems } = cleanRobots(data.robots);
    return { robots, recent: cleanRecentIps(data.recent), problems };
}

function readProjectRecentIps(workspaceRoot) {
    return readProjectConfig(workspaceRoot).recent;
}

/** Adds ip to the front of the project's recent list, keeping any other keys in the file. */
function saveProjectRecentIp(workspaceRoot, ip) {
    const filePath = getProjectIpsPath(workspaceRoot);
    const data = readProjectFile(filePath);
    data.recent = addRecentIp(data.recent, ip);
    writeProjectFile(filePath, data);
    return data.recent;
}

/** Adds a named robot, replacing any existing robot with the same name (case-insensitive). */
function saveProjectRobot(workspaceRoot, robot) {
    const filePath = getProjectIpsPath(workspaceRoot);
    const data = readProjectFile(filePath);
    const robots = Array.isArray(data.robots) ? data.robots : [];
    const key = robot.name.toLowerCase();
    const entry = { name: robot.name, ip: robot.ip, folder: robot.folder || null, port: robot.port ?? null };
    const index = robots.findIndex(existing => typeof existing?.name === 'string' && existing.name.trim().toLowerCase() === key);
    if (index >= 0) {
        robots[index] = entry;
    } else {
        robots.push(entry);
    }
    data.robots = robots;
    data.recent = cleanRecentIps(data.recent);
    writeProjectFile(filePath, data);
}

/** Creates the project file with empty lists if it does not exist. Returns its path. */
function ensureProjectFile(workspaceRoot) {
    const filePath = getProjectIpsPath(workspaceRoot);
    if (!fs.existsSync(filePath)) {
        writeProjectFile(filePath, { robots: [], recent: [] });
    }
    return filePath;
}

function normalizeForCompare(p, platform) {
    const resolved = path.resolve(p);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The robot whose folder contains targetPath. The deepest folder wins. */
function robotForPath(robots, workspaceRoot, targetPath, platform = process.platform) {
    if (!workspaceRoot || !targetPath) {
        return undefined;
    }
    const target = normalizeForCompare(targetPath, platform);
    let best;
    let bestLength = -1;
    for (const robot of robots) {
        if (!robot.folder) {
            continue;
        }
        const folder = normalizeForCompare(path.resolve(workspaceRoot, robot.folder), platform);
        if (isInside(folder, target) && folder.length > bestLength) {
            best = robot;
            bestLength = folder.length;
        }
    }
    return best;
}

function describe(parts) {
    return parts.filter(Boolean).join(' · ');
}

function portText(port) {
    return port ? `port ${port}` : undefined;
}

/**
 * Builds the IP picker list in this order:
 * 1. the robot whose folder contains targetPath
 * 2. recent IPs (shown with the robot name when known)
 * 3. other named robots
 * 4. built-in IPs
 * 5. "Other"
 * Each option carries { ip, port } (port undefined → use the setting); "Other" carries kind 'other'.
 */
function buildIpOptions({ robots = [], recent = [], workspaceRoot, targetPath, builtIns = [], platform }) {
    const options = [];
    const usedRobots = new Set();
    const usedIps = new Set();

    const addRobot = (robot, tag) => {
        usedRobots.add(robot);
        usedIps.add(robot.ip);
        options.push({
            label: robot.name,
            description: describe([robot.ip, portText(robot.port), tag]),
            ip: robot.ip,
            port: robot.port,
            robotName: robot.name
        });
    };

    const folderRobot = robotForPath(robots, workspaceRoot, targetPath, platform);
    if (folderRobot) {
        addRobot(folderRobot, 'this folder');
    }

    for (const ip of recent) {
        if (usedIps.has(ip)) {
            continue;
        }
        const robot = robots.find(candidate => candidate.ip === ip && !usedRobots.has(candidate));
        if (robot) {
            addRobot(robot, 'recent');
        } else {
            usedIps.add(ip);
            options.push({ label: ip, description: 'Recent robot IP', ip });
        }
    }

    for (const robot of robots) {
        if (!usedRobots.has(robot)) {
            addRobot(robot, robot.folder ? `folder ${robot.folder}` : undefined);
        }
    }

    for (const builtIn of builtIns) {
        if (!usedIps.has(builtIn.ip)) {
            usedIps.add(builtIn.ip);
            options.push({ label: builtIn.ip, description: builtIn.description, ip: builtIn.ip, port: builtIn.port });
        }
    }

    options.push({ label: 'Other', description: 'Enter a custom IP address', kind: OTHER_OPTION });
    return options;
}

/** Folder choices for a new robot: each folder from the workspace root down to targetPath, relative to the root. */
function folderChoices(workspaceRoot, targetPath) {
    if (!workspaceRoot || !targetPath || !isInside(path.resolve(workspaceRoot), path.resolve(targetPath))) {
        return [];
    }
    const parts = path.relative(workspaceRoot, targetPath).split(path.sep).filter(Boolean);
    return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

module.exports = {
    IP_PATTERN,
    MAX_RECENT_IPS,
    PROJECT_IPS_FILE,
    OTHER_OPTION,
    cleanRecentIps,
    addRecentIp,
    cleanRobots,
    isValidPort,
    getProjectIpsPath,
    readProjectConfig,
    readProjectRecentIps,
    saveProjectRecentIp,
    saveProjectRobot,
    ensureProjectFile,
    robotForPath,
    buildIpOptions,
    folderChoices
};
