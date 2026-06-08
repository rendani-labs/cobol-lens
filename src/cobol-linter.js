// @ts-check
'use strict';

/**
 * COBOL Linter integrato in COBOL Lens.
 * Porta JavaScript del linter Python (cobol-linter.py).
 * 
 * Ogni regola e' una funzione che riceve le righe del file e la configurazione,
 * e restituisce un array di diagnostiche VS Code.
 * 
 * Le regole sono attivabili/disattivabili singolarmente via settings.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { isComment, resolveCopybookPath, COPY_REGEX, COBOL_RESERVED, REPLACING_PAIR_REGEX } = require('./cobol-parser');

// ============================================================================
// Helper
// ============================================================================

const SEPARATOR_PATTERN = '*' + '-'.repeat(65);

/**
 * Source format corrente (impostato da runLinter prima di eseguire le regole).
 * 'fixed' = formato fisso standard (col 1-6 seq, col 7 ind, col 8-72 code)
 * 'variable' = formato variabile ($SET sourceformat(variable)) - nessun limite destro
 * 'free' = formato libero ($SET sourceformat(free)) - nessuna area fissa
 */
let currentSourceFormat = 'fixed';

/**
 * Rileva il source format dal contenuto del file.
 * Cerca la direttiva $SET sourceformat(...) nelle prime righe.
 * @param {string[]} lines
 * @returns {'fixed'|'variable'|'free'}
 */
function detectSourceFormat(lines) {
    // Cerca nelle prime 20 righe (le direttive $SET devono essere all'inizio)
    const limit = Math.min(lines.length, 20);
    for (let i = 0; i < limit; i++) {
        const line = lines[i].trim().toUpperCase();
        const match = line.match(/\$SET\s+SOURCEFORMAT\s*\(\s*(VARIABLE|FREE)\s*\)/i);
        if (match) {
            return match[1].toUpperCase() === 'FREE' ? 'free' : 'variable';
        }
    }
    return 'fixed';
}

/**
 * Verifica se una riga e' vuota o solo spazi.
 * @param {string} line
 * @returns {boolean}
 */
function isBlank(line) {
    return line.trim() === '';
}

/**
 * Verifica se e' una direttiva $SET.
 * @param {string} line
 * @returns {boolean}
 */
function isSetDirective(line) {
    return line.trim().startsWith('$SET');
}

/**
 * Verifica se la riga deve essere ignorata.
 * @param {string} line
 * @returns {boolean}
 */
function isSkippable(line) {
    if (isBlank(line)) return true;
    if (isComment(line)) return true;
    if (isSetDirective(line)) return true;
    if (line.length > 7) {
        const codePart = line.substring(7).trim();
        if (codePart.startsWith('*>')) return true;
    }
    return false;
}

/**
 * Restituisce il contenuto codice.
 * - fixed: col 8-72
 * - variable: col 8 fino a fine riga (nessun limite destro)
 * - free: intera riga
 * @param {string} line
 * @returns {string}
 */
function getCodeContent(line) {
    if (isComment(line) || isSetDirective(line) || isBlank(line)) return '';

    if (currentSourceFormat === 'free') {
        const trimmed = line.trim();
        if (trimmed.startsWith('*>')) return '';
        return line;
    }

    // fixed e variable: col 7 indicator, code da col 8
    if (line.length >= 7) {
        const code = currentSourceFormat === 'variable'
            ? line.substring(7)          // variable: nessun limite destro
            : (line.length > 7 ? line.substring(7, 72) : '');  // fixed: col 8-72
        if (code.trim().startsWith('*>')) return '';
        return code;
    }
    return '';
}

/**
 * Rimuove il contenuto tra apici per confronti.
 * @param {string} text
 * @returns {string}
 */
function stripLiterals(text) {
    return text.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
}

// ============================================================================
// Contesto di analisi
// ============================================================================

class AnalysisContext {
    constructor() {
        this.currentDivision = '';
        this.inFileControl = false;
        this.inWorkingStorage = false;
        this.inLinkage = false;
        this.inFileSection = false;
        this.inProcedure = false;
        this.inExecBlock = false;
    }

    /**
     * @param {string} line
     * @param {string} code
     */
    update(line, code) {
        const upper = code.trim().toUpperCase();

        // Track EXEC CICS / EXEC SQL ... END-EXEC blocks
        if (/\bEXEC\s+(CICS|SQL)\b/.test(upper)) this.inExecBlock = true;
        if (/\bEND-EXEC\b/.test(upper)) this.inExecBlock = false;

        if (upper.includes('IDENTIFICATION DIVISION')) {
            this.currentDivision = 'IDENTIFICATION';
            this._resetSections();
        } else if (upper.includes('ENVIRONMENT DIVISION')) {
            this.currentDivision = 'ENVIRONMENT';
            this._resetSections();
        } else if (upper.includes('DATA DIVISION')) {
            this.currentDivision = 'DATA';
            this._resetSections();
        } else if (upper.includes('PROCEDURE DIVISION')) {
            this.currentDivision = 'PROCEDURE';
            this._resetSections();
            this.inProcedure = true;
        }

        if (upper.includes('FILE-CONTROL')) {
            this.inFileControl = true;
            this.inWorkingStorage = false;
            this.inLinkage = false;
            this.inFileSection = false;
        } else if (upper.includes('FILE SECTION')) {
            this.inFileSection = true;
            this.inFileControl = false;
            this.inWorkingStorage = false;
            this.inLinkage = false;
        } else if (upper.includes('WORKING-STORAGE SECTION')) {
            this.inWorkingStorage = true;
            this.inFileControl = false;
            this.inFileSection = false;
            this.inLinkage = false;
        } else if (upper.includes('LINKAGE SECTION')) {
            this.inLinkage = true;
            this.inWorkingStorage = false;
            this.inFileControl = false;
            this.inFileSection = false;
        } else if (upper.endsWith('SECTION.') && !['DATA', ''].includes(this.currentDivision)) {
            this.inFileControl = false;
            this.inWorkingStorage = false;
            this.inLinkage = false;
            this.inFileSection = false;
        }
    }

    _resetSections() {
        this.inFileControl = false;
        this.inWorkingStorage = false;
        this.inLinkage = false;
        this.inFileSection = false;
        this.inProcedure = this.currentDivision === 'PROCEDURE';
        this.inExecBlock = false;
    }
}

// ============================================================================
// Severity helper
// ============================================================================

/**
 * Converte stringa severity in DiagnosticSeverity VS Code.
 * @param {string} sev
 * @returns {vscode.DiagnosticSeverity}
 */
function toSeverity(sev) {
    switch (sev) {
        case 'error': return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'info': return vscode.DiagnosticSeverity.Information;
        default: return vscode.DiagnosticSeverity.Warning;
    }
}

/**
 * Crea una diagnostica.
 * @param {number} lineNum - 0-based
 * @param {string} severity
 * @param {string} ruleId
 * @param {string} message
 * @param {number} [colStart]
 * @param {number} [colEnd]
 * @param {string} [symbolName] - Nome del simbolo da evidenziare (usato nel post-processing)
 * @returns {vscode.Diagnostic}
 */
function makeDiag(lineNum, severity, ruleId, message, colStart, colEnd, symbolName) {
    const range = new vscode.Range(
        lineNum, colStart || 0,
        lineNum, colEnd || 999
    );
    const diag = new vscode.Diagnostic(range, message, toSeverity(severity));
    diag.source = 'COBOL Lens';
    diag.code = ruleId;
    if (symbolName) diag._symbolName = symbolName;
    return diag;
}

// ============================================================================
// REGOLE
// ============================================================================

/**
 * @typedef {Object} RuleConfig
 * @property {boolean} enabled
 * @property {string} severity
 * @property {number} [maxColumn]
 * @property {number} [expectedColumn]
 */

/**
 * Legge la configurazione di una regola.
 * @param {string} ruleId
 * @returns {RuleConfig}
 */
function getRuleConfig(ruleId) {
    const config = vscode.workspace.getConfiguration('cobolLens.linter.rules');
    const severity = config.get(`${ruleId}.severity`, undefined);
    const enabled = config.get(`${ruleId}.enabled`, true);

    // Severity defaults per regola
    const defaultSeverities = {
        'col72': 'error', 'no-goto': 'error', 'no-at-end': 'error',
        'no-level-77-78': 'error', 'uppercase': 'warning',
        'division-separator': 'warning', 'pic-alignment': 'warning',
        'select-col12': 'warning', 'assign-col29': 'warning',
        'ws-levels': 'warning', 'paragraph-naming': 'warning',
        'no-else-if': 'warning', 'move-to-alignment': 'warning',
        'ws-level-spacing': 'warning', 'end-structure': 'warning',
        'undefined-variable': 'error', 'undefined-paragraph': 'error',
        'unused-paragraph': 'warning', 'unused-variable': 'warning',
        'duplicate-variable': 'error', 'missing-period': 'error',
        'pic-missing': 'error', 'mismatched-copy': 'error',
        'perform-thru-order': 'error', 'section-order': 'error',
        'empty-paragraph': 'warning', 'consecutive-perform-spacing': 'warning',
        'missing-file-status': 'warning', 'missing-stop-run': 'warning',
        'and-or-if': 'error',
        'redefines-size': 'error',
        'invalid-column-7': 'error',
        'unsubscripted-occurs': 'error',
        'orphan-scope-delimiter': 'error',
        'variable-name-length': 'error',
        'missing-level': 'error',
        'chars-after-period': 'error',
        'compute-multiline-asterisk': 'warning',
        'alphanumeric-in-compute': 'error'
    };

    return {
        enabled: enabled !== false,
        severity: severity || defaultSeverities[ruleId] || 'warning'
    };
}

