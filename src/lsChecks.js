const { validateProgramName } = require('./renameLs');

const checks = ['sections', 'programName', 'delimiters', 'labels', 'positions', 'motion', 'calls'];

// Robot-exported --eg: remarks wrap at about 80 characters. Continuation lines start
// with a bare ':' (no line number), and only the last line ends with ';'.
// The instruction colon, ignoring the colon that belongs to an --eg: remark marker,
// so "1  --eg: text ;" is reported as missing its leading ':'.
function instructionColon(line) {
    return line.search(/(?<!--eg):/i);
}

function remarkLine(open, line) {
    const colon = instructionColon(line);
    const content = colon < 0 ? '' : line.slice(colon + 1).trim();
    const continuation = open && colon >= 0 && !line.slice(0, colon).trim();
    // A remark missing its leading ':' is still remark text, not code.
    const remark = continuation || /^--eg:/i.test(content) || (colon < 0 && /--eg:/i.test(line));
    return { remark, continuation, open: remark && !content.endsWith(';') };
}

// Mask strings, comments and bracket descriptions before interpreting instructions.
function scanCode(text) {
    let code = '', quote = '', description = false;
    const stack = [];
    let problem = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            code += ' ';
            if (c === quote) {
                if (text[i + 1] === quote) { code += ' '; i++; }
                else quote = '';
            }
            continue;
        }
        if (description && c !== ']') { code += ' '; continue; }
        if (c === '"' || c === "'") { quote = c; code += ' '; continue; }
        if (c === '!') break;
        if (c === ':' && stack[stack.length - 1] === '[') {
            description = true;
            code += ' ';
            continue;
        }
        if (c === '[' || c === '(') stack.push(c);
        if (c === ']' || c === ')') {
            description = false;
            if (stack.pop() !== (c === ']' ? '[' : '(')) problem = 'Mismatched closing bracket or parenthesis.';
        }
        code += c;
    }
    if (quote) problem = 'Unclosed quoted string.';
    else if (stack.length) problem = 'Unclosed bracket or parenthesis.';
    return { code, problem };
}

function runChecks(text, rules, options = {}) {
    const issues = [];
    const lines = text.split(/\r?\n/);
    const active = new Map(rules.filter(r => r.enabled && checks.includes(r.check)).map(r => [r.check, r]));
    function report(check, line, detail) {
        const rule = active.get(check);
        if (!rule) return;
        issues.push({ line, start: 0, end: lines[line]?.length || 0,
            code: rule.id, severity: rule.severity || (check === 'calls' ? 'warning' : 'error'),
            message: `${rule.message} ${detail}` });
    }
    const markers = [], instructions = [], positions = new Set();
    let section = '', remarkOpen = false;
    lines.forEach((line, index) => {
        const marker = /^\s*\/([A-Z]+)(?:\s|$)/.exec(line);
        if (marker) { section = marker[1]; remarkOpen = false; markers.push({ name: section, line: index }); return; }
        if (section === 'POS') {
            const position = /^\s*P\[\s*(\d+)(?:\s*:[^\]]*)?\s*\]/.exec(line);
            if (position) positions.add(Number(position[1]));
        }
        if (section !== 'MN' || !line.trim()) return;
        const remark = remarkLine(remarkOpen, line);
        remarkOpen = remark.open;
        if (remark.remark) return; // Remark text is free-form, not code.
        const colon = line.indexOf(':');
        const body = colon < 0 ? line : line.slice(colon + 1);
        const scanned = scanCode(body);
        if (scanned.problem) report('delimiters', index, scanned.problem);
        // LS exports can put the motion letter before the instruction colon.
        const prefixMotion = colon >= 0 && /\b([JLCA])\s*$/.exec(line.slice(0, colon));
        const code = (prefixMotion ? prefixMotion[1] + ' ' : '') + scanned.code;
        instructions.push({ code, line: index });
    });
    const required = ['PROG', 'ATTR', 'MN', 'END'];
    let previous = -1;
    for (const name of required) {
        const occurrences = markers.filter(m => m.name === name);
        if (!occurrences.length) { report('sections', 0, `Missing /${name}.`); continue; }
        for (const duplicate of occurrences.slice(1)) report('sections', duplicate.line, `Duplicate /${name}.`);
        if (occurrences[0].line < previous) report('sections', occurrences[0].line, `/${name} is out of order.`);
        previous = Math.max(previous, occurrences[0].line);
    }
    const mn = markers.find(m => m.name === 'MN'), end = markers.find(m => m.name === 'END');
    const attr = markers.find(m => m.name === 'ATTR');
    const applications = markers.filter(m => m.name === 'APPL');
    if (!applications.length) report('sections', 0, 'Missing /APPL.');
    // Robot round trips can emit repeated /APPL headers; validate placement, not uniqueness.
    for (const application of applications) {
        if (!attr || !mn || application.line < attr.line || application.line > mn.line) {
            report('sections', application.line, '/APPL must appear between /ATTR and /MN.');
        }
    }
    const pos = markers.filter(m => m.name === 'POS');
    for (const [index, marker] of pos.entries()) {
        if (index || !mn || !end || marker.line < mn.line || marker.line > end.line) report('sections', marker.line, '/POS must occur once, between /MN and /END.');
    }
    if (end && lines.slice(end.line + 1).some(line => line.trim())) report('sections', end.line, 'Content appears after /END.');
    const prog = markers.find(m => m.name === 'PROG');
    if (prog) {
        const name = /^\s*\/PROG\s+(\S+)/.exec(lines[prog.line])?.[1] || '';
        const error = validateProgramName(name);
        if (error) report('programName', prog.line, error);
        if (options.fileName && name.toUpperCase() !== options.fileName.replace(/\.ls$/i, '').toUpperCase()) {
            report('programName', prog.line, `/PROG ${name} does not match ${options.fileName}.`);
        }
    }
    const labels = new Set();
    for (const instruction of instructions) {
        const label = /^\s*LBL\[\s*(\d+)\s*\]/i.exec(instruction.code);
        if (label) {
            const number = Number(label[1]);
            if (labels.has(number)) report('labels', instruction.line, `Duplicate LBL[${number}].`);
            labels.add(number);
        }
    }
    for (let i = 0; i < instructions.length; i++) {
        const { code, line } = instructions[i];
        for (const jump of code.matchAll(/\bJMP\s+LBL\[\s*(\d+)\s*\]/gi)) {
            if (!labels.has(Number(jump[1]))) report('labels', line, `JMP LBL[${jump[1]}] has no matching label.`);
        }
        for (const position of code.matchAll(/\bP\[\s*(\d+)\s*(?:,\s*\d+\s*)?\]/gi)) {
            if (!positions.has(Number(position[1]))) report('positions', line, `P[${position[1]}] is not defined in /POS.`);
        }
        if (options.localPrograms) {
            const local = new Set(options.localPrograms.map(name => name.toUpperCase()));
            for (const call of code.matchAll(/\b(?:CALL|RUN)\s+([A-Z_][A-Z0-9_]*)(?![A-Z0-9_])/gi)) {
                // Indirect CALL/RUN targets cannot be resolved statically.
                if (/^\s*\[/.test(code.slice(call.index + call[0].length))) continue;
                if (!local.has(call[1].toUpperCase())) report('calls', line, `${call[1]} was not found locally; it may exist on the robot.`);
            }
        }
        const motion = /^\s*([JLCA])\s+/i.exec(code);
        if (motion) {
            let statement = code;
            // Circular moves can put the destination/speed on a continuation line.
            if (!statement.includes(';')) {
                for (let j = i + 1; j < instructions.length; j++) {
                    if (!/^\s*(?:P(?:R)?\[|[\d.]+\s*(?:%|mm|cm|deg)|;)/i.test(instructions[j].code)) break;
                    statement += ' ' + instructions[j].code;
                    if (instructions[j].code.includes(';')) break;
                }
            }
            const targets = statement.match(/\bPR?\[/gi) || [];
            const requiredTargets = /[CA]/i.test(motion[1]) ? 2 : 1;
            if (targets.length < requiredTargets) report('motion', line, `Motion ${motion[1]} needs ${requiredTargets} position target(s).`);
            if (!/(?:\d+(?:\.\d+)?|R\[[^\]]+\])\s*(?:%|(?:mm\/(?:sec|s)|cm\/(?:sec|s)|deg\/(?:sec|s)|msec|sec)\b)/i.test(statement)) {
                report('motion', line, 'Motion speed is missing or not recognized.');
            }
            if (!/\b(?:FINE\b|(?:CNT|CR)\s*(?:\d+\b|R\[[^\]]+\]))/i.test(statement)) report('motion', line, 'Motion termination (FINE, CNT, or CR) is missing or not recognized.');
        }
    }
    return issues;
}

module.exports = { checks, runChecks, remarkLine, instructionColon };