// ---------------------------------------------------------------------------
// col72
// ---------------------------------------------------------------------------
function checkCol72(lines) {
    const cfg = getRuleConfig('col72');
    if (!cfg.enabled) return [];
    const diags = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        if (raw.length <= 72) continue;

        // Standard interno: in formato fixed NON e' ammesso alcun contenuto
        // da colonna 73 in poi.
        const beyond72 = raw.substring(72);
        if (/\S/.test(beyond72)) {
            diags.push(makeDiag(i, cfg.severity, 'col72',
                `Contenuto non consentito oltre la colonna 72`, 72, raw.length));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// no-goto
// ---------------------------------------------------------------------------
function checkNoGoto(lines) {
    const cfg = getRuleConfig('no-goto');
    if (!cfg.enabled) return [];
    const diags = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw).toUpperCase();
        const goMatch = code.match(/\bGO\s+TO\b/) || code.match(/\bGOTO\b/);
        if (goMatch) {
            const colStart = 7 + goMatch.index;
            const colEnd = colStart + goMatch[0].length;
            diags.push(makeDiag(i, cfg.severity, 'no-goto',
                'Uso di GOTO non consentito. Usare PERFORM e IF.', colStart, colEnd));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// no-at-end
// ---------------------------------------------------------------------------
function checkNoAtEnd(lines) {
    const cfg = getRuleConfig('no-at-end');
    if (!cfg.enabled) return [];
    const diags = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw).toUpperCase();
        if (/\bAT\s+END\b/.test(code) || /\bNOT\s+AT\s+END\b/.test(code)) {
            diags.push(makeDiag(i, cfg.severity, 'no-at-end',
                'Uso di AT END / NOT AT END non consentito. Usare il file status con EVALUATE.'));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// no-level-77-78
// ---------------------------------------------------------------------------
function checkNoLevel7778(lines) {
    const cfg = getRuleConfig('no-level-77-78');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (ctx.inWorkingStorage) {
            const stripped = code.trim();
            if (/^(77|78)\s+/.test(stripped.toUpperCase())) {
                const level = stripped.substring(0, 2);
                diags.push(makeDiag(i, cfg.severity, 'no-level-77-78',
                    `Livello ${level} non consentito in WORKING-STORAGE. Usare 01, 05, 10, 15...`));
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// uppercase
// ---------------------------------------------------------------------------
function checkUppercase(lines) {
    const cfg = getRuleConfig('uppercase');
    if (!cfg.enabled) return [];
    const diags = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        if (raw.length < 8) continue;
        const code = (currentSourceFormat === 'fixed' && raw.length > 72)
            ? raw.substring(7, 72)
            : raw.substring(7);
        if (code.trim().startsWith('*>')) continue;
        let cleaned = stripLiterals(code);
        cleaned = cleaned.replace(/<[^>]*>/g, '');
        if (cleaned !== cleaned.toUpperCase() && cleaned.trim()) {
            diags.push(makeDiag(i, cfg.severity, 'uppercase',
                'Il codice COBOL deve essere in MAIUSCOLO'));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// division-separator
// ---------------------------------------------------------------------------
function checkDivisionSeparator(lines) {
    const cfg = getRuleConfig('division-separator');
    if (!cfg.enabled) return [];
    const diags = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw).trim().toUpperCase();
        let isDivOrSec = false;
        if (code.includes('DIVISION') && !code.includes('IDENTIFICATION')) {
            isDivOrSec = true;
        } else if (code.endsWith('SECTION.')) {
            if (code.includes('WORKING-STORAGE SECTION') || code.includes('LINKAGE SECTION')) {
                isDivOrSec = true;
            }
        }
        if (isDivOrSec && i > 0) {
            let prevIdx = i - 1;
            let foundSep = false;
            while (prevIdx >= 0) {
                const prev = lines[prevIdx];
                if (isBlank(prev)) { prevIdx--; continue; }
                if (prev.includes(SEPARATOR_PATTERN)) foundSep = true;
                break;
            }
            if (!foundSep) {
                diags.push(makeDiag(i, cfg.severity, 'division-separator',
                    `Manca la riga separatrice (*---) prima di: ${code}`));
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// pic-alignment
// ---------------------------------------------------------------------------
function checkPicAlignment(lines) {
    const cfg = getRuleConfig('pic-alignment');
    if (!cfg.enabled) return [];
    const expected = 45;
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection) {
            const upperRaw = raw.toUpperCase();
            const picMatch = upperRaw.match(/\bPIC\b/);
            if (picMatch) {
                const picCol = upperRaw.indexOf(picMatch[0]) + 1; // 1-based
                const beforePic = raw.substring(0, upperRaw.indexOf(picMatch[0])).trimEnd();
                if (beforePic.length < expected - 2 && picCol !== expected) {
                    diags.push(makeDiag(i, cfg.severity, 'pic-alignment',
                        `PIC alla colonna ${picCol}, attesa colonna ${expected}`));
                }
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// select-col12
// ---------------------------------------------------------------------------
function checkSelectCol12(lines) {
    const cfg = getRuleConfig('select-col12');
    if (!cfg.enabled) return [];
    const expected = 12;
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (ctx.inFileControl) {
            const upperRaw = raw.toUpperCase();
            const selMatch = /\bSELECT\b/.exec(upperRaw);
            if (selMatch) {
                const selCol = selMatch.index + 1;
                if (selCol !== expected) {
                    diags.push(makeDiag(i, cfg.severity, 'select-col12',
                        `SELECT alla colonna ${selCol}, attesa colonna ${expected}`));
                }
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// assign-col29
// ---------------------------------------------------------------------------
function checkAssignCol29(lines) {
    const cfg = getRuleConfig('assign-col29');
    if (!cfg.enabled) return [];
    const expected = 29;
    const keywords = ['ASSIGN', 'ORGANIZATION', 'RECORD KEY', 'ACCESS', 'STATUS'];
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (ctx.inFileControl) {
            const upperRaw = raw.toUpperCase();
            const stripped = upperRaw.trim();
            for (const kw of keywords) {
                const re = new RegExp('\\b' + kw + '\\b');
                const kwMatch = re.exec(upperRaw);
                if (kwMatch && stripped.startsWith(kw)) {
                    const kwCol = kwMatch.index + 1;
                    if (kwCol !== expected) {
                        diags.push(makeDiag(i, cfg.severity, 'assign-col29',
                            `${kw} alla colonna ${kwCol}, attesa colonna ${expected}`));
                    }
                }
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// ws-levels
// ---------------------------------------------------------------------------
function checkWsLevels(lines) {
    const cfg = getRuleConfig('ws-levels');
    if (!cfg.enabled) return [];
    const validLevels = new Set([1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 66, 88]);
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (ctx.inWorkingStorage || ctx.inLinkage) {
            const stripped = code.trim();
            const levelMatch = stripped.match(/^(\d{1,2})\s+/);
            if (levelMatch) {
                const level = parseInt(levelMatch[1], 10);
                if (!validLevels.has(level)) {
                    diags.push(makeDiag(i, cfg.severity, 'ws-levels',
                        `Livello ${String(level).padStart(2, '0')} non standard. Usare: 01, 05, 10, 15, 20... (incremento di 5) oppure 66, 88`));
                }
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// no-else-if
// ---------------------------------------------------------------------------
function checkNoElseIf(lines) {
    const cfg = getRuleConfig('no-else-if');
    if (!cfg.enabled) return [];
    const diags = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw).toUpperCase();
        if (/\bELSE\s+IF\b/.test(code)) {
            diags.push(makeDiag(i, cfg.severity, 'no-else-if',
                'Non usare ELSE IF. Indentare le IF dentro un blocco ELSE.'));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// move-to-alignment
// ---------------------------------------------------------------------------
function checkMoveToAlignment(lines) {
    const cfg = getRuleConfig('move-to-alignment');
    if (!cfg.enabled) return [];
    const expected = 45;
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (!ctx.inProcedure || !code.trim()) continue;
        const upperRaw = raw.toUpperCase();
        const moveMatch = /\bMOVE\b/.exec(upperRaw);
        if (moveMatch) {
            const afterMove = upperRaw.substring(moveMatch.index + moveMatch[0].length);
            const toMatch = /\bTO\b/.exec(afterMove);
            if (toMatch) {
                const toCol = moveMatch.index + moveMatch[0].length + toMatch.index + 1;
                const beforeTo = raw.substring(0, moveMatch.index + moveMatch[0].length + toMatch.index).trimEnd();
                if (beforeTo.length < expected - 2 && toCol !== expected) {
                    diags.push(makeDiag(i, cfg.severity, 'move-to-alignment',
                        `TO alla colonna ${toCol}, attesa colonna ${expected}`));
                }
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// ws-level-spacing
// ---------------------------------------------------------------------------
function checkWsLevelSpacing(lines) {
    const cfg = getRuleConfig('ws-level-spacing');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection) {
            const stripped = code.trim();
            const levelMatch = stripped.match(/^(\d{1,2})(\s+)(\S)/);
            if (levelMatch) {
                const spaces = levelMatch[2];
                if (spaces.length !== 1) {
                    diags.push(makeDiag(i, cfg.severity, 'ws-level-spacing',
                        `Tra il livello e il nome devono esserci esattamente 1 spazio (trovati ${spaces.length})`));
                }
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// end-structure
// ---------------------------------------------------------------------------
function checkEndStructure(lines) {
    const cfg = getRuleConfig('end-structure');
    const orphanCfg = getRuleConfig('orphan-scope-delimiter');
    if (!cfg.enabled && !orphanCfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    const stack = []; // {type, line}
    let pendingPerformLine = -1; // riga di un PERFORM "bare" da risolvere

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        if (ctx.inExecBlock) continue;

        const upper = code.trim().toUpperCase();

        // Rimuovi END-xxx per evitare che le keyword apertura matchino dentro la chiusura
        const cleaned = upper
            .replace(/\bEND-IF\b/g, ' ')
            .replace(/\bEND-EVALUATE\b/g, ' ')
            .replace(/\bEND-PERFORM\b/g, ' ')
            .replace(/\bEND-STRING\b/g, ' ')
            .replace(/\bEND-UNSTRING\b/g, ' ')
            .replace(/\bEND-SEARCH\b/g, ' ')
            .replace(/\bEND-READ\b/g, ' ')
            .replace(/\bEND-CALL\b/g, ' ');

        // Rimuovi anche i letterali stringa per non confondere keyword dentro virgolette
        const cleanedNoLit = stripLiterals(cleaned);

        // ----- Risolvi PERFORM pendente dalla riga precedente -----
        if (pendingPerformLine >= 0) {
            if (/\bUNTIL\b|\bVARYING\b|\bTIMES\b/.test(upper)) {
                // E' un PERFORM inline multi-riga -> push sullo stack
                stack.push({ type: 'PERFORM', line: pendingPerformLine });
            }
            // Se non ha UNTIL/VARYING/TIMES, era un PERFORM <paragrafo> -> ignora
            pendingPerformLine = -1;
        }

        // ----- Detect aperture sulla riga "pulita" (senza END-xxx e senza letterali) -----
        if (/\bIF\b/.test(cleanedNoLit)) {
            stack.push({ type: 'IF', line: i });
        }
        if (/\bEVALUATE\b/.test(cleanedNoLit)) {
            stack.push({ type: 'EVALUATE', line: i });
        }
        if (/(?<!-)\bSEARCH\b(?!-)/.test(cleanedNoLit)) {
            stack.push({ type: 'SEARCH', line: i });
        }

        if (/(?<!-)\bUNSTRING\b(?!-)/.test(cleanedNoLit)) {
            stack.push({ type: 'UNSTRING', line: i });
        }

        // CALL: verbo in PROCEDURE DIVISION (escludi CALL- nei nomi paragrafo e literal)
        if (/(?<!-)\bCALL\b(?!-)/.test(cleanedNoLit)) {
            stack.push({ type: 'CALL', line: i });
        }

        // PERFORM: distingui inline da out-of-line
        const perfMatch = /\bPERFORM\b/.exec(cleanedNoLit);
        if (perfMatch) {
            const afterPerform = cleanedNoLit.substring(perfMatch.index + 7).trim();
            if (/\bUNTIL\b|\bVARYING\b|\bTIMES\b/.test(afterPerform)) {
                // Inline PERFORM con keyword sulla stessa riga
                stack.push({ type: 'PERFORM', line: i });
            } else if (/\bTHRU\b|\bTHROUGH\b/.test(afterPerform)) {
                // Out-of-line PERFORM THRU -> non serve END-PERFORM
            } else if (!afterPerform) {
                // PERFORM "bare" -> controlla riga successiva
                pendingPerformLine = i;
            } else {
                // PERFORM <something>: se il token dopo e' un nome paragrafo -> out-of-line
                const firstToken = afterPerform.split(/\s+/)[0].replace(/\.$/, '');
                // Se sembra un paragrafo (non e' una keyword inline), e' out-of-line
                if (firstToken && !/\bUNTIL\b|\bVARYING\b|\bTIMES\b/.test(firstToken)) {
                    // Out-of-line: PERFORM <paragraph-name> [THRU ...]
                } else {
                    stack.push({ type: 'PERFORM', line: i });
                }
            }
        }

        // ----- Chiusure END-xxx sulla riga originale (senza letterali) -----
        const upperNoLit = stripLiterals(upper);
        for (const [endKw, openKw] of [
            ['END-IF', 'IF'], ['END-EVALUATE', 'EVALUATE'], ['END-PERFORM', 'PERFORM'],
            ['END-UNSTRING', 'UNSTRING'],
            ['END-SEARCH', 'SEARCH'], ['END-CALL', 'CALL']
        ]) {
            if (upperNoLit.includes(endKw)) {
                let matched = false;
                for (let j = stack.length - 1; j >= 0; j--) {
                    if (stack[j].type === openKw) {
                        stack.splice(j, 1);
                        matched = true;
                        break;
                    }
                }
                if (!matched && orphanCfg.enabled &&
                    ['IF', 'EVALUATE', 'PERFORM', 'UNSTRING', 'SEARCH',
                     'CALL'].includes(openKw)) {
                    diags.push(makeDiag(i, orphanCfg.severity, 'orphan-scope-delimiter',
                        `${endKw} senza una corrispondente istruzione ${openKw} di apertura`));
                }
            }
        }

        // Punto sulla riga: in COBOL il punto chiude TUTTI gli scope aperti.
        // Rimuovi stringhe letterali per non confondere '.' con punto di chiusura.
        if (upperNoLit.includes('.')) {
            if (cfg.enabled) {
                for (const item of stack) {
                    diags.push(makeDiag(item.line, cfg.severity, 'end-structure',
                        `Struttura ${item.type} aperta alla riga ${item.line + 1} chiusa da un punto anziche' da END-${item.type}`));
                }
            }
            stack.length = 0;
            pendingPerformLine = -1;
        }
    }

    // Fine file: segnala strutture rimaste aperte
    if (cfg.enabled) {
        for (const item of stack) {
            diags.push(makeDiag(item.line, cfg.severity, 'end-structure',
                `Struttura ${item.type} aperta alla riga ${item.line + 1} senza chiusura (manca END-${item.type})`));
        }
    }

    return diags;
}

// ---------------------------------------------------------------------------
// string-delimited (STRING deve avere DELIMITED BY prima di INTO)
// ---------------------------------------------------------------------------
function checkStringDelimited(lines) {
    const cfg = getRuleConfig('end-structure');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();

    let inString = false;
    let stringLine = -1;
    let stringStmt = '';

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        if (ctx.inExecBlock) continue;

        const upper = code.trim().toUpperCase();

        if (inString) {
            stringStmt += ' ' + upper;
            if (/\bEND-STRING\b/.test(upper) || stripLiterals(upper).includes('.')) {
                const delimPos = stringStmt.search(/\bDELIMITED\s+BY\b/);
                const intoPos = stringStmt.search(/\bINTO\b/);
                if (intoPos >= 0 && (delimPos < 0 || delimPos > intoPos)) {
                    diags.push(makeDiag(stringLine, cfg.severity, 'end-structure',
                        'STRING: manca DELIMITED BY prima della clausola INTO'));
                }
                inString = false;
                stringStmt = '';
            }
            continue;
        }

        // Detect STRING (escludi UNSTRING e END-STRING)
        const noEnd = upper.replace(/\bEND-STRING\b/g, ' ').replace(/\bUNSTRING\b/g, ' ').replace(/\bEND-UNSTRING\b/g, ' ');
        if (/\bSTRING\b/.test(noEnd)) {
            stringLine = i;
            stringStmt = upper;
            if (/\bEND-STRING\b/.test(upper) || stripLiterals(upper).includes('.')) {
                const delimPos = stringStmt.search(/\bDELIMITED\s+BY\b/);
                const intoPos = stringStmt.search(/\bINTO\b/);
                if (intoPos >= 0 && (delimPos < 0 || delimPos > intoPos)) {
                    diags.push(makeDiag(stringLine, cfg.severity, 'end-structure',
                        'STRING: manca DELIMITED BY prima della clausola INTO'));
                }
                inString = false;
                stringStmt = '';
            } else {
                inString = true;
            }
        }
    }

    return diags;
}

// ---------------------------------------------------------------------------
// paragraph-naming
// ---------------------------------------------------------------------------
function checkParagraphNaming(lines) {
    const cfg = getRuleConfig('paragraph-naming');
    if (!cfg.enabled) return [];
    const validPatterns = [/^[IEF]\d{4}-/, /^[VS]\d{4}-/, /^X\d{4}-/];
    const diags = [];
    const ctx = new AnalysisContext();
    const excludeKeywords = new Set([
        'PERFORM', 'MOVE', 'IF', 'EVALUATE', 'DISPLAY', 'OPEN', 'CLOSE',
        'READ', 'WRITE', 'REWRITE', 'START', 'DELETE', 'STOP', 'GOBACK',
        'EXIT', 'SET', 'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'COMPUTE',
        'ACCEPT', 'STRING', 'UNSTRING', 'COPY', 'CALL', 'CONTINUE',
        'WHEN', 'ELSE', 'NOT', 'THRU', 'THROUGH', 'PROCEDURE', 'DECLARATIVES',
        'INITIALIZE', 'INSPECT', 'INVOKE', 'MERGE', 'RELEASE', 'RETURN',
        'SEARCH', 'SORT', 'GO', 'CANCEL', 'GENERATE', 'INITIATE',
        'TERMINATE', 'UNLOCK', 'EXEC', 'END-EXEC', 'ENTER', 'ENTRY',
        'RECEIVE', 'SEND', 'SUPPRESS', 'USE', 'ALTER', 'ENABLE', 'DISABLE'
    ]);

    // Traccia se lo statement precedente e' stato chiuso da un punto.
    // Se non e' chiuso, le righe successive sono continuazioni, non paragrafi.
    let prevStmtClosed = true;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;

        const stripped = code.trim();
        if (!stripped) continue;

        // Se lo statement precedente non e' stato chiuso, siamo in continuazione
        if (!prevStmtClosed) {
            if (stripped.endsWith('.')) prevStmtClosed = true;
            continue;
        }

        // Un paragrafo deve iniziare in Area A (colonne 8-11).
        // code parte da colonna 8: le posizioni 0-3 corrispondono ad Area A.
        // Se il primo carattere non-spazio e' oltre posizione 3, siamo in Area B.
        const firstCharPos = code.search(/\S/);
        if (firstCharPos < 0 || firstCharPos > 3) {
            // Riga in Area B: non e' un paragrafo, ma traccia il punto
            if (stripped.endsWith('.')) prevStmtClosed = true;
            else prevStmtClosed = false;
            continue;
        }

        if (!stripped || stripped[0] < 'A' || stripped[0] > 'Z') {
            if (stripped.endsWith('.')) prevStmtClosed = true;
            else prevStmtClosed = false;
            continue;
        }

        // Candidato paragrafo: deve avere un punto e max 2 token
        // Es. "A010-START." oppure "A010-START SECTION."
        if (!stripped.includes('.')) {
            prevStmtClosed = false;
            continue;
        }

        const parts = stripped.split(/\s+/);
        if (parts.length > 2) {
            // Statement multi-token (es. INITIALIZE VAR1 VAR2.)
            prevStmtClosed = stripped.endsWith('.');
            continue;
        }

        const firstName = parts[0].replace(/\.$/, '');
        if (firstName !== firstName.toUpperCase()) {
            prevStmtClosed = stripped.endsWith('.');
            continue;
        }
        if (excludeKeywords.has(firstName) || COBOL_RESERVED.has(firstName)) {
            prevStmtClosed = stripped.endsWith('.');
            continue;
        }
        if (firstName.startsWith('END-') || firstName.startsWith('*>')) {
            prevStmtClosed = stripped.endsWith('.');
            continue;
        }

        // E' un paragrafo: il punto chiude la label
        prevStmtClosed = true;

        if (!validPatterns.some(p => p.test(firstName))) {
            diags.push(makeDiag(i, cfg.severity, 'paragraph-naming',
                `Il paragrafo '${firstName}' non segue la convenzione (I0001-, E0001-, F0001-, V0000-, S0000-, X9999-)`,
                undefined, undefined, firstName));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// missing-period
// ---------------------------------------------------------------------------
function checkMissingPeriod(lines) {
    const cfg = getRuleConfig('missing-period');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!(ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection)) continue;

        const upper = code.trim().toUpperCase();
        if (upper.startsWith('COPY ')) continue;
        if (!/^\s*\d{1,2}\s+/.test(upper)) continue;
        // Controlla se c'e' un punto nel codice (escludendo i literal)
        const withoutLit = stripLiterals(upper);
        if (withoutLit.includes('.')) continue;

        // Controlla riga successiva
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
            const nextRaw = lines[j];
            if (isSkippable(nextRaw)) continue;
            const nextCode = getCodeContent(nextRaw).trim().toUpperCase();
            if (!nextCode) continue;
            if (/^\s*\d{1,2}\s+/.test(nextCode) ||
                nextCode.startsWith('FD ') || nextCode.startsWith('SD ') ||
                nextCode.startsWith('COPY ') ||
                nextCode.includes('SECTION.') || nextCode.includes('DIVISION')) {
                diags.push(makeDiag(i, cfg.severity, 'missing-period',
                    'Manca il punto alla fine della definizione di variabile'));
            }
            break;
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// pic-missing
// ---------------------------------------------------------------------------
function checkPicMissing(lines) {
    const cfg = getRuleConfig('pic-missing');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    const dataItems = []; // {line, level, name, hasPic, hasRedefines, hasRenames, hasIndex}

    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        if (isSkippable(raw)) { i++; continue; }
        const code = getCodeContent(raw);
        if (!code.trim()) { i++; continue; }
        ctx.update(raw, code);
        if (!(ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection)) { i++; continue; }

        const upper = code.trim().toUpperCase();
        if (upper.startsWith('COPY ')) { i++; continue; }
        const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
        if (!levelMatch) { i++; continue; }

        const level = parseInt(levelMatch[1], 10);
        const name = levelMatch[2].replace(/\.$/, '');
        const lineNum = i;

        // Accumula righe di continuazione fino al punto finale
        let fullStmt = code;
        let j = i + 1;
        if (!fullStmt.trimEnd().endsWith('.')) {
            while (j < lines.length) {
                if (isSkippable(lines[j])) { j++; continue; }
                const nextCode = getCodeContent(lines[j]);
                if (!nextCode.trim()) { j++; continue; }
                // Se la prossima riga inizia con un nuovo livello, non e' continuazione
                const nextUpper = nextCode.trim().toUpperCase();
                if (/^\d{1,2}\s+/.test(nextUpper)) break;
                fullStmt += ' ' + nextCode.trim();
                j++;
                if (fullStmt.trimEnd().endsWith('.')) break;
            }
        }

        const fullUpper = fullStmt.toUpperCase();
        const hasPic = /(?<![A-Z0-9-])(PIC|PICTURE)\s/.test(fullUpper);
        const hasRedefines = /\bREDEFINES\b/.test(fullUpper);
        const hasRenames = /\bRENAMES\b/.test(fullUpper);
        const hasIndex = /\bINDEX\b/.test(fullUpper);

        dataItems.push({ line: lineNum, level, name, hasPic, hasRedefines, hasRenames, hasIndex });
        i = j > i + 1 ? j : i + 1;
    }

    // Raccogli linee seguite da COPY (gruppo definito nella copybook)
    const linesFollowedByCopy = new Set();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        const upper = code.trim().toUpperCase();
        if (upper.startsWith('COPY ')) {
            // Cerca indietro il data item precedente
            for (let j = i - 1; j >= 0; j--) {
                if (isSkippable(lines[j])) continue;
                const prevCode = getCodeContent(lines[j]).trim();
                if (prevCode) { linesFollowedByCopy.add(j); break; }
            }
        }
    }

    for (let idx = 0; idx < dataItems.length; idx++) {
        const item = dataItems[idx];
        if (item.name === 'FILLER') continue;
        if (item.level === 88 || item.level === 66) continue;
        if (item.hasRenames || item.hasIndex || item.hasPic) continue;

        // Se seguito da COPY, e' un gruppo la cui struttura e' nella copybook
        if (linesFollowedByCopy.has(item.line)) continue;

        // Verifica se e' un gruppo
        let isGroup = false;
        if (idx + 1 < dataItems.length) {
            const nextLevel = dataItems[idx + 1].level;
            if (nextLevel !== 88 && nextLevel > item.level) isGroup = true;
        }
        if (isGroup) continue;
        if (item.hasRedefines && idx + 1 < dataItems.length && dataItems[idx + 1].level > item.level) continue;

        diags.push(makeDiag(item.line, cfg.severity, 'pic-missing',
            `Variabile '${item.name}' senza clausola PIC (livello ${String(item.level).padStart(2, '0')} elementare richiede PIC)`));
    }
    return diags;
}

// ---------------------------------------------------------------------------
// mismatched-copy
// ---------------------------------------------------------------------------
function checkMismatchedCopy(lines, workspaceRoot) {
    const cfg = getRuleConfig('mismatched-copy');
    if (!cfg.enabled || !workspaceRoot) return [];
    const diags = [];

    const config = vscode.workspace.getConfiguration('cobolLens');
    const folders = config.get('copyFolders', ['Copy', 'Copy_DR', 'Copy_Prod']);
    const ignoredCopybooks = new Set(
        config.get('ignoredCopybooks', ['DFHBMSCA', 'DFHAID'])
            .map(name => String(name).trim().toUpperCase())
            .filter(Boolean)
    );

    // Costruisci set di copybook esistenti
    const existingCopies = new Set();
    for (const folder of folders) {
        const folderPath = path.join(workspaceRoot, folder);
        if (fs.existsSync(folderPath)) {
            try {
                for (const f of fs.readdirSync(folderPath)) {
                    existingCopies.add(f.toUpperCase());
                }
            } catch (e) { /* ignore */ }
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw).trim().toUpperCase();
        const copyMatch = code.match(/^\s*COPY\s+([A-Z0-9][\w-]*)/);
        if (copyMatch) {
            const copyName = copyMatch[1];
            if (ignoredCopybooks.has(copyName)) continue;
            if (!existingCopies.has(copyName)) {
                // Verifica anche con le estensioni configurate
                const resolved = resolveCopybookPath(copyName, workspaceRoot);
                if (!resolved) {
                    diags.push(makeDiag(i, cfg.severity, 'mismatched-copy',
                        `COPY '${copyName}' non trovata nelle cartelle configurate`));
                }
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// section-order
// ---------------------------------------------------------------------------
function checkSectionOrder(lines) {
    const cfg = getRuleConfig('section-order');
    if (!cfg.enabled) return [];
    const expectedOrder = [
        'IDENTIFICATION DIVISION', 'ENVIRONMENT DIVISION',
        'DATA DIVISION', 'PROCEDURE DIVISION'
    ];
    const found = [];
    const diags = [];

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw).trim().toUpperCase();
        for (const div of expectedOrder) {
            if (code.includes(div)) {
                found.push({ line: i, div });
                break;
            }
        }
    }

    for (let idx = 1; idx < found.length; idx++) {
        const currIdx = expectedOrder.indexOf(found[idx].div);
        const prevIdx = expectedOrder.indexOf(found[idx - 1].div);
        if (currIdx >= 0 && prevIdx >= 0 && currIdx <= prevIdx) {
            diags.push(makeDiag(found[idx].line, cfg.severity, 'section-order',
                `'${found[idx].div}' non nell'ordine corretto (deve venire dopo '${found[idx - 1].div}')`));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// perform-thru-order
// ---------------------------------------------------------------------------
function checkPerformThruOrder(lines) {
    const cfg = getRuleConfig('perform-thru-order');
    if (!cfg.enabled) return [];
    const diags = [];

    // Raccogli posizioni paragrafi
    const paraPositions = {};
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        if (code && !/^\s/.test(code)) {
            const upper = code.trim().toUpperCase().replace(/<[^>]*>/g, 'PLACEHOLDER');
            const paraMatch = upper.match(/^([A-Z0-9][\w-]*)\.\s*$/);
            if (paraMatch) paraPositions[paraMatch[1]] = i;
        }
    }

    // Cerca PERFORM ... THRU
    const ctx2 = new AnalysisContext();
    let performTarget = null;
    let performStart = 0;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx2.update(raw, code);
        if (!ctx2.inProcedure) continue;
        const upper = code.trim().toUpperCase();

        const perfMatch = /\bPERFORM\s+([A-Z0-9][\w-]*)/.exec(upper);
        if (perfMatch) {
            performTarget = perfMatch[1];
            performStart = i;
            const thruMatch = /\bTHRU\s+([A-Z0-9][\w-]*)/.exec(upper);
            if (thruMatch) {
                const thruTarget = thruMatch[1];
                if (performTarget in paraPositions && thruTarget in paraPositions) {
                    if (paraPositions[thruTarget] <= paraPositions[performTarget]) {
                        diags.push(makeDiag(i, cfg.severity, 'perform-thru-order',
                            `PERFORM ${performTarget} THRU ${thruTarget}: '${thruTarget}' deve essere definito DOPO '${performTarget}'`));
                    }
                }
                performTarget = null;
                continue;
            }
        }

        if (performTarget) {
            const thruMatch = /^\s*THRU\s+([A-Z0-9][\w-]*)/.exec(upper);
            if (thruMatch) {
                const thruTarget = thruMatch[1];
                if (performTarget in paraPositions && thruTarget in paraPositions) {
                    if (paraPositions[thruTarget] <= paraPositions[performTarget]) {
                        diags.push(makeDiag(performStart, cfg.severity, 'perform-thru-order',
                            `PERFORM ${performTarget} THRU ${thruTarget}: '${thruTarget}' deve essere definito DOPO '${performTarget}'`));
                    }
                }
                performTarget = null;
            } else if (upper.trim()) {
                performTarget = null;
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// empty-paragraph
// ---------------------------------------------------------------------------
function checkEmptyParagraph(lines) {
    const cfg = getRuleConfig('empty-paragraph');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    const paragraphs = []; // {name, startLine}

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        const upper = code.trim().toUpperCase();
        // Un paragrafo deve iniziare in Area A (primo carattere non-spazio del code)
        if (code && !/^\s/.test(code)) {
            const paraMatch = upper.match(/^([A-Z0-9][\w-]*)\.\s*$/);
            if (paraMatch) paragraphs.push({ name: paraMatch[1], startLine: i });
        }
    }

    for (let idx = 0; idx < paragraphs.length; idx++) {
        const { name, startLine } = paragraphs[idx];
        if (name.endsWith('-EX')) continue;
        const endLine = idx + 1 < paragraphs.length ? paragraphs[idx + 1].startLine : lines.length;
        let hasCode = false;
        for (let j = startLine; j < endLine; j++) {
            const raw = lines[j];
            if (isSkippable(raw)) continue;
            const code = getCodeContent(raw).trim().toUpperCase();
            if (!code) continue;
            if (code === 'EXIT.' || code === 'CONTINUE.') continue;
            if (/^[A-Z0-9][\w-]*\.\s*$/.test(code)) continue;
            hasCode = true;
            break;
        }
        if (!hasCode) {
            diags.push(makeDiag(startLine, cfg.severity, 'empty-paragraph',
                `Paragrafo '${name}' vuoto o contiene solo EXIT/CONTINUE`,
                undefined, undefined, name));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// consecutive-perform-spacing
// ---------------------------------------------------------------------------
function checkConsecutivePerformSpacing(lines) {
    const cfg = getRuleConfig('consecutive-perform-spacing');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    let lastPerformEnd = null;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isBlank(raw)) { lastPerformEnd = null; continue; }
        if (isComment(raw) || isSetDirective(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) { lastPerformEnd = null; continue; }
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;

        const upper = code.trim().toUpperCase();
        if (code && !/^\s/.test(code) && /^[A-Z0-9][\w-]*\.\s*$/.test(upper)) {
            lastPerformEnd = null;
            continue;
        }

        if (/^\s*PERFORM\s+[A-Z0-9][\w-]*/i.test(upper)) {
            if (lastPerformEnd !== null) {
                diags.push(makeDiag(i, cfg.severity, 'consecutive-perform-spacing',
                    'Manca una riga vuota prima di questa PERFORM (le PERFORM consecutive devono essere separate da una riga vuota)'));
            }
            lastPerformEnd = i;
            continue;
        }

        if (lastPerformEnd !== null && /^\s*THRU\b/.test(upper)) {
            lastPerformEnd = i;
            continue;
        }

        lastPerformEnd = null;
    }
    return diags;
}

// ---------------------------------------------------------------------------
// missing-file-status
// ---------------------------------------------------------------------------
function checkMissingFileStatus(lines) {
    const cfg = getRuleConfig('missing-file-status');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    let selectName = null;
    let selectLine = 0;
    let hasStatus = false;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inFileControl) continue;

        const upper = code.trim().toUpperCase();
        const selMatch = upper.match(/^\s*SELECT\s+([A-Z0-9][\w-]*)/);
        if (selMatch) {
            if (selectName && !hasStatus) {
                diags.push(makeDiag(selectLine, cfg.severity, 'missing-file-status',
                    `SELECT '${selectName}' senza clausola STATUS (usare FILE STATUS per gestire errori I/O)`));
            }
            selectName = selMatch[1];
            selectLine = i;
            hasStatus = /\bSTATUS\b/.test(upper);
        } else if (selectName) {
            if (/\bSTATUS\b/.test(upper)) hasStatus = true;
        }
    }
    if (selectName && !hasStatus) {
        diags.push(makeDiag(selectLine, cfg.severity, 'missing-file-status',
            `SELECT '${selectName}' senza clausola STATUS (usare FILE STATUS per gestire errori I/O)`));
    }
    return diags;
}

// ---------------------------------------------------------------------------
// missing-stop-run
// ---------------------------------------------------------------------------
function checkMissingStopRun(lines) {
    const cfg = getRuleConfig('missing-stop-run');
    if (!cfg.enabled) return [];
    const diags = [];
    let hasStop = false;
    let lastProcLine = 0;
    const ctx = new AnalysisContext();

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (ctx.inProcedure) {
            lastProcLine = i;
            const upper = code.trim().toUpperCase();
            if (/\bSTOP\s+RUN\b/.test(upper) || /\bGOBACK\b/.test(upper) ||
                /\bEXEC\s+CICS\s+RETURN\b/.test(upper)) hasStop = true;
        }
    }
    if (lastProcLine > 0 && !hasStop) {
        diags.push(makeDiag(lastProcLine, cfg.severity, 'missing-stop-run',
            'Il programma non contiene STOP RUN, GOBACK o EXEC CICS RETURN'));
    }
    return diags;
}

// ---------------------------------------------------------------------------
// and-or-if (IF spurio dopo AND/OR in condizione composta)
// ---------------------------------------------------------------------------
function checkAndOrIf(lines) {
    const cfg = getRuleConfig('and-or-if');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    let prevEndsWithConnector = false; // la riga precedente finiva con AND/OR

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) { prevEndsWithConnector = false; continue; }
        if (ctx.inExecBlock) { prevEndsWithConnector = false; continue; }

        const upper = code.trim().toUpperCase();

        // Stessa riga: AND IF / OR IF
        if (/\b(AND|OR)\s+IF\b/.test(upper)) {
            diags.push(makeDiag(i, cfg.severity, 'and-or-if',
                'IF non necessario dopo AND/OR in una condizione composta. Rimuovere IF.'));
        }
        // Riga precedente finiva con AND/OR e questa inizia con IF
        else if (prevEndsWithConnector && /^\s*IF\b/.test(upper)) {
            diags.push(makeDiag(i, cfg.severity, 'and-or-if',
                'IF non necessario dopo AND/OR in una condizione composta. Rimuovere IF.'));
        }

        // Aggiorna flag per riga successiva
        prevEndsWithConnector = /\b(AND|OR)\s*$/.test(upper);
    }
    return diags;
}

// ---------------------------------------------------------------------------
// Symbol collection helpers (per undefined/unused variable e paragraph)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers per redefines-size
// ---------------------------------------------------------------------------

/**
 * Calcola la dimensione in byte di una clausola PIC.
 * @param {string} pic
 * @param {string} usage
 * @returns {number}
 */
function computePicSize(pic, usage) {
    if (!pic) return 0;
    let p = pic.toUpperCase()
        .replace(/^S/, '')   // segno
        .replace(/V/g, '');  // virgola implicita, non occupa storage

    let digits = 0;
    let alphas = 0;
    let i = 0;
    while (i < p.length) {
        const ch = p[i];
        // Controlla ripetizione: X(8), 9(08)
        if (i + 1 < p.length && p[i + 1] === '(') {
            const end = p.indexOf(')', i + 1);
            if (end >= 0) {
                const count = parseInt(p.substring(i + 2, end), 10) || 1;
                if ('9ZP'.includes(ch)) digits += count;
                else if ('XAB'.includes(ch)) alphas += count;
                i = end + 1;
                continue;
            }
        }
        if ('9ZP'.includes(ch)) digits++;
        else if ('XAB'.includes(ch)) alphas++;
        i++;
    }

    const u = (usage || 'DISPLAY').toUpperCase().replace(/\s+/g, '-');
    switch (u) {
        case 'COMP-3':
        case 'PACKED-DECIMAL':
            return Math.ceil((digits + 1) / 2);
        case 'COMP':
        case 'COMP-4':
        case 'COMP-5':
        case 'BINARY':
            if (digits <= 4) return 2;
            if (digits <= 9) return 4;
            return 8;
        case 'COMP-1': return 4;
        case 'COMP-2': return 8;
        default: return digits + alphas;
    }
}

/**
 * Parsa le definizioni di variabili nella DATA DIVISION.
 * @param {string[]} lines
 * @returns {Array<{level:number, name:string, pic:string|null, usage:string, occurs:number, redefines:string|null, lineNum:number}>}
 */
function parseDataItems(lines) {
    const items = [];
    const ctx = new AnalysisContext();
    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        if (isSkippable(raw)) { i++; continue; }
        const code = getCodeContent(raw);
        if (!code.trim()) { i++; continue; }
        ctx.update(raw, code);
        if (!(ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection)) { i++; continue; }

        const upperCode = code.trim().toUpperCase();
        const levelMatch = upperCode.match(/^(\d{1,2})\s+(\S+)/);
        if (!levelMatch) { i++; continue; }

        const level = parseInt(levelMatch[1], 10);
        const name = levelMatch[2].replace(/\.$/, '').toUpperCase();
        const lineNum = i;

        // Accumula righe di continuazione fino al punto finale
        let fullStmt = code;
        let j = i + 1;
        if (!fullStmt.trimEnd().endsWith('.')) {
            while (j < lines.length) {
                if (isSkippable(lines[j])) { j++; continue; }
                const nextCode = getCodeContent(lines[j]);
                if (!nextCode.trim()) { j++; continue; }
                fullStmt += ' ' + nextCode.trim();
                j++;
                if (fullStmt.trimEnd().endsWith('.')) break;
            }
        }
        i = j;

        const upper = fullStmt.toUpperCase();

        // PIC
        const picMatch = upper.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?([^\s,]+)/);
        const pic = picMatch ? picMatch[1].replace(/\.$/, '') : null;

        // USAGE (cercare solo DOPO il nome variabile per evitare match in nomi come WS-COMP-AREA)
        let usage = 'DISPLAY';
        const usageKw = upper.match(/\bUSAGE\s+(?:IS\s+)?(COMP(?:-[0-9])?|BINARY|PACKED-DECIMAL|DISPLAY(?:-1)?)/);
        if (usageKw) {
            usage = usageKw[1];
        } else {
            // Cerca COMP/BINARY/PACKED-DECIMAL solo dopo il nome (non dentro nomi iphenati)
            const inlineUsage = upper.match(/(?<![-A-Z])\b(COMP(?:-[0-9])?|BINARY|PACKED-DECIMAL)\b(?![-A-Z])/);
            if (inlineUsage) usage = inlineUsage[1];
        }

        // OCCURS (escludi match in nomi variabile come W-N-OCCURS)
        const occursMatch = upper.match(/(?:^|\s)OCCURS\s+(\d+)/);
        const occurs = occursMatch ? parseInt(occursMatch[1], 10) : 1;

        // REDEFINES (escludi match in nomi variabile come WS-REDEFINES-X)
        const redefMatch = upper.match(/(?:^|\s)REDEFINES\s+([A-Z][A-Z0-9-]*)/);
        const redefines = redefMatch ? redefMatch[1] : null;

        items.push({ level, name, pic, usage, occurs, redefines, lineNum });
    }
    return items;
}

/**
 * Calcola la dimensione in byte di un item (elementare o gruppo).
 * @param {Array} items
 * @param {number} idx
 * @returns {number}
 */
function computeItemSize(items, idx) {
    const item = items[idx];
    if (item.pic) {
        return computePicSize(item.pic, item.usage) * item.occurs;
    }
    // Gruppo: somma i figli diretti (ricorsivamente) per gestire OCCURS annidati,
    // saltando quelli con REDEFINES perche' sovrappongono spazio gia' contato.
    let size = 0;
    const groupLevel = item.level;
    let k = idx + 1;
    while (k < items.length) {
        if (items[k].level <= groupLevel) break;
        // Livelli 77 e 66 non sono mai subordinati a un gruppo
        if (items[k].level === 77 || items[k].level === 66) break;
        // Item con REDEFINES: non contribuisce alla dimensione, salta il suo sotto-albero
        if (items[k].redefines) {
            const redefLevel = items[k].level;
            k++;
            while (k < items.length && items[k].level > redefLevel) k++;
            continue;
        }
        if (items[k].pic) {
            size += computePicSize(items[k].pic, items[k].usage) * items[k].occurs;
            k++;
        } else {
            // Sotto-gruppo: calcola ricorsivamente (tiene conto di OCCURS annidati)
            size += computeItemSize(items, k);
            const subLevel = items[k].level;
            k++;
            while (k < items.length && items[k].level > subLevel) k++;
        }
    }
    return size * item.occurs;
}

// ---------------------------------------------------------------------------
// redefines-size
// ---------------------------------------------------------------------------
function checkRedefinesSize(lines) {
    const cfg = getRuleConfig('redefines-size');
    if (!cfg.enabled) return [];
    const diags = [];

    const items = parseDataItems(lines);

    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (!item.redefines) continue;

        // Trova il nome originale (cerca a ritroso: l'originale precede sempre il REDEFINES)
        let origIdx = -1;
        for (let k = idx - 1; k >= 0; k--) {
            if (items[k].name === item.redefines) { origIdx = k; break; }
        }
        if (origIdx < 0) continue;

        const origSize = computeItemSize(items, origIdx);
        const redefSize = computeItemSize(items, idx);

        if (origSize > 0 && redefSize > 0 && origSize !== redefSize) {
            diags.push(makeDiag(item.lineNum, cfg.severity, 'redefines-size',
                `REDEFINES: '${item.redefines}' occupa ${origSize} byte, la ridefinizione occupa ${redefSize} byte (devono coincidere)`,
                undefined, undefined, item.name));
        }
    }
    return diags;
}

/** Parole riservate COBOL estese */
const COBOL_RESERVED_EXTENDED = new Set([
    'ACCEPT', 'ACCESS', 'ADD', 'ADVANCING', 'AFTER', 'ALL', 'ALPHABET',
    'ALPHABETIC', 'ALPHABETIC-LOWER', 'ALPHABETIC-UPPER', 'ALPHANUMERIC',
    'ALSO', 'ALTER', 'ALTERNATE', 'AND', 'ANY', 'ARE', 'AREA', 'AREAS',
    'ASCENDING', 'ASSIGN', 'AT', 'AUTHOR',
    'BEFORE', 'BINARY', 'BLANK', 'BLOCK', 'BOTTOM', 'BY',
    'CALL', 'CANCEL', 'CHARACTER', 'CHARACTERS', 'CLASS', 'CLOSE',
    'COBOL', 'CODE', 'COLLATING', 'COMMA', 'COMMIT', 'COMMON',
    'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5',
    'COMPUTATIONAL', 'COMPUTATIONAL-1', 'COMPUTATIONAL-2', 'COMPUTATIONAL-3',
    'COMPUTATIONAL-4', 'COMPUTATIONAL-5',
    'COMPUTE', 'CONFIGURATION', 'CONTAINS', 'CONTENT', 'CONTINUE',
    'CONTROL', 'CONVERTING', 'COPY', 'CORR', 'CORRESPONDING', 'COUNT',
    'CURRENCY',
    'DATA', 'DATE', 'DATE-COMPILED', 'DATE-WRITTEN', 'DAY', 'DAY-OF-WEEK',
    'DEBUGGING', 'DECIMAL-POINT', 'DECLARATIVES',
    'DELETE', 'DELIMITED', 'DELIMITER', 'DEPENDING', 'DESCENDING',
    'DISPLAY', 'DIVIDE', 'DIVISION', 'DOWN',
    'DUPLICATES', 'DYNAMIC',
    'ELSE', 'END', 'END-ADD', 'END-CALL', 'END-COMPUTE', 'END-DELETE',
    'END-DISPLAY', 'END-DIVIDE', 'END-EVALUATE', 'END-IF', 'END-INVOKE',
    'END-MULTIPLY', 'END-OF-PAGE', 'END-PERFORM', 'END-READ',
    'END-RECEIVE', 'END-RETURN', 'END-REWRITE', 'END-SEARCH',
    'END-START', 'END-STRING', 'END-SUBTRACT', 'END-UNSTRING', 'END-WRITE',
    'ENTER', 'ENTRY', 'ENVIRONMENT', 'EQUAL', 'EQUALS', 'ERROR',
    'EVALUATE', 'EVERY', 'EXCEPTION', 'EXIT', 'EXTEND', 'EXTERNAL',
    'FALSE', 'FD', 'FILE', 'FILE-CONTROL', 'FILLER', 'FINAL', 'FIRST',
    'FOOTING', 'FOR', 'FROM', 'FUNCTION',
    'GENERATE', 'GIVING', 'GLOBAL', 'GO', 'GOBACK', 'GREATER', 'GROUP',
    'HEADING', 'HIGH-VALUE', 'HIGH-VALUES',
    'ID', 'IDENTIFICATION', 'IF', 'IN', 'INDEX', 'INDEXED', 'INDICATE',
    'INITIAL', 'INITIALIZE', 'INITIATE', 'INPUT', 'INPUT-OUTPUT',
    'INSPECT', 'INTO', 'INVALID', 'INVOKE', 'IS',
    'JUST', 'JUSTIFIED',
    'KEY',
    'LABEL', 'LAST', 'LEADING', 'LEFT', 'LENGTH', 'LESS', 'LIMIT',
    'LIMITS', 'LINE', 'LINE-COUNTER', 'LINES', 'LINKAGE',
    'LOCK', 'LOW-VALUE', 'LOW-VALUES',
    'MEMORY', 'MERGE', 'MODE',
    'MOVE', 'MULTIPLE', 'MULTIPLY',
    'NATIVE', 'NEGATIVE', 'NEXT', 'NO', 'NOT', 'NULL', 'NULLS', 'NUMBER',
    'NUMERIC', 'NUMERIC-EDITED',
    'OBJECT', 'OBJECT-COMPUTER', 'OCCURS', 'OF', 'OFF', 'OMITTED', 'ON',
    'OPEN', 'OPTIONAL', 'OR', 'ORDER', 'ORGANIZATION', 'OTHER', 'OUTPUT',
    'OVERFLOW',
    'PACKED-DECIMAL', 'PADDING', 'PAGE', 'PAGE-COUNTER', 'PERFORM',
    'PIC', 'PICTURE', 'PLUS', 'POINTER', 'POSITION', 'POSITIVE',
    'PROCEDURE', 'PROCEDURES', 'PROCEED', 'PROGRAM', 'PROGRAM-ID',
    'QUOTE', 'QUOTES',
    'RANDOM', 'RD', 'READ', 'RECEIVE', 'RECORD', 'RECORDS',
    'REDEFINES', 'REEL', 'REFERENCE', 'RELATIVE',
    'RELEASE', 'REMAINDER', 'RENAMES', 'REPLACE',
    'REPLACING', 'REPORT', 'REPORTS', 'REPOSITORY',
    'RESERVE', 'RESET', 'RETURN', 'RETURN-CODE',
    'RETURNING', 'REVERSED', 'REWRITE', 'RIGHT', 'ROLLBACK',
    'ROUNDED', 'RUN',
    'SAME', 'SD', 'SEARCH', 'SECTION', 'SECURITY', 'SEGMENT',
    'SELECT', 'SELF', 'SEND', 'SENTENCE', 'SEPARATE',
    'SEQUENCE', 'SEQUENTIAL', 'SET', 'SIGN',
    'SIZE', 'SORT', 'SORT-RETURN', 'SOURCE', 'SOURCE-COMPUTER',
    'SPACE', 'SPACES', 'SPECIAL-NAMES', 'STANDARD',
    'START', 'STATUS', 'STOP', 'STRING',
    'SUBTRACT', 'SUM', 'SUPER', 'SUPPRESS', 'SYNC', 'SYNCHRONIZED',
    'TABLE', 'TALLY', 'TALLYING', 'TAPE', 'TERMINAL', 'TERMINATE',
    'TEST', 'THAN', 'THEN', 'THROUGH', 'THRU', 'TIME', 'TIMES',
    'TITLE', 'TO', 'TOP', 'TRAILING', 'TRUE', 'TYPE',
    'UNIT', 'UNLOCK', 'UNSTRING', 'UNTIL', 'UP', 'UPON',
    'USAGE', 'USE', 'USING',
    'VALUE', 'VALUES', 'VARYING',
    'WHEN', 'WITH', 'WORDS', 'WORKING-STORAGE', 'WRITE',
    'ZERO', 'ZEROES', 'ZEROS',
    // EXEC CICS / EXEC SQL keywords
    'EXEC', 'END-EXEC', 'CICS', 'SQL',
    'ABEND', 'ABCODE', 'ASKTIME', 'ASSIGN', 'CANCEL',
    'COMMAREA', 'CHANNEL', 'CONTAINER', 'CONVID',
    'DELETEQ', 'DEQUEUE', 'DFHCOMMAREA', 'DFHRESP',
    'EIBCALEN', 'EIBAID', 'EIBTRNID', 'EIBTRMID', 'ENDBR', 'ENQUEUE',
    'FORMATTIME', 'FREEMAIN', 'GETMAIN', 'HANDLE',
    'IGNORE', 'INVOKINGPROG', 'ISSUE',
    'JOURNAL', 'KEYLENGTH', 'LINK', 'LOAD',
    'MAPSET', 'NOHANDLE', 'NOQUEUE',
    'PROGRAM', 'PUSH', 'POP',
    'QUEUE', 'READQ', 'READNEXT', 'READPREV', 'RELEASE', 'RESETBR',
    'RESP', 'RESP2', 'RETRIEVE', 'RIDFLD', 'ROLLBACK',
    'SEND', 'STARTBR', 'SUSPEND', 'SYNCPOINT',
    'TRANSID', 'TS', 'TD',
    'WAIT', 'WRITEQ', 'XCTL',
    // COBOL open modes e Micro Focus special registers
    'I-O', 'TIME-OF-DAY', 'WHEN-COMPILED', 'LINAGE-COUNTER'
]);

/**
 * Raccoglie nomi variabili/record definiti nel programma.
 * @param {string[]} lines
 * @param {boolean} isCopy
 * @returns {Set<string>}
 */
function collectDefinedSymbols(lines, isCopy) {
    const symbols = new Set();
    const ctx = new AnalysisContext();

    for (const line of lines) {
        const raw = line;
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        if (!isCopy) ctx.update(raw, code);
        const upper = code.trim().toUpperCase();

        if (ctx.inFileControl) {
            const selMatch = upper.match(/^\s*SELECT\s+(\S+)/);
            if (selMatch) symbols.add(selMatch[1]);
            const statMatch = /\bSTATUS\s+(\S+)/.exec(upper);
            if (statMatch) {
                const n = statMatch[1].replace(/\.$/, '');
                if (n && !COBOL_RESERVED_EXTENDED.has(n)) symbols.add(n);
            }
            const rkMatch = /\bRECORD\s+KEY\s+(\S+)/.exec(upper);
            if (rkMatch) {
                const n = rkMatch[1].replace(/\.$/, '');
                if (n && !COBOL_RESERVED_EXTENDED.has(n)) symbols.add(n);
            }
            continue;
        }

        if (ctx.inFileSection) {
            const fdMatch = upper.match(/^\s*FD\s+(\S+)/);
            if (fdMatch) { symbols.add(fdMatch[1]); continue; }
            const sdMatch = upper.match(/^\s*SD\s+(\S+)/);
            if (sdMatch) { symbols.add(sdMatch[1]); continue; }
        }

        if (isCopy || ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection) {
            const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
            if (levelMatch) {
                const name = levelMatch[2].replace(/\.$/, '');
                if (name !== 'FILLER') symbols.add(name);
            }
        }
    }
    return symbols;
}

/**
 * Raccoglie nomi di paragrafi nella PROCEDURE DIVISION.
 * @param {string[]} lines
 * @returns {Map<string, number>} nome -> line_num (0-based)
 */
function collectParagraphs(lines) {
    const paras = new Map();
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        // Un paragrafo deve iniziare in Area A (primo carattere non-spazio del code)
        if (code && !/^\s/.test(code)) {
            const upper = code.trim().toUpperCase().replace(/<[^>]*>/g, 'PLACEHOLDER');
            const paraMatch = upper.match(/^([A-Z0-9][\w-]*)\./);
            if (paraMatch && !COBOL_RESERVED_EXTENDED.has(paraMatch[1]) && !upper.includes(' SECTION')) {
                paras.set(paraMatch[1], i);
            }
        }
    }
    return paras;
}

/**
 * Raccoglie target dei PERFORM.
 * @param {string[]} lines
 * @returns {Array<{line: number, target: string}>}
 */
function collectPerformTargets(lines) {
    const targets = [];
    const ctx = new AnalysisContext();
    let pendingPerformLine = -1; // riga del PERFORM in attesa di THRU su riga successiva
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        const upper = code.trim().toUpperCase().replace(/<[^>]*>/g, 'PLACEHOLDER');

        // Controlla se la riga e' un THRU di continuazione da un PERFORM precedente
        if (pendingPerformLine >= 0) {
            const thruCont = /^\s*THRU\s+([A-Z0-9][A-Z0-9-]*[A-Z0-9])/.exec(upper);
            if (thruCont) {
                targets.push({ line: pendingPerformLine, target: thruCont[1] });
            }
            pendingPerformLine = -1;
            if (thruCont) continue;
        }

        const perfMatch = upper.match(/^\s*PERFORM\s+([A-Z0-9][A-Z0-9-]*[A-Z0-9])/);
        if (perfMatch) {
            const target = perfMatch[1];
            if (!COBOL_RESERVED_EXTENDED.has(target) && !/^\d+$/.test(target)) {
                targets.push({ line: i, target });
            }
            const thruMatch = /\bTHRU\s+([A-Z0-9][A-Z0-9-]*[A-Z0-9])/.exec(upper);
            if (thruMatch) {
                targets.push({ line: i, target: thruMatch[1] });
            } else if (!upper.endsWith('.')) {
                // PERFORM senza THRU sulla stessa riga e senza punto: THRU potrebbe essere sulla riga successiva
                pendingPerformLine = i;
            }
        }
    }
    return targets;
}

/**
 * Estrae riferimenti a variabili nella PROCEDURE DIVISION.
 * @param {string[]} lines
 * @returns {Array<{line: number, name: string}>}
 */
function extractVariableRefs(lines) {
    const refs = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        if (ctx.inExecBlock) continue;

        const upper = code.trim().toUpperCase();
        if (code && !/^\s/.test(code) && /^[A-Z0-9][\w-]*\.\s*$/.test(upper)) continue;

        let cleaned = stripLiterals(upper);
        const inlinePos = cleaned.indexOf('*>');
        if (inlinePos >= 0) cleaned = cleaned.substring(0, inlinePos);
        cleaned = cleaned.replace(/<[^>]*>/g, ' ');
        cleaned = cleaned.replace(/\bFUNCTION\s+[A-Z][A-Z0-9-]*/g, ' ');
        cleaned = cleaned.replace(/\bPERFORM\s+([A-Z0-9][\w-]*)/g, 'PERFORM');
        cleaned = cleaned.replace(/\bTHRU\s+([A-Z0-9][\w-]*)/g, 'THRU');
        cleaned = cleaned.replace(/\bCOPY\s+([A-Z0-9][\w-]*)/g, 'COPY');
        cleaned = cleaned.replace(/[()]/g, ' ');

        const tokens = cleaned.match(/(?<![A-Z0-9-])([A-Z][A-Z0-9-]*[A-Z0-9])(?![A-Z0-9-])/g) || [];
        const shortTokens = cleaned.match(/(?<![A-Z0-9-])([A-Z][A-Z0-9])(?![A-Z0-9-])/g) || [];
        // Match single-char variable names (e.g. I, J, K)
        const singleCharTokens = cleaned.match(/(?<![A-Z0-9-])([A-Z])(?![A-Z0-9-])/g) || [];

        for (const token of [...tokens, ...shortTokens, ...singleCharTokens]) {
            if (COBOL_RESERVED_EXTENDED.has(token)) continue;
            refs.push({ line: i, name: token });
        }
    }
    return refs;
}

/**
 * Raccoglie nomi COPY dal sorgente.
 * @param {string[]} lines
 * @returns {string[]}
 */
function collectCopyNames(lines) {
    const copies = [];
    for (const line of lines) {
        if (isSkippable(line)) continue;
        const code = getCodeContent(line).trim().toUpperCase();
        const m = code.match(/^\s*COPY\s+([A-Z0-9][\w-]*)/);
        if (m) copies.push(m[1]);
    }
    return copies;
}

/**
 * Raccoglie COPY statements con le relative clausole REPLACING.
 * @param {string[]} lines
 * @returns {Array<{name: string, replacements: Array<{from: string, to: string}>}>}
 */
function collectCopyStatements(lines) {
    const copies = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw).trim().toUpperCase();
        const m = code.match(/^\s*COPY\s+([A-Z0-9][\w-]*)/);
        if (!m) continue;
        const copyName = m[1];

        // Accumula la COPY statement completa (potrebbe essere multi-riga)
        let fullStatement = raw;
        let endIdx = i;
        if (!raw.includes('.')) {
            for (let j = i + 1; j < lines.length; j++) {
                if (isComment(lines[j])) continue;
                fullStatement += ' ' + lines[j];
                endIdx = j;
                if (lines[j].includes('.')) break;
            }
        }

        // Estrai coppie REPLACING
        const replacements = [];
        const regex = new RegExp(REPLACING_PAIR_REGEX.source, 'gi');
        let match;
        while ((match = regex.exec(fullStatement)) !== null) {
            replacements.push({
                from: match[1].trim().toUpperCase(),
                to: match[2].trim().toUpperCase()
            });
        }

        copies.push({ name: copyName, replacements });
        i = endIdx;
    }
    return copies;
}

/**
 * Carica simboli da una copybook, applicando le sostituzioni REPLACING.
 * @param {string} copyName
 * @param {string} workspaceRoot
 * @param {Array<{from: string, to: string}>} [replacements]
 * @returns {Set<string>}
 */
function loadCopySymbols(copyName, workspaceRoot, replacements) {
    const resolved = resolveCopybookPath(copyName, workspaceRoot);
    if (!resolved) return new Set();
    try {
        const content = fs.readFileSync(resolved, 'utf-8');
        const copyLines = content.split(/\r?\n/);
        const symbols = collectDefinedSymbols(copyLines, true);
        if (!replacements || replacements.length === 0) return symbols;

        // Applica REPLACING ai nomi dei simboli
        const replaced = new Set();
        for (const sym of symbols) {
            let newName = sym;
            for (const repl of replacements) {
                if (newName.includes(repl.from)) {
                    newName = newName.replace(repl.from, repl.to);
                }
            }
            replaced.add(newName);
        }
        return replaced;
    } catch (e) {
        return new Set();
    }
}

/**
 * Raccoglie i nomi delle COPY nella PROCEDURE DIVISION.
 * @param {string[]} lines
 * @returns {string[]}
 */
function collectProcedureCopyNames(lines) {
    const copies = [];
    const ctx = new AnalysisContext();
    for (const line of lines) {
        if (isSkippable(line)) continue;
        const code = getCodeContent(line);
        if (!code.trim()) continue;
        ctx.update(line, code);
        if (!ctx.inProcedure) continue;
        const upper = code.trim().toUpperCase();
        const m = upper.match(/^\s*COPY\s+([A-Z0-9][\w-]*)/);
        if (m) copies.push(m[1]);
    }
    return copies;
}

/**
 * Carica paragrafi da una copybook di procedure.
 * @param {string} copyName
 * @param {string} workspaceRoot
 * @returns {Set<string>}
 */
function loadCopyParagraphs(copyName, workspaceRoot) {
    const resolved = resolveCopybookPath(copyName, workspaceRoot);
    if (!resolved) return new Set();
    try {
        const content = fs.readFileSync(resolved, 'utf-8');
        const copyLines = content.split(/\r?\n/);
        const paras = new Set();
        for (let i = 0; i < copyLines.length; i++) {
            const raw = copyLines[i];
            if (isSkippable(raw)) continue;
            const code = getCodeContent(raw);
            if (!code.trim()) continue;
            if (code && !/^\s/.test(code)) {
                const upper = code.trim().toUpperCase();
                const paraMatch = upper.match(/^([A-Z0-9][\w-]*)\s*\./);
                if (paraMatch && !COBOL_RESERVED_EXTENDED.has(paraMatch[1]) && !upper.includes(' SECTION')) {
                    paras.add(paraMatch[1]);
                }
            }
        }
        return paras;
    } catch (e) {
        return new Set();
    }
}

/**
 * Raccoglie nomi variabili con clausola OCCURS.
 * @param {string[]} lines
 * @param {boolean} isCopy
 * @returns {Set<string>}
 */
function collectOccursNames(lines, isCopy) {
    const occurs = new Set();
    const ctx = new AnalysisContext();
    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        if (isSkippable(raw)) { i++; continue; }
        const code = getCodeContent(raw);
        if (!code.trim()) { i++; continue; }
        if (!isCopy) ctx.update(raw, code);
        if (!isCopy && !(ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection)) { i++; continue; }
        const upper = code.trim().toUpperCase();
        const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
        if (!levelMatch) { i++; continue; }
        const name = levelMatch[2].replace(/\.$/, '');
        if (name === 'FILLER') { i++; continue; }
        let fullStmt = code;
        let j = i + 1;
        if (!fullStmt.trimEnd().endsWith('.')) {
            while (j < lines.length) {
                if (isSkippable(lines[j])) { j++; continue; }
                const nextCode = getCodeContent(lines[j]);
                if (!nextCode.trim()) { j++; continue; }
                fullStmt += ' ' + nextCode.trim();
                j++;
                if (fullStmt.trimEnd().endsWith('.')) break;
            }
        }
        i = j > i + 1 ? j : i + 1;
        if (/(?:^|\s)OCCURS\b/.test(fullStmt.toUpperCase())) {
            occurs.add(name);
        }
    }
    return occurs;
}

// ---------------------------------------------------------------------------
// invalid-column-7
// ---------------------------------------------------------------------------
function checkInvalidColumn7(lines) {
    const cfg = getRuleConfig('invalid-column-7');
    if (!cfg.enabled) return [];
    const diags = [];
    const validIndicators = new Set([' ', '*', '/', 'D', 'd', '-', '$']);
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (raw.length < 7) continue;
        if (isBlank(raw)) continue;
        if (isSetDirective(raw)) continue;
        const col7 = raw.charAt(6);
        if (!validIndicators.has(col7)) {
            diags.push(makeDiag(i, cfg.severity, 'invalid-column-7',
                `Carattere '${col7}' non valido in colonna 7 (ammessi: spazio, *, /, D, -, $)`,
                6, 7));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// unsubscripted-occurs
// ---------------------------------------------------------------------------
function checkUnsubscriptedOccurs(lines, workspaceRoot) {
    const cfg = getRuleConfig('unsubscripted-occurs');
    if (!cfg.enabled) return [];
    const diags = [];
    const occursVars = collectOccursNames(lines, false);
    const copyStmts = collectCopyStatements(lines);
    if (workspaceRoot) {
        for (const cs of copyStmts) {
            const resolved = resolveCopybookPath(cs.name, workspaceRoot);
            if (!resolved) continue;
            try {
                const content = fs.readFileSync(resolved, 'utf-8');
                const copyOccurs = collectOccursNames(content.split(/\r?\n/), true);
                for (let name of copyOccurs) {
                    // Applica REPLACING ai nomi OCCURS
                    for (const repl of cs.replacements) {
                        if (name.includes(repl.from)) {
                            name = name.replace(repl.from, repl.to);
                        }
                    }
                    occursVars.add(name);
                }
            } catch (e) { /* ignore */ }
        }
    }
    if (occursVars.size === 0) return diags;
    const ctx = new AnalysisContext();
    const reported = new Set();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        if (ctx.inExecBlock) continue;
        const upper = code.trim().toUpperCase();
        if (code && !/^\s/.test(code) && /^[A-Z0-9][\w-]*\.\s*$/.test(upper)) continue;
        if (/^\s*(SEARCH|SORT|INITIALIZE)\b/.test(upper)) continue;
        for (const varName of occursVars) {
            if (reported.has(varName)) continue;
            let searchFrom = 0;
            while (true) {
                const idx = upper.indexOf(varName, searchFrom);
                if (idx < 0) break;
                const before = idx > 0 ? upper.charAt(idx - 1) : ' ';
                const after = idx + varName.length < upper.length ? upper.charAt(idx + varName.length) : ' ';
                if (!/[A-Z0-9-]/.test(before) && !/[A-Z0-9-]/.test(after)) {
                    const afterRef = upper.substring(idx + varName.length).trimStart();
                    if (!afterRef.startsWith('(')) {
                        // Controlla se il subscript e' sulla riga successiva
                        let hasSubscriptNextLine = false;
                        for (let ni = i + 1; ni < lines.length; ni++) {
                            if (isSkippable(lines[ni])) continue;
                            const nextCode = getCodeContent(lines[ni]);
                            if (!nextCode.trim()) continue;
                            hasSubscriptNextLine = nextCode.trim().toUpperCase().startsWith('(');
                            break;
                        }
                        if (!hasSubscriptNextLine) {
                            diags.push(makeDiag(i, cfg.severity, 'unsubscripted-occurs',
                                `Variabile '${varName}' ha clausola OCCURS e richiede un indice o subscript`,
                                undefined, undefined, varName));
                            reported.add(varName);
                            break;
                        }
                    }
                }
                searchFrom = idx + varName.length;
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// undefined-variable
// ---------------------------------------------------------------------------
function checkUndefinedVariables(lines, workspaceRoot) {
    const cfg = getRuleConfig('undefined-variable');
    if (!cfg.enabled) return [];
    const diags = [];

    const defined = collectDefinedSymbols(lines, false);
    const copyStmts = collectCopyStatements(lines);
    if (workspaceRoot) {
        for (const cs of copyStmts) {
            const copySyms = loadCopySymbols(cs.name, workspaceRoot, cs.replacements);
            for (const s of copySyms) defined.add(s);
        }
    }
    const paragraphs = collectParagraphs(lines);
    for (const p of paragraphs.keys()) defined.add(p);

    const refs = extractVariableRefs(lines);
    const reported = new Set();

    for (const { line, name } of refs) {
        if (!defined.has(name) && !reported.has(name)) {
            diags.push(makeDiag(line, cfg.severity, 'undefined-variable',
                `Variabile '${name}' non definita nel programma ne' nelle copy utilizzate`,
                undefined, undefined, name));
            reported.add(name);
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// undefined-paragraph
// ---------------------------------------------------------------------------
function checkUndefinedParagraph(lines, workspaceRoot) {
    const cfg = getRuleConfig('undefined-paragraph');
    if (!cfg.enabled) return [];
    const diags = [];
    const defined = collectParagraphs(lines);
    if (workspaceRoot) {
        const procCopies = collectProcedureCopyNames(lines);
        for (const cn of procCopies) {
            const copyParas = loadCopyParagraphs(cn, workspaceRoot);
            for (const name of copyParas) {
                if (!defined.has(name)) defined.set(name, -1);
            }
        }
    }
    const targets = collectPerformTargets(lines);
    const reported = new Set();

    for (const { line, target } of targets) {
        if (!defined.has(target) && !reported.has(target)) {
            diags.push(makeDiag(line, cfg.severity, 'undefined-paragraph',
                `PERFORM verso paragrafo '${target}' non definito nel programma`,
                undefined, undefined, target));
            reported.add(target);
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// unused-paragraph
// ---------------------------------------------------------------------------
function checkUnusedParagraph(lines) {
    const cfg = getRuleConfig('unused-paragraph');
    if (!cfg.enabled) return [];
    const diags = [];
    const defined = collectParagraphs(lines);
    const targets = collectPerformTargets(lines);
    const called = new Set(targets.map(t => t.target));
    const minLine = Math.min(...defined.values());

    for (const [name, line] of defined) {
        if (called.has(name)) continue;
        if (name.endsWith('-EX')) continue;
        if (line === minLine) continue;
        diags.push(makeDiag(line, cfg.severity, 'unused-paragraph',
            `Paragrafo '${name}' definito ma mai richiamato da una PERFORM`,
            undefined, undefined, name));
    }
    return diags;
}

// ---------------------------------------------------------------------------
// unused-variable
// ---------------------------------------------------------------------------
function checkUnusedVariable(lines, workspaceRoot) {
    const cfg = getRuleConfig('unused-variable');
    if (!cfg.enabled) return [];
    const diags = [];

    // Raccoglie variabili WS con riga e livello
    const wsVars = new Map(); // name -> {line, level}
    const wsGroupChildren = new Map(); // group01 -> [childNames]
    let currentGroup = null;
    const ctx = new AnalysisContext();

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inWorkingStorage) continue;
        const upper = code.trim().toUpperCase();
        const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
        if (!levelMatch) continue;
        const level = parseInt(levelMatch[1], 10);
        const name = levelMatch[2].replace(/\.$/, '');
        if (name === 'FILLER') continue;
        wsVars.set(name, { line: i, level });
        if (level === 1) {
            currentGroup = name;
            wsGroupChildren.set(name, []);
        } else if (currentGroup && level > 1) {
            const children = wsGroupChildren.get(currentGroup);
            if (children) children.push(name);
        }
    }

    if (wsVars.size === 0) return diags;

    // Riferimenti nella PROCEDURE
    const procRefs = new Set(extractVariableRefs(lines).map(r => r.name));

    for (const [name, { line, level }] of wsVars) {
        if (procRefs.has(name)) continue;
        if (level === 88) continue;

        // Livello 01 gruppo: non segnalare se un figlio e' usato
        if (level === 1 && wsGroupChildren.has(name)) {
            const children = wsGroupChildren.get(name);
            if (children.length > 0 && children.some(c => procRefs.has(c))) continue;
        }

        // Sotto-campo: non segnalare se il padre 01 e' usato
        if (level > 1) {
            let parentUsed = false;
            for (const [grp, children] of wsGroupChildren) {
                if (children.includes(name) && procRefs.has(grp)) {
                    parentUsed = true;
                    break;
                }
            }
            if (parentUsed) continue;
        }

        // Variabile 01 standalone o sotto-campo non usato
        if (level === 1) {
            const children = wsGroupChildren.get(name) || [];
            if (children.length > 0) continue; // gruppo con figli, non segnalare il padre
        }

        diags.push(makeDiag(line, cfg.severity, 'unused-variable',
            `Variabile '${name}' definita in WORKING-STORAGE ma mai utilizzata nella PROCEDURE DIVISION`,
            undefined, undefined, name));
    }
    return diags;
}

// ---------------------------------------------------------------------------
// duplicate-variable
// ---------------------------------------------------------------------------
function checkDuplicateVariable(lines, workspaceRoot) {
    const cfg = getRuleConfig('duplicate-variable');
    if (!cfg.enabled) return [];
    const diags = [];

    // Rileva blocchi $IF/$ELSE/$END per le definizioni condizionali
    // Le variabili definite in rami diversi di $IF/$ELSE non sono duplicati
    const conditionalLines = new Set(); // righe dentro blocchi $IF/$ELSE/$END
    const ifElseRanges = []; // [{ifStart, elseStart, endLine}]
    let currentIfStart = -1;
    let currentElseStart = -1;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.replace(/^.{0,6}/, '').trim().toUpperCase();
        if (/^\$IF\b/.test(trimmed)) {
            currentIfStart = i;
            currentElseStart = -1;
        } else if (/^\$ELSE\b/.test(trimmed) && currentIfStart >= 0) {
            currentElseStart = i;
        } else if (/^\$END\b/.test(trimmed) && currentIfStart >= 0) {
            ifElseRanges.push({ ifStart: currentIfStart, elseStart: currentElseStart, endLine: i });
            for (let j = currentIfStart; j <= i; j++) conditionalLines.add(j);
            currentIfStart = -1;
            currentElseStart = -1;
        }
    }

    // Definizioni dal programma
    const progDefs = new Map(); // name -> [line, ...]
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection) {
            const upper = code.trim().toUpperCase();
            const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
            if (levelMatch) {
                const name = levelMatch[2].replace(/\.$/, '');
                if (name === 'FILLER') continue;
                const list = progDefs.get(name) || [];
                list.push(i);
                progDefs.set(name, list);
            }
        }
    }

    // Helper: verifica se due righe sono in rami diversi dello stesso $IF/$ELSE/$END
    function areInDifferentBranches(line1, line2) {
        for (const range of ifElseRanges) {
            if (range.elseStart < 0) continue; // niente $ELSE, non e' un caso di rami diversi
            const inIfBranch1 = line1 > range.ifStart && line1 < (range.elseStart >= 0 ? range.elseStart : range.endLine);
            const inElseBranch1 = range.elseStart >= 0 && line1 > range.elseStart && line1 < range.endLine;
            const inIfBranch2 = line2 > range.ifStart && line2 < (range.elseStart >= 0 ? range.elseStart : range.endLine);
            const inElseBranch2 = range.elseStart >= 0 && line2 > range.elseStart && line2 < range.endLine;
            if ((inIfBranch1 && inElseBranch2) || (inElseBranch1 && inIfBranch2)) return true;
        }
        return false;
    }

    // Definizioni dalle copy
    const copyVarSources = new Map(); // name -> [copyName, ...]
    const copyStmts = collectCopyStatements(lines);

    if (workspaceRoot) {
        for (const cs of copyStmts) {
            const copySyms = loadCopySymbols(cs.name, workspaceRoot, cs.replacements);
            for (const sym of copySyms) {
                const list = copyVarSources.get(sym) || [];
                list.push(cs.name);
                copyVarSources.set(sym, list);
            }
        }
    }

    // 1. Duplicati nel programma
    for (const [name, lineList] of progDefs) {
        if (lineList.length > 1) {
            for (let k = 1; k < lineList.length; k++) {
                // Salta se le definizioni duplicate sono in rami diversi di $IF/$ELSE/$END
                let isConditionalDup = false;
                for (let m = 0; m < k; m++) {
                    if (areInDifferentBranches(lineList[m], lineList[k])) {
                        isConditionalDup = true;
                        break;
                    }
                }
                if (isConditionalDup) continue;

                let msg = `Variabile '${name}' definita piu' volte nel programma (prima definizione a riga ${lineList[0] + 1})`;
                if (copyVarSources.has(name)) {
                    msg += ` e anche in ${copyVarSources.get(name).join(', ')}`;
                }
                diags.push(makeDiag(lineList[k], cfg.severity, 'duplicate-variable', msg,
                    undefined, undefined, name));
            }
        }
    }

    // 2. Definita nel programma E in una copy
    for (const [name, lineList] of progDefs) {
        if (lineList.length > 1) continue;
        if (copyVarSources.has(name)) {
            const copies = copyVarSources.get(name);
            diags.push(makeDiag(lineList[0], cfg.severity, 'duplicate-variable',
                `Variabile '${name}' definita nel programma a riga ${lineList[0] + 1} e anche in ${copies.join(', ')}`,
                undefined, undefined, name));
        }
    }

    // 3. Definita in piu' copy diverse
    for (const [name, copies] of copyVarSources) {
        if (progDefs.has(name)) continue;
        if (copies.length > 1) {
            const stmtLine = copyStmtLines.get(copies[0]) || 0;
            diags.push(makeDiag(stmtLine, cfg.severity, 'duplicate-variable',
                `Variabile '${name}' definita in piu' copy: ${copies.join(', ')}`,
                undefined, undefined, name));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// variable-name-length (max 30 caratteri in Micro Focus COBOL)
// ---------------------------------------------------------------------------
function checkVariableNameLength(lines) {
    const cfg = getRuleConfig('variable-name-length');
    if (!cfg.enabled) return [];
    const MAX_NAME_LENGTH = 30;
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!(ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection)) continue;
        const upper = code.trim().toUpperCase();
        const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
        if (levelMatch) {
            const name = levelMatch[2].replace(/\.$/, '');
            if (name === 'FILLER') continue;
            if (name.length > MAX_NAME_LENGTH) {
                diags.push(makeDiag(i, cfg.severity, 'variable-name-length',
                    `Nome variabile '${name}' troppo lungo (${name.length} caratteri, massimo consentito: ${MAX_NAME_LENGTH})`,
                    undefined, undefined, name));
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// missing-level (variabile senza livello nella DATA DIVISION)
// ---------------------------------------------------------------------------
function checkMissingLevel(lines) {
    const cfg = getRuleConfig('missing-level');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    let prevLineHasPeriod = true; // assume inizio

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!(ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection)) {
            prevLineHasPeriod = true;
            continue;
        }

        const upper = code.trim().toUpperCase();

        // Skip COPY, FD, SD, directives
        if (upper.startsWith('COPY ') || upper.startsWith('FD ') ||
            upper.startsWith('SD ') || upper.includes('SECTION')) {
            prevLineHasPeriod = stripLiterals(upper).includes('.');
            continue;
        }

        // Se la riga precedente non ha un punto, questa potrebbe essere continuazione
        if (!prevLineHasPeriod) {
            prevLineHasPeriod = stripLiterals(upper).includes('.');
            continue;
        }

        // Se inizia con un numero di livello, OK
        if (/^\s*\d{1,2}\s+/.test(upper)) {
            prevLineHasPeriod = stripLiterals(upper).includes('.');
            continue;
        }

        // Se inizia con un nome variabile (lettera) senza livello, errore
        if (/^[A-Z][A-Z0-9-]*/.test(upper)) {
            // Verifica che non sia una keyword di continuazione (VALUE, PIC, OCCURS, etc.)
            const firstWord = upper.split(/\s+/)[0].replace(/\.$/, '');
            if (!COBOL_RESERVED_EXTENDED.has(firstWord)) {
                diags.push(makeDiag(i, cfg.severity, 'missing-level',
                    `Definizione variabile '${firstWord}' senza numero di livello (01-49, 66, 77, 88)`,
                    undefined, undefined, firstWord));
            }
        }

        prevLineHasPeriod = stripLiterals(upper).includes('.');
    }
    return diags;
}

// ---------------------------------------------------------------------------
// chars-after-period (contenuto dopo il punto terminatore)
// ---------------------------------------------------------------------------
function checkCharsAfterPeriod(lines) {
    const cfg = getRuleConfig('chars-after-period');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();

    const idDivisionClauses = new Set([
        'PROGRAM-ID', 'AUTHOR', 'INSTALLATION', 'DATE-WRITTEN',
        'DATE-COMPILED', 'SECURITY', 'REMARKS'
    ]);

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);

        const upperCode = code.toUpperCase();

        // In IDENTIFICATION DIVISION sono valide righe tipo:
        // PROGRAM-ID. NOME.
        // AUTHOR. COGNOME.
        const idClauseMatch = upperCode.trim().match(/^([A-Z-]+)\./);
        const isValidIdClauseLine =
            ctx.currentDivision === 'IDENTIFICATION' &&
            !!idClauseMatch &&
            idDivisionClauses.has(idClauseMatch[1]);

        // 1) Se c'e' un punto nella parte di codice, dopo il punto devono esserci solo spazi.
        if (!isValidIdClauseLine) {
            const codeNoLit = stripLiterals(upperCode);
            const periodIdx = codeNoLit.indexOf('.');
            if (periodIdx >= 0) {
                const afterPeriodRaw = codeNoLit.substring(periodIdx + 1);
                if (/\S/.test(afterPeriodRaw)) {
                    const nonSpaceOffset = afterPeriodRaw.search(/\S/);
                    const colStart = 7 + periodIdx + 1 + (nonSpaceOffset >= 0 ? nonSpaceOffset : 0);
                    const colEnd = colStart + 1;
                    diags.push(makeDiag(i, cfg.severity, 'chars-after-period',
                        'Contenuto non valido dopo il punto terminatore della riga COBOL',
                        colStart, colEnd));
                }
            }
        }

        // 2) In variable/free intercetta code tail tipico da formato fixed
        // (es. spazi + 8 cifre + punto finale), che genera token non validi.
        if (currentSourceFormat !== 'fixed') {
            const tailLikeSequence = upperCode.match(/\s{2,}\d{6,8}\s*\.?\s*$/);
            if (tailLikeSequence) {
                const startIdx = tailLikeSequence.index || 0;
                const colStart = 7 + startIdx;
                const colEnd = 7 + upperCode.length;
                diags.push(makeDiag(i, cfg.severity, 'chars-after-period',
                    'Possibile numero di sequenza non valido in coda alla riga (formato fixed usato in sourceformat variable/free)',
                    colStart, colEnd));
            }
        }

    }
    return diags;
}

// ---------------------------------------------------------------------------
// compute-multiline-asterisk (COMPUTE su piu' righe con riga che termina con *)
// ---------------------------------------------------------------------------
function checkComputeMultilineAsterisk(lines) {
    const cfg = getRuleConfig('compute-multiline-asterisk');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    let inCompute = false;
    let computeStartLine = -1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) { inCompute = false; continue; }
        if (ctx.inExecBlock) { inCompute = false; continue; }

        const upper = code.trim().toUpperCase();
        const withoutLit = stripLiterals(upper);

        // Detect inizio COMPUTE
        if (/^\s*COMPUTE\b/.test(upper)) {
            inCompute = true;
            computeStartLine = i;
        }

        if (inCompute) {
            // Se la riga (senza literal) termina con * (operatore moltiplicazione)
            // e NON termina con punto (non e' l'ultima riga della COMPUTE)
            const trimmedCode = withoutLit.trimEnd().replace(/\.$/, '').trimEnd();
            if (trimmedCode.endsWith('*') && !withoutLit.trimEnd().endsWith('.')) {
                diags.push(makeDiag(i, cfg.severity, 'compute-multiline-asterisk',
                    `COMPUTE su piu' righe: la riga termina con '*' (operatore moltiplicazione). Il precompilatore CICS potrebbe generare errori. Spostare l'operatore '*' all'inizio della riga successiva.`));
            }

            // Fine della COMPUTE (punto o END-COMPUTE)
            if (withoutLit.includes('.') || /\bEND-COMPUTE\b/.test(upper)) {
                inCompute = false;
            }
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// alphanumeric-in-compute (variabili alfanumeriche in operazioni matematiche)
// ---------------------------------------------------------------------------
function checkAlphanumericInCompute(lines) {
    const cfg = getRuleConfig('alphanumeric-in-compute');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();

    // Raccogli i tipi delle variabili (PIC X = alfanumerico)
    const alphanumericVars = new Set();
    const numericVars = new Set();
    const dataCtx = new AnalysisContext();
    let di = 0;
    while (di < lines.length) {
        const raw = lines[di];
        if (isSkippable(raw)) { di++; continue; }
        const code = getCodeContent(raw);
        if (!code.trim()) { di++; continue; }
        dataCtx.update(raw, code);
        if (!(dataCtx.inWorkingStorage || dataCtx.inLinkage || dataCtx.inFileSection)) { di++; continue; }

        const upper = code.trim().toUpperCase();
        const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
        if (!levelMatch) { di++; continue; }

        const level = parseInt(levelMatch[1], 10);
        const name = levelMatch[2].replace(/\.$/, '');
        if (name === 'FILLER' || level === 88 || level === 66) { di++; continue; }

        // Accumula righe di continuazione fino al punto
        let fullStmt = code;
        let j = di + 1;
        if (!fullStmt.trimEnd().endsWith('.')) {
            while (j < lines.length) {
                if (isSkippable(lines[j])) { j++; continue; }
                const nextCode = getCodeContent(lines[j]);
                if (!nextCode.trim()) { j++; continue; }
                const nextUpper = nextCode.trim().toUpperCase();
                if (/^\d{1,2}\s+/.test(nextUpper)) break;
                fullStmt += ' ' + nextCode.trim();
                j++;
                if (fullStmt.trimEnd().endsWith('.')) break;
            }
        }
        di = j > di + 1 ? j : di + 1;

        const fullUpper = fullStmt.toUpperCase();
        const picMatch = fullUpper.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?([^\s,]+)/);
        if (!picMatch) continue;
        const pic = picMatch[1].replace(/\.$/, '').toUpperCase();

        // Determina se alfanumerico: PIC contiene X o A
        // Numerico: PIC contiene solo 9, S, V, Z, P, etc.
        if (/[XA]/.test(pic.replace(/\([^)]*\)/g, ''))) {
            alphanumericVars.add(name);
        } else {
            numericVars.add(name);
        }
    }

    if (alphanumericVars.size === 0) return diags;

    // Analizza le istruzioni matematiche nella PROCEDURE DIVISION
    const mathVerbs = /^\s*(COMPUTE|ADD|SUBTRACT|MULTIPLY|DIVIDE)\b/;
    let inMath = false;
    let mathStartLine = -1;
    let mathStmt = '';
    let mathVerb = '';

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) { inMath = false; continue; }
        if (ctx.inExecBlock) { inMath = false; continue; }

        const upper = code.trim().toUpperCase();
        const withoutLit = stripLiterals(upper);

        if (!inMath) {
            const verbMatch = mathVerbs.exec(upper);
            if (verbMatch) {
                inMath = true;
                mathStartLine = i;
                mathStmt = upper;
                mathVerb = verbMatch[1];
                if (withoutLit.includes('.') || /\bEND-COMPUTE\b|\bEND-ADD\b|\bEND-SUBTRACT\b|\bEND-MULTIPLY\b|\bEND-DIVIDE\b/.test(upper)) {
                    // Istruzione su una riga
                    inMath = false;
                    _checkMathStatement(mathStmt, mathVerb, mathStartLine, alphanumericVars, diags, cfg);
                }
            }
        } else {
            // Un nuovo verbo COBOL o uno scope terminator non-math termina implicitamente l'istruzione matematica
            const newVerbOrTerminator = /^\s*(MOVE|DISPLAY|SET|PERFORM|IF|EVALUATE|READ|WRITE|OPEN|CLOSE|CALL|GO|STOP|EXIT|STRING|UNSTRING|INSPECT|ACCEPT|INITIALIZE|SEARCH|DELETE|REWRITE|START|RETURN|RELEASE|SORT|MERGE|ALTER|CANCEL|CONTINUE|GOBACK|EXEC|COPY|WHEN|ELSE|END-IF|END-EVALUATE|END-PERFORM|END-READ|END-WRITE|END-CALL|END-STRING|END-UNSTRING|END-SEARCH|END-RETURN|END-START|END-DELETE|END-REWRITE|END-ACCEPT|END-DISPLAY|END-EXEC)\b/;
            if (newVerbOrTerminator.test(upper)) {
                // Termina l'istruzione math corrente senza includere questa riga
                inMath = false;
                _checkMathStatement(mathStmt, mathVerb, mathStartLine, alphanumericVars, diags, cfg);
                // Ri-processa la riga corrente come potenziale nuova istruzione math
                const verbMatch2 = mathVerbs.exec(upper);
                if (verbMatch2) {
                    inMath = true;
                    mathStartLine = i;
                    mathStmt = upper;
                    mathVerb = verbMatch2[1];
                    if (withoutLit.includes('.') || /\bEND-COMPUTE\b|\bEND-ADD\b|\bEND-SUBTRACT\b|\bEND-MULTIPLY\b|\bEND-DIVIDE\b/.test(upper)) {
                        inMath = false;
                        _checkMathStatement(mathStmt, mathVerb, mathStartLine, alphanumericVars, diags, cfg);
                    }
                }
            } else {
                mathStmt += ' ' + upper;
                if (withoutLit.includes('.') || /\bEND-COMPUTE\b|\bEND-ADD\b|\bEND-SUBTRACT\b|\bEND-MULTIPLY\b|\bEND-DIVIDE\b/.test(upper)) {
                    inMath = false;
                    _checkMathStatement(mathStmt, mathVerb, mathStartLine, alphanumericVars, diags, cfg);
                }
            }
        }
    }
    return diags;
}

/**
 * Verifica se una istruzione matematica usa variabili alfanumeriche.
 */
function _checkMathStatement(stmt, verb, lineNum, alphanumericVars, diags, cfg) {
    const cleaned = stripLiterals(stmt);

    // Raccogli variabili protette da FUNCTION NUMVAL / NUMVAL-C
    // (la conversione alfanumerico->numerico rende l'uso legittimo)
    const numvalProtected = new Set();
    const numvalRegex = /\bFUNCTION\s+NUMVAL(?:-C)?\s*\(([^)]*)\)/gi;
    let nvm;
    while ((nvm = numvalRegex.exec(cleaned)) !== null) {
        const inner = nvm[1].trim();
        // Estrai token dentro le parentesi di NUMVAL
        const innerTokens = inner.match(/(?<![A-Z0-9-])([A-Z][A-Z0-9-]*[A-Z0-9]|[A-Z][A-Z0-9]|[A-Z])(?![A-Z0-9-])/g) || [];
        for (const t of innerTokens) {
            if (!COBOL_RESERVED_EXTENDED.has(t)) numvalProtected.add(t);
        }
    }

    // Estrai i token che potrebbero essere variabili
    const tokens = cleaned.match(/(?<![A-Z0-9-])([A-Z][A-Z0-9-]*[A-Z0-9])(?![A-Z0-9-])/g) || [];
    const shortTokens = cleaned.match(/(?<![A-Z0-9-])([A-Z][A-Z0-9])(?![A-Z0-9-])/g) || [];
    const singleTokens = cleaned.match(/(?<![A-Z0-9-])([A-Z])(?![A-Z0-9-])/g) || [];

    const reported = new Set();
    for (const token of [...tokens, ...shortTokens, ...singleTokens]) {
        if (COBOL_RESERVED_EXTENDED.has(token)) continue;
        if (reported.has(token)) continue;
        if (numvalProtected.has(token)) continue;
        if (alphanumericVars.has(token)) {
            diags.push(makeDiag(lineNum, cfg.severity, 'alphanumeric-in-compute',
                `Variabile alfanumerica '${token}' utilizzata in istruzione ${verb}. Le operazioni matematiche richiedono variabili numeriche.`,
                undefined, undefined, token));
            reported.add(token);
        }
    }
}

// ============================================================================
// Esecuzione linter
// ============================================================================

/**
 * Esegue tutte le regole del linter su un testo COBOL.
 * @param {string} text - Contenuto del file
 * @param {string} [workspaceRoot] - Root del workspace per risolvere le copy
 * @returns {vscode.Diagnostic[]}
 */
function runLinter(text, workspaceRoot) {
    // Verifica se il linter e' abilitato
    const config = vscode.workspace.getConfiguration('cobolLens.linter');
    if (!config.get('enabled', true)) return [];

    const lines = text.split(/\r?\n/);

    // Rileva il source format e imposta la variabile globale
    currentSourceFormat = detectSourceFormat(lines);

    /** @type {vscode.Diagnostic[]} */
    const allDiags = [];

    // Regole base (solo lines)
    // In formato 'variable' o 'free': disabilita col72, chars-after-period, invalid-column-7
    const basicChecks = [
        checkNoGoto, checkNoAtEnd, checkNoLevel7778,
        checkUppercase, checkDivisionSeparator, checkPicAlignment,
        checkSelectCol12, checkAssignCol29, checkWsLevels,
        checkNoElseIf, checkMoveToAlignment, checkWsLevelSpacing,
        checkEndStructure, checkStringDelimited, checkParagraphNaming,
        checkMissingPeriod, checkPicMissing,
        checkSectionOrder, checkEmptyParagraph,
        checkConsecutivePerformSpacing, checkMissingFileStatus,
        checkMissingStopRun, checkPerformThruOrder,
        checkUnusedParagraph,
        checkAndOrIf, checkRedefinesSize,
        checkVariableNameLength, checkMissingLevel,
        checkCharsAfterPeriod,
        checkComputeMultilineAsterisk,
        checkAlphanumericInCompute,
    ];

    // Controlli validi solo in formato fixed
    if (currentSourceFormat === 'fixed') {
        basicChecks.push(checkCol72);
        basicChecks.push(checkInvalidColumn7);
    } else if (currentSourceFormat === 'variable') {
        // In variable format: col 7 indicator esiste ancora
        basicChecks.push(checkInvalidColumn7);
    }
    // In free format: nessuno di questi tre

    for (const check of basicChecks) {
        allDiags.push(...check(lines));
    }

    // Regole che richiedono workspaceRoot
    allDiags.push(...checkMismatchedCopy(lines, workspaceRoot));
    allDiags.push(...checkUndefinedVariables(lines, workspaceRoot));
    allDiags.push(...checkUndefinedParagraph(lines, workspaceRoot));
    allDiags.push(...checkUnusedVariable(lines, workspaceRoot));
    allDiags.push(...checkDuplicateVariable(lines, workspaceRoot));
    allDiags.push(...checkUnsubscriptedOccurs(lines, workspaceRoot));

    // Ordina per riga
    allDiags.sort((a, b) => a.range.start.line - b.range.start.line);

    // Post-processing: restringe il range di ogni diagnostica al testo effettivo,
    // e aggiunge DiagnosticTag.Unnecessary per le regole unused
    const unusedRules = new Set(['unused-paragraph', 'unused-variable']);
    for (const diag of allDiags) {
        const lineIdx = diag.range.start.line;
        if (lineIdx >= 0 && lineIdx < lines.length) {
            const lineText = lines[lineIdx];
            // Se colStart/colEnd non erano stati specificati (range default 0..999)
            if (diag.range.start.character === 0 && diag.range.end.character >= 999) {
                // Se c'e' un nome simbolo, evidenzia solo quello
                if (diag._symbolName) {
                    const upperLine = lineText.toUpperCase();
                    const symUpper = diag._symbolName.toUpperCase();
                    const pos = upperLine.indexOf(symUpper);
                    if (pos >= 0) {
                        diag.range = new vscode.Range(
                            lineIdx, pos,
                            lineIdx, pos + symUpper.length
                        );
                    }
                } else {
                    // Restringe al primo/ultimo carattere non-spazio
                    const firstNonSpace = lineText.search(/\S/);
                    if (firstNonSpace >= 0) {
                        const endChar = lineText.trimEnd().length;
                        diag.range = new vscode.Range(
                            lineIdx, firstNonSpace,
                            lineIdx, endChar
                        );
                    }
                }
            }
        }
        if (unusedRules.has(diag.code)) {
            diag.tags = [vscode.DiagnosticTag.Unnecessary];
        }
    }

    // Ripristina il formato per sicurezza
    currentSourceFormat = 'fixed';

    return allDiags;
}

module.exports = { runLinter };
