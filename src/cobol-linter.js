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
const { msg, getLang, setLang } = require('./messages');

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
    let result = text.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    // Stringa non terminata (es. apice di chiusura troncato oltre la col 72):
    // rimuove dal primo apice rimasto fino a fine riga, cosi' il contenuto
    // della stringa non viene scambiato per codice/variabili.
    const q = result.search(/['"]/);
    if (q >= 0) result = result.substring(0, q);
    return result;
}

/**
 * Trova l'indice del primo punto TERMINATORE di frase in una stringa.
 * In COBOL un punto e' un separatore solo se seguito da uno spazio o dalla fine
 * della riga. I punti seguiti da una cifra (punto decimale di un letterale
 * numerico come 12.50, oppure carattere di edit in una PICTURE come ZZ9.99)
 * NON sono terminatori e vengono ignorati.
 * @param {string} text - testo gia' privato dei letterali stringa
 * @returns {number} indice 0-based del punto terminatore, oppure -1
 */
function findTerminatorPeriod(text) {
    for (let k = 0; k < text.length; k++) {
        if (text[k] !== '.') continue;
        const next = k + 1 < text.length ? text[k + 1] : '';
        if (next === '' || /\s/.test(next)) return k;
    }
    return -1;
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
        'col72': 'error', 'no-goto': 'warning', 'no-at-end': 'error',
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
        'alphanumeric-in-compute': 'error',
        'move-alphanumeric-to-numeric': 'error',
        'duplicate-paragraph': 'error',
        'alter-statement': 'warning',
        'next-sentence': 'warning',
        'evaluate-without-when-other': 'warning',
        'perform-varying-without-until': 'warning',
        'level-88-without-parent': 'error',
        'move-truncation': 'warning'
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
                msg('col72'), 72, raw.length));
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
                msg('noGoto'), colStart, colEnd));
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
                msg('noAtEnd')));
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
                    msg('noLevel7778', level)));
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
                msg('uppercase')));
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
                    msg('divisionSeparator', code)));
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
                        msg('picAlignment', picCol, expected)));
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
                        msg('selectCol12', selCol, expected)));
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
                            msg('assignCol29', kw, kwCol, expected)));
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
                        msg('wsLevels', String(level).padStart(2, '0'))));
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
                msg('noElseIf')));
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
                        msg('moveToAlignment', toCol, expected)));
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
                        msg('wsLevelSpacing', spaces.length)));
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
                        msg('orphanScope', endKw, openKw)));
                }
            }
        }

        // Punto sulla riga: in COBOL il punto chiude TUTTI gli scope aperti.
        // Rimuovi stringhe letterali per non confondere '.' con punto di chiusura.
        if (upperNoLit.includes('.')) {
            if (cfg.enabled) {
                for (const item of stack) {
                    diags.push(makeDiag(item.line, cfg.severity, 'end-structure',
                        msg('endStructurePoint', item.type, item.line + 1)));
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
                msg('endStructureUnclosed', item.type, item.line + 1)));
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
                        msg('stringDelimited')));
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
                        msg('stringDelimited')));
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
                msg('paragraphNaming', firstName),
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
                    msg('missingPeriod')));
            }
            break;
        }
    }

    // PROCEDURE DIVISION: l'ultima frase di un paragrafo/sezione deve terminare
    // con un punto prima dell'header del paragrafo/sezione successivo.
    const pctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        pctx.update(raw, code);
        if (!pctx.inProcedure || pctx.inExecBlock) continue;

        // Un header di paragrafo/sezione deve iniziare in Area A (nessun rientro)
        if (/^\s/.test(code)) continue;
        const upper = code.trim().toUpperCase();
        const isSection = /^[A-Z0-9][\w-]*\s+SECTION\s*\.?\s*$/.test(upper);
        const isParagraph = /^[A-Z0-9][\w-]*\.\s*$/.test(upper);
        if (!isSection && !isParagraph) continue;

        // Trova la precedente riga di codice non ignorabile
        let prevIdx = -1;
        for (let j = i - 1; j >= 0; j--) {
            if (isSkippable(lines[j])) continue;
            if (!getCodeContent(lines[j]).trim()) continue;
            prevIdx = j;
            break;
        }
        if (prevIdx < 0) continue;

        const prevUpper = getCodeContent(lines[prevIdx]).trim().toUpperCase();
        // La riga precedente e' gia' un header (division/section/paragrafo): ok
        if (prevUpper.includes('DIVISION')) continue;
        // Direttive del compilatore non richiedono punto
        if (/^(EJECT|SKIP[123]?|TITLE)\b/.test(prevUpper)) continue;

        const prevWithoutLit = stripLiterals(prevUpper);
        if (prevWithoutLit.trimEnd().endsWith('.')) continue;

        diags.push(makeDiag(prevIdx, cfg.severity, 'missing-period',
            msg('missingPeriodStatement')));
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
        // Tipi USAGE che non richiedono la clausola PIC.
        const hasNoPicUsage = /(?<![A-Z0-9-])(POINTER|PROCEDURE-POINTER|FUNCTION-POINTER|COMP-1|COMPUTATIONAL-1|COMP-2|COMPUTATIONAL-2|OBJECT\s+REFERENCE)(?![A-Z0-9-])/.test(fullUpper);

        dataItems.push({ line: lineNum, level, name, hasPic, hasRedefines, hasRenames, hasIndex, hasNoPicUsage });
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
        if (item.hasRenames || item.hasIndex || item.hasPic || item.hasNoPicUsage) continue;

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
            msg('picMissing', item.name, String(item.level).padStart(2, '0'))));
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
                        msg('mismatchedCopy', copyName)));
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
                msg('sectionOrder', found[idx].div, found[idx - 1].div)));
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
                            msg('performThruOrder', performTarget, thruTarget)));
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
                            msg('performThruOrder', performTarget, thruTarget)));
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
    const thruTargets = new Set(); // target di PERFORM ... THRU/THROUGH <nome>

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        const upper = code.trim().toUpperCase();
        // Raccoglie i bersagli delle THRU/THROUGH: un paragrafo usato come
        // terminatore di un range PERFORM ... THRU <nome> contiene
        // legittimamente solo EXIT/CONTINUE e non va segnalato come vuoto.
        const thruRe = /\b(?:THRU|THROUGH)\s+([A-Z0-9][\w-]*)/g;
        let tm;
        while ((tm = thruRe.exec(upper)) !== null) {
            thruTargets.add(tm[1]);
        }
        // Un paragrafo deve iniziare in Area A (primo carattere non-spazio del code)
        if (code && !/^\s/.test(code)) {
            const paraMatch = upper.match(/^([A-Z0-9][\w-]*)\.\s*$/);
            if (paraMatch) paragraphs.push({ name: paraMatch[1], startLine: i });
        }
    }

    for (let idx = 0; idx < paragraphs.length; idx++) {
        const { name, startLine } = paragraphs[idx];
        // Paragrafi di sola uscita: convenzioni comuni di nome
        // (suffissi -EX, -EXIT, -FINE, -END, -X o prefisso EX-) che
        // contengono solo EXIT/CONTINUE sono intenzionali.
        if (/-(EX|EXIT|FINE|END|X)$/.test(name) || /^EX-/.test(name)) continue;
        // Bersaglio di una PERFORM ... THRU: e' il terminatore di un range,
        // quindi un paragrafo di solo EXIT/CONTINUE e' corretto.
        if (thruTargets.has(name)) continue;
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
                msg('emptyParagraph', name),
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
                    msg('consecutivePerform')));
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
                    msg('missingFileStatus', selectName)));
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
            msg('missingFileStatus', selectName)));
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
            msg('missingStopRun')));
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
                msg('andOrIf')));
        }
        // Riga precedente finiva con AND/OR e questa inizia con IF
        else if (prevEndsWithConnector && /^\s*IF\b/.test(upper)) {
            diags.push(makeDiag(i, cfg.severity, 'and-or-if',
                msg('andOrIf')));
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
        const usageKw = upper.match(/\bUSAGE\s+(?:IS\s+)?(COMP(?:-[0-9])?|BINARY|PACKED-DECIMAL|POINTER|PROCEDURE-POINTER|FUNCTION-POINTER|INDEX|DISPLAY(?:-1)?)/);
        if (usageKw) {
            usage = usageKw[1];
        } else {
            // Cerca COMP/BINARY/PACKED-DECIMAL/POINTER/INDEX solo dopo il nome (non dentro nomi iphenati)
            const inlineUsage = upper.match(/(?<![-A-Z])\b(COMP(?:-[0-9])?|BINARY|PACKED-DECIMAL|POINTER|PROCEDURE-POINTER|FUNCTION-POINTER|INDEX)\b(?![-A-Z])/);
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
 * Restituisce la dimensione in byte di un item elementare con USAGE a
 * dimensione fissa che non richiede la clausola PIC (POINTER, INDEX,
 * COMP-1, COMP-2). Restituisce 0 se l'usage non e' di questo tipo.
 * @param {string} usage
 * @returns {number}
 */
function noPicUsageSize(usage) {
    const u = (usage || '').toUpperCase().replace(/\s+/g, '-');
    switch (u) {
        case 'COMP-1':
        case 'COMPUTATIONAL-1':
            return 4;
        case 'COMP-2':
        case 'COMPUTATIONAL-2':
            return 8;
        case 'INDEX':
            return 4;
        case 'POINTER':
        case 'PROCEDURE-POINTER':
        case 'FUNCTION-POINTER':
            return 4;
        default:
            return 0;
    }
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
    // Item elementari con USAGE a dimensione fissa che non richiedono PIC.
    const fixedUsageSize = noPicUsageSize(item.usage);
    if (fixedUsageSize > 0) {
        return fixedUsageSize * item.occurs;
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
        } else if (noPicUsageSize(items[k].usage) > 0) {
            // Item elementare con USAGE a dimensione fissa (POINTER, INDEX, COMP-1/2).
            size += noPicUsageSize(items[k].usage) * items[k].occurs;
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
                msg('redefinesSize', item.redefines, origSize, redefSize),
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
            // Indici dichiarati con OCCURS ... INDEXED BY idx-1 [idx-2 ...]
            const idxMatch = upper.match(/(?:^|\s)INDEXED(?:\s+BY)?\s+(.+)$/);
            if (idxMatch) {
                const rest = idxMatch[1].replace(/\.\s*$/, '');
                for (const tok of rest.split(/\s+/)) {
                    const idxName = tok.replace(/[.,]+$/, '');
                    if (!idxName) continue;
                    if (!/^[A-Z0-9][\w-]*$/.test(idxName)) break;
                    if (COBOL_RESERVED_EXTENDED.has(idxName)) break;
                    symbols.add(idxName);
                }
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
                msg('invalidColumn7', col7),
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
                                msg('unsubscriptedOccurs', varName),
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
                msg('undefinedVariable', name),
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
                msg('undefinedParagraph', target),
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
            msg('unusedParagraph', name),
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
            msg('unusedVariable', name),
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

                const msgText = copyVarSources.has(name)
                    ? msg('duplicateVarProgramAndCopy', name, lineList[0] + 1, copyVarSources.get(name).join(', '))
                    : msg('duplicateVarProgram', name, lineList[0] + 1);
                diags.push(makeDiag(lineList[k], cfg.severity, 'duplicate-variable', msgText,
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
                msg('duplicateVarProgAndCopy', name, lineList[0] + 1, copies.join(', ')),
                undefined, undefined, name));
        }
    }

    // 3. Definita in piu' copy diverse
    for (const [name, copies] of copyVarSources) {
        if (progDefs.has(name)) continue;
        if (copies.length > 1) {
            const stmtLine = copyStmtLines.get(copies[0]) || 0;
            diags.push(makeDiag(stmtLine, cfg.severity, 'duplicate-variable',
                msg('duplicateVarCopies', name, copies.join(', ')),
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
                    msg('variableNameLength', name, name.length, MAX_NAME_LENGTH),
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
                    msg('missingLevel', firstWord),
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

    // Paragrafi della ENVIRONMENT DIVISION (CONFIGURATION SECTION) il cui
    // formato standard ha l'entry sulla stessa riga dopo il punto dell'header:
    //   SOURCE-COMPUTER. IBM-370.
    //   OBJECT-COMPUTER. IBM-370.
    const envDivisionClauses = new Set([
        'SOURCE-COMPUTER', 'OBJECT-COMPUTER'
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
            !!idClauseMatch && (
                (ctx.currentDivision === 'IDENTIFICATION' &&
                    idDivisionClauses.has(idClauseMatch[1])) ||
                (ctx.currentDivision === 'ENVIRONMENT' &&
                    envDivisionClauses.has(idClauseMatch[1]))
            );

        // 1) Se c'e' un punto TERMINATORE (seguito da spazio o fine riga) nella
        // parte di codice, dopo di esso devono esserci solo spazi. I punti
        // interni ai letterali numerici (es. VALUE 12.50) e quelli usati come
        // carattere di edit nelle PICTURE (es. ZZ,ZZ9.99) NON sono terminatori
        // perche' seguiti da una cifra, quindi vengono ignorati.
        if (!isValidIdClauseLine) {
            const codeNoLit = stripLiterals(upperCode);

            // Header di paragrafo nella PROCEDURE DIVISION: il punto che chiude
            // il nome del paragrafo (in Area A, primo carattere del codice) non
            // e' il terminatore di una frase. Uno statement sulla stessa riga
            // (idioma comune "EX-ELABORA. EXIT.") e' quindi valido: si inizia a
            // cercare il punto terminatore dopo il nome del paragrafo.
            let searchStart = 0;
            if (ctx.currentDivision === 'PROCEDURE' && /^[A-Z0-9]/.test(codeNoLit)) {
                const headerMatch = codeNoLit.match(/^[A-Z0-9][\w-]*\.(?=\s|$)/);
                if (headerMatch) searchStart = headerMatch[0].length;
            }

            const relIdx = findTerminatorPeriod(codeNoLit.substring(searchStart));
            const periodIdx = relIdx >= 0 ? searchStart + relIdx : -1;
            if (periodIdx >= 0) {
                const afterPeriodRaw = codeNoLit.substring(periodIdx + 1);
                if (/\S/.test(afterPeriodRaw)) {
                    const nonSpaceOffset = afterPeriodRaw.search(/\S/);
                    const colStart = 7 + periodIdx + 1 + (nonSpaceOffset >= 0 ? nonSpaceOffset : 0);
                    const colEnd = colStart + 1;
                    diags.push(makeDiag(i, cfg.severity, 'chars-after-period',
                        msg('charsAfterPeriod'),
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
                    msg('charsAfterPeriodSeq'),
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
                    msg('computeAsterisk')));
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
// Helper: raccoglie i tipi delle variabili dichiarate nella DATA DIVISION.
// Restituisce due insiemi (nomi in maiuscolo): variabili alfanumeriche (PIC X/A)
// e variabili numeriche (PIC 9/S/V/P, numeric-edited).
// ---------------------------------------------------------------------------
function collectDataItemTypes(lines, isCopy) {
    const alphanumericVars = new Set();
    const numericVars = new Set();
    const dataCtx = new AnalysisContext();
    let di = 0;
    while (di < lines.length) {
        const raw = lines[di];
        if (isSkippable(raw)) { di++; continue; }
        const code = getCodeContent(raw);
        if (!code.trim()) { di++; continue; }
        if (!isCopy) dataCtx.update(raw, code);
        if (!isCopy && !(dataCtx.inWorkingStorage || dataCtx.inLinkage || dataCtx.inFileSection)) { di++; continue; }

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

    return { alphanumericVars, numericVars };
}

/**
 * Come collectDataItemTypes, ma espande anche le COPY (con REPLACING) per
 * classificare le variabili definite nelle copybook.
 * @param {string[]} lines
 * @param {string} [workspaceRoot]
 * @returns {{alphanumericVars: Set<string>, numericVars: Set<string>}}
 */
function collectDataItemTypesWithCopy(lines, workspaceRoot) {
    const { alphanumericVars, numericVars } = collectDataItemTypes(lines, false);
    if (!workspaceRoot) return { alphanumericVars, numericVars };

    const copyStmts = collectCopyStatements(lines);
    for (const cs of copyStmts) {
        const resolved = resolveCopybookPath(cs.name, workspaceRoot);
        if (!resolved) continue;
        try {
            const content = fs.readFileSync(resolved, 'utf-8');
            const copyTypes = collectDataItemTypes(content.split(/\r?\n/), true);
            const applyRepl = (name) => {
                for (const repl of cs.replacements) {
                    if (name.includes(repl.from)) name = name.replace(repl.from, repl.to);
                }
                return name;
            };
            for (const n of copyTypes.alphanumericVars) alphanumericVars.add(applyRepl(n));
            for (const n of copyTypes.numericVars) numericVars.add(applyRepl(n));
        } catch (e) { /* ignore */ }
    }
    return { alphanumericVars, numericVars };
}

// ---------------------------------------------------------------------------
// alphanumeric-in-compute (variabili alfanumeriche in operazioni matematiche)
// ---------------------------------------------------------------------------
function checkAlphanumericInCompute(lines, workspaceRoot) {
    const cfg = getRuleConfig('alphanumeric-in-compute');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();

    // Raccogli i tipi delle variabili (PIC X = alfanumerico), copybook incluse
    const { alphanumericVars } = collectDataItemTypesWithCopy(lines, workspaceRoot);

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
                msg('alphanumericInCompute', token, verb),
                undefined, undefined, token));
            reported.add(token);
        }
    }
}

// ---------------------------------------------------------------------------
// move-alphanumeric-to-numeric (MOVE di un valore alfanumerico in var numerica)
// ---------------------------------------------------------------------------

// Costanti figurative di tipo alfanumerico (spostarle in una variabile numerica
// e' un errore di tipo). ZERO/ZEROS/ZEROES sono compatibili col numerico e quindi
// NON sono incluse.
const FIGURATIVE_ALPHA = new Set([
    'SPACE', 'SPACES', 'HIGH-VALUE', 'HIGH-VALUES',
    'LOW-VALUE', 'LOW-VALUES', 'QUOTE', 'QUOTES',
]);

function checkMoveAlphaToNumeric(lines, workspaceRoot) {
    const cfg = getRuleConfig('move-alphanumeric-to-numeric');
    if (!cfg.enabled) return [];
    const diags = [];

    const { alphanumericVars, numericVars } = collectDataItemTypesWithCopy(lines, workspaceRoot);
    if (numericVars.size === 0) return diags;

    const ctx = new AnalysisContext();
    let inMove = false;
    let moveStartLine = -1;
    let moveStmt = '';

    const flush = () => {
        if (inMove && moveStmt) {
            _checkMoveStatement(moveStmt, moveStartLine, alphanumericVars, numericVars, diags, cfg);
        }
        inMove = false;
        moveStmt = '';
    };

    // Un nuovo verbo COBOL o uno scope terminator termina l'istruzione MOVE corrente
    const newVerbOrTerminator = /^\s*(MOVE|DISPLAY|SET|PERFORM|IF|EVALUATE|READ|WRITE|OPEN|CLOSE|CALL|GO|STOP|EXIT|STRING|UNSTRING|INSPECT|ACCEPT|INITIALIZE|SEARCH|DELETE|REWRITE|START|RETURN|RELEASE|SORT|MERGE|ALTER|CANCEL|CONTINUE|GOBACK|EXEC|COPY|WHEN|ELSE|COMPUTE|ADD|SUBTRACT|MULTIPLY|DIVIDE|END-IF|END-EVALUATE|END-PERFORM|END-READ|END-WRITE|END-CALL|END-STRING|END-UNSTRING|END-SEARCH|END-RETURN|END-START|END-DELETE|END-REWRITE|END-ACCEPT|END-DISPLAY|END-EXEC|END-MOVE)\b/;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure || ctx.inExecBlock) { flush(); continue; }

        const upper = code.trim().toUpperCase();
        const withoutLit = stripLiterals(upper);

        if (!inMove) {
            if (/^\s*MOVE\b/.test(upper)) {
                inMove = true;
                moveStartLine = i;
                moveStmt = upper;
                if (withoutLit.includes('.') || /\bEND-MOVE\b/.test(upper)) flush();
            }
        } else if (newVerbOrTerminator.test(upper)) {
            // Termina l'istruzione MOVE corrente senza includere questa riga
            flush();
            // Ri-processa la riga corrente come potenziale nuova MOVE
            if (/^\s*MOVE\b/.test(upper)) {
                inMove = true;
                moveStartLine = i;
                moveStmt = upper;
                if (withoutLit.includes('.') || /\bEND-MOVE\b/.test(upper)) flush();
            }
        } else {
            moveStmt += ' ' + upper;
            if (withoutLit.includes('.') || /\bEND-MOVE\b/.test(upper)) flush();
        }
    }
    flush();
    return diags;
}

/**
 * Verifica se una literal alfanumerica contiene solo cifre (eventualmente con
 * segno e separatore decimale): in tal caso il MOVE verso un campo numerico
 * e' lecito e non viene segnalato.
 * @param {string} content - contenuto della literal (senza apici)
 * @returns {boolean}
 */
function _isNumericLiteralContent(content) {
    return /^[+-]?\d+([.,]\d+)?$/.test(content.trim());
}

/**
 * Analizza una singola istruzione MOVE per individuare lo spostamento di un
 * valore alfanumerico in una o piu' variabili numeriche.
 */
function _checkMoveStatement(stmt, lineNum, alphanumericVars, numericVars, diags, cfg) {
    // Eccezione: FUNCTION NUMVAL / NUMVAL-C converte l'alfanumerico in numerico,
    // quindi l'uso e' legittimo.
    if (/\bFUNCTION\s+NUMVAL(?:-C)?\b/.test(stmt)) return;

    // Rimuovi il verbo MOVE iniziale, eventuale END-MOVE e il punto finale.
    let body = stmt.replace(/^\s*MOVE\s+/, '').replace(/\bEND-MOVE\b/g, '').trim();
    body = body.replace(/\.\s*$/, '').trim();

    // Salta MOVE CORRESPONDING/CORR (spostamento per nome di gruppo).
    if (/^(CORRESPONDING|CORR)\b/.test(body)) return;

    // Maschera le literal per individuare correttamente il separatore TO
    // (una literal potrebbe contenere la parola TO).
    const literals = [];
    const masked = body.replace(/'[^']*'|"[^"]*"/g, (m) => {
        literals.push(m);
        return `@LIT${literals.length - 1}@`;
    });

    // Divide su " TO " (sorgente prima, destinazioni dopo).
    const toMatch = masked.match(/^([\s\S]*?)\s+TO\s+([\s\S]+)$/);
    if (!toMatch) return;
    let srcPart = toMatch[1].trim();
    const destMasked = toMatch[2].trim();

    // Rimuovi un eventuale 'ALL' iniziale dalla sorgente.
    srcPart = srcPart.replace(/^ALL\s+/, '').trim();

    // Determina se la sorgente e' un valore alfanumerico e la sua etichetta.
    let isAlpha = false;
    let srcLabel = srcPart;

    const litRef = srcPart.match(/^@LIT(\d+)@$/);
    if (litRef) {
        const literal = literals[parseInt(litRef[1], 10)];
        srcLabel = literal;
        const inner = literal.slice(1, -1);
        // Literal non numerica (contiene lettere/simboli) -> alfanumerica.
        if (!_isNumericLiteralContent(inner)) isAlpha = true;
    } else if (FIGURATIVE_ALPHA.has(srcPart)) {
        isAlpha = true;
        srcLabel = srcPart;
    } else {
        // Identificatore: prendi il nome base (prima di subscript/reference mod).
        const idMatch = srcPart.match(/^([A-Z][A-Z0-9-]*[A-Z0-9]|[A-Z])/);
        if (idMatch && alphanumericVars.has(idMatch[1])) {
            isAlpha = true;
            srcLabel = idMatch[1];
        }
    }

    if (!isAlpha) return;

    // Estrai le variabili di destinazione (ignorando le maschere literal e i subscript/indici).
    // I subscript/indici di tabella sono tra parentesi: MOVE X TO TAB(I2) -> I2 e' l'indice,
    // non la destinazione. Stessa cosa per la reference modification (VAR(1:5)).
    const destClean = destMasked.replace(/@LIT\d+@/g, '').replace(/\([^)]*\)/g, '');
    const destTokens = destClean.match(/(?<![A-Z0-9-])([A-Z][A-Z0-9-]*[A-Z0-9]|[A-Z])(?![A-Z0-9-])/g) || [];

    const reported = new Set();
    for (const dest of destTokens) {
        if (COBOL_RESERVED_EXTENDED.has(dest)) continue;
        if (reported.has(dest)) continue;
        if (numericVars.has(dest)) {
            diags.push(makeDiag(lineNum, cfg.severity, 'move-alphanumeric-to-numeric',
                msg('moveAlphaToNumeric', srcLabel, dest),
                undefined, undefined, dest));
            reported.add(dest);
        }
    }
}

// ---------------------------------------------------------------------------
// duplicate-paragraph (paragrafi con nome duplicato nella stessa sezione)
// ---------------------------------------------------------------------------
function checkDuplicateParagraph(lines) {
    const cfg = getRuleConfig('duplicate-paragraph');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    // I nomi paragrafo devono essere univoci nella stessa SECTION; lo stesso
    // nome puo' esistere in sezioni diverse (qualificato con IN/OF), quindi lo
    // scope viene azzerato a ogni cambio di sezione della PROCEDURE DIVISION.
    let seen = new Map(); // nome -> prima riga (0-based)
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure) continue;
        // Header di paragrafo/sezione: iniziano in Area A (nessuno spazio iniziale)
        if (/^\s/.test(code)) continue;
        const upper = code.trim().toUpperCase().replace(/<[^>]*>/g, 'PLACEHOLDER');
        if (/^([A-Z0-9][\w-]*)\s+SECTION\s*\.\s*$/.test(upper)) { seen = new Map(); continue; }
        const paraMatch = upper.match(/^([A-Z0-9][\w-]*)\s*\./);
        if (!paraMatch) continue;
        const name = paraMatch[1];
        if (COBOL_RESERVED_EXTENDED.has(name) || /^\d+$/.test(name)) continue;
        if (seen.has(name)) {
            diags.push(makeDiag(i, cfg.severity, 'duplicate-paragraph',
                msg('duplicateParagraph', name, seen.get(name) + 1),
                undefined, undefined, name));
        } else {
            seen.set(name, i);
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// alter-statement (uso di ALTER, pericoloso: auto-modifica del GO TO a runtime)
// ---------------------------------------------------------------------------
function checkAlterStatement(lines) {
    const cfg = getRuleConfig('alter-statement');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure || ctx.inExecBlock) continue;
        const upper = code.toUpperCase();
        // ALTER <procedura> TO [PROCEED TO] <procedura>: la parola ALTER e' usata
        // solo come verbo, quindi la riconosciamo come token isolato.
        const m = upper.match(/(?<![\w-])ALTER\s+[A-Z0-9][\w-]*\s+TO\b/);
        if (m) {
            const idx = upper.indexOf('ALTER', m.index);
            const colStart = 7 + idx;
            diags.push(makeDiag(i, cfg.severity, 'alter-statement',
                msg('alterStatement'), colStart, colStart + 5));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// next-sentence (NEXT SENTENCE deprecato: usare CONTINUE)
// ---------------------------------------------------------------------------
function checkNextSentence(lines) {
    const cfg = getRuleConfig('next-sentence');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure || ctx.inExecBlock) continue;
        const upper = code.toUpperCase();
        const m = /(?<![\w-])NEXT\s+SENTENCE(?![\w-])/.exec(upper);
        if (m) {
            const colStart = 7 + m.index;
            diags.push(makeDiag(i, cfg.severity, 'next-sentence',
                msg('nextSentence'), colStart, colStart + m[0].length));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// evaluate-without-when-other (EVALUATE senza ramo di default WHEN OTHER)
// ---------------------------------------------------------------------------
function checkEvaluateWithoutWhenOther(lines) {
    const cfg = getRuleConfig('evaluate-without-when-other');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    // Stack per gestire EVALUATE annidati. Vengono valutati solo i blocchi
    // chiusi esplicitamente da END-EVALUATE (stile enforce-ato da end-structure);
    // gli EVALUATE terminati da punto non vengono segnalati (evita falsi positivi).
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure || ctx.inExecBlock) continue;
        const upper = code.toUpperCase();
        if (stack.length && /(?<![\w-])WHEN\s+OTHER(?![\w-])/.test(upper)) {
            stack[stack.length - 1].hasOther = true;
        }
        if (/(?<![\w-])END-EVALUATE(?![\w-])/.test(upper)) {
            const top = stack.pop();
            if (top && !top.hasOther) {
                diags.push(makeDiag(top.line, cfg.severity, 'evaluate-without-when-other',
                    msg('evaluateWithoutWhenOther'), top.col, top.col + 8));
            }
        }
        const em = /(?<![\w-])EVALUATE(?![\w-])/.exec(upper);
        if (em) {
            stack.push({ line: i, hasOther: false, col: 7 + em.index });
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// perform-varying-without-until (PERFORM VARYING senza UNTIL: rischio loop)
// ---------------------------------------------------------------------------
const PV_BODY_VERB = /^(MOVE|ADD|SUBTRACT|MULTIPLY|DIVIDE|COMPUTE|IF|EVALUATE|DISPLAY|ACCEPT|PERFORM|CALL|READ|WRITE|REWRITE|DELETE|OPEN|CLOSE|STRING|UNSTRING|INSPECT|INITIALIZE|SET|GO|STOP|GOBACK|EXIT|CONTINUE|SEARCH|START|RETURN|RELEASE|SORT|MERGE|CANCEL|EXEC|NEXT)\b/;

function checkPerformVaryingWithoutUntil(lines) {
    const cfg = getRuleConfig('perform-varying-without-until');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure || ctx.inExecBlock) continue;
        const upper = code.trim().toUpperCase();
        if (!/^PERFORM\b/.test(upper)) continue;
        if (!/(?<![\w-])VARYING(?![\w-])/.test(upper)) continue;
        if (/(?<![\w-])UNTIL(?![\w-])/.test(upper)) continue;
        // UNTIL non sulla riga: scorri le continuazioni finche' non lo trovi o
        // finche' inizia il corpo del loop (verbo) / END-PERFORM / fine frase.
        let found = false;
        let stop = /\.\s*$/.test(upper) || /(?<![\w-])END-PERFORM(?![\w-])/.test(upper);
        let j = i + 1;
        while (!stop && j < lines.length) {
            if (isSkippable(lines[j])) { j++; continue; }
            const c2 = getCodeContent(lines[j]);
            if (!c2.trim()) { j++; continue; }
            const u2 = c2.trim().toUpperCase();
            if (/(?<![\w-])UNTIL(?![\w-])/.test(u2)) { found = true; break; }
            if (/(?<![\w-])END-PERFORM(?![\w-])/.test(u2)) break;
            if (PV_BODY_VERB.test(u2)) break;
            if (/\.\s*$/.test(u2)) break;
            j++;
        }
        if (!found) {
            const lead = code.length - code.trimStart().length;
            const idx = upper.indexOf('VARYING');
            const colStart = 7 + lead + idx;
            diags.push(makeDiag(i, cfg.severity, 'perform-varying-without-until',
                msg('performVaryingWithoutUntil'), colStart, colStart + 7));
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// level-88-without-parent (livello 88 senza un campo padre a cui riferirsi)
// ---------------------------------------------------------------------------
function checkLevel88WithoutParent(lines) {
    const cfg = getRuleConfig('level-88-without-parent');
    if (!cfg.enabled) return [];
    const diags = [];
    const ctx = new AnalysisContext();
    let hasParent = false; // esiste un data item (non-88) precedente nella sezione
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        const upper = code.trim().toUpperCase();
        // Un nuovo header di sezione o una FD/SD/RD azzerano il contesto: il
        // primo 01 successivo diventa il potenziale padre.
        if (/^[A-Z0-9][\w-]*\s+SECTION\s*\.\s*$/.test(upper) ||
            /^(WORKING-STORAGE|LINKAGE|FILE|LOCAL-STORAGE|COMMUNICATION|REPORT|SCREEN)\s+SECTION\b/.test(upper) ||
            /^(FD|SD|RD)\b/.test(upper)) {
            hasParent = false;
            continue;
        }
        if (!(ctx.inWorkingStorage || ctx.inLinkage || ctx.inFileSection)) continue;
        const lm = upper.match(/^(\d{1,2})\s+([A-Z0-9][\w-]*)/);
        if (!lm) continue;
        const level = parseInt(lm[1], 10);
        const name = lm[2].replace(/\.$/, '');
        if (level === 88) {
            if (!hasParent) {
                diags.push(makeDiag(i, cfg.severity, 'level-88-without-parent',
                    msg('level88WithoutParent', name), undefined, undefined, name));
            }
        } else if ((level >= 1 && level <= 49) || level === 66 || level === 77) {
            hasParent = true;
        }
    }
    return diags;
}

// ---------------------------------------------------------------------------
// move-truncation (MOVE verso un campo con PIC piu' piccola: troncamento)
// ---------------------------------------------------------------------------

/**
 * Espande le ripetizioni PIC del tipo X(10) -> XXXXXXXXXX (con cap di sicurezza).
 * @param {string} pic
 * @returns {string}
 */
function _expandPicRepeats(pic) {
    return pic.replace(/([A-Z9$*.,+\-\/B0])\((\d+)\)/g, (m, ch, n) => {
        const count = Math.min(parseInt(n, 10), 1000000);
        return ch.repeat(count);
    });
}

/**
 * Analizza una clausola PIC e ne ricava categoria e dimensione. Volutamente
 * conservativa: classifica solo PIC "pure" (solo X, solo A, o solo 9/S/V) per
 * evitare falsi positivi sui campi con editing (Z, *, +, -, $, ., ...).
 * @param {string} picRaw
 * @returns {{category:'alpha', size:number}|{category:'num', intDigits:number, fracDigits:number}|{category:'other'}}
 */
function parsePicInfo(picRaw) {
    let pic = picRaw.toUpperCase().replace(/\.$/, '');
    pic = _expandPicRepeats(pic);
    if (/^X+$/.test(pic)) return { category: 'alpha', size: pic.length };
    if (/^A+$/.test(pic)) return { category: 'alpha', size: pic.length };
    const p = pic.replace(/^S/, '');
    if (/^9+$/.test(p)) return { category: 'num', intDigits: p.length, fracDigits: 0 };
    const vm = p.match(/^(9*)V(9*)$/);
    if (vm) return { category: 'num', intDigits: vm[1].length, fracDigits: vm[2].length };
    return { category: 'other' };
}

/**
 * Raccoglie la mappa nome -> info PIC delle variabili elementari (escludendo
 * gruppi, 88, 66, FILLER, OCCURS ed editing). Serve per move-truncation.
 * @param {string[]} lines
 * @param {boolean} isCopy
 * @returns {Map<string, object>}
 */
function collectDataItemPics(lines, isCopy) {
    const map = new Map();
    const dataCtx = new AnalysisContext();
    let di = 0;
    while (di < lines.length) {
        const raw = lines[di];
        if (isSkippable(raw)) { di++; continue; }
        const code = getCodeContent(raw);
        if (!code.trim()) { di++; continue; }
        if (!isCopy) dataCtx.update(raw, code);
        if (!isCopy && !(dataCtx.inWorkingStorage || dataCtx.inLinkage || dataCtx.inFileSection)) { di++; continue; }

        const upper = code.trim().toUpperCase();
        const levelMatch = upper.match(/^\s*(\d{1,2})\s+([A-Z0-9][\w-]*)/);
        if (!levelMatch) { di++; continue; }
        const level = parseInt(levelMatch[1], 10);
        const name = levelMatch[2].replace(/\.$/, '');
        if (name === 'FILLER' || level === 88 || level === 66) { di++; continue; }

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
        if (/\bOCCURS\b/.test(fullUpper)) continue; // subscript: risoluzione ambigua
        const picMatch = fullUpper.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?([^\s,]+)/);
        if (!picMatch) continue;
        const info = parsePicInfo(picMatch[1]);
        if (info.category === 'other') continue;
        if (!map.has(name)) map.set(name, info);
    }
    return map;
}

/**
 * Come collectDataItemPics, ma espande anche le COPY (con REPLACING).
 * @param {string[]} lines
 * @param {string} [workspaceRoot]
 * @returns {Map<string, object>}
 */
function collectDataItemPicsWithCopy(lines, workspaceRoot) {
    const map = collectDataItemPics(lines, false);
    if (!workspaceRoot) return map;
    const copyStmts = collectCopyStatements(lines);
    for (const cs of copyStmts) {
        const resolved = resolveCopybookPath(cs.name, workspaceRoot);
        if (!resolved) continue;
        try {
            const content = fs.readFileSync(resolved, 'utf-8');
            const copyMap = collectDataItemPics(content.split(/\r?\n/), true);
            const applyRepl = (nm) => {
                for (const repl of cs.replacements) {
                    if (nm.includes(repl.from)) nm = nm.replace(repl.from, repl.to);
                }
                return nm;
            };
            for (const [n, info] of copyMap) {
                const nn = applyRepl(n);
                if (!map.has(nn)) map.set(nn, info);
            }
        } catch (e) { /* ignore */ }
    }
    return map;
}

function checkMoveTruncation(lines, workspaceRoot) {
    const cfg = getRuleConfig('move-truncation');
    if (!cfg.enabled) return [];
    const diags = [];
    const picMap = collectDataItemPicsWithCopy(lines, workspaceRoot);
    if (picMap.size === 0) return diags;

    const ctx = new AnalysisContext();
    let inMove = false;
    let moveStartLine = -1;
    let moveStmt = '';

    const flush = () => {
        if (inMove && moveStmt) {
            _checkMoveTruncationStatement(moveStmt, moveStartLine, picMap, diags, cfg);
        }
        inMove = false;
        moveStmt = '';
    };

    const newVerbOrTerminator = /^\s*(MOVE|DISPLAY|SET|PERFORM|IF|EVALUATE|READ|WRITE|OPEN|CLOSE|CALL|GO|STOP|EXIT|STRING|UNSTRING|INSPECT|ACCEPT|INITIALIZE|SEARCH|DELETE|REWRITE|START|RETURN|RELEASE|SORT|MERGE|ALTER|CANCEL|CONTINUE|GOBACK|EXEC|COPY|WHEN|ELSE|COMPUTE|ADD|SUBTRACT|MULTIPLY|DIVIDE|END-IF|END-EVALUATE|END-PERFORM|END-READ|END-WRITE|END-CALL|END-STRING|END-UNSTRING|END-SEARCH|END-RETURN|END-START|END-DELETE|END-REWRITE|END-ACCEPT|END-DISPLAY|END-EXEC|END-MOVE)\b/;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (isSkippable(raw)) continue;
        const code = getCodeContent(raw);
        if (!code.trim()) continue;
        ctx.update(raw, code);
        if (!ctx.inProcedure || ctx.inExecBlock) { flush(); continue; }

        const upper = code.trim().toUpperCase();
        const withoutLit = stripLiterals(upper);

        if (!inMove) {
            if (/^\s*MOVE\b/.test(upper)) {
                inMove = true;
                moveStartLine = i;
                moveStmt = upper;
                if (withoutLit.includes('.') || /\bEND-MOVE\b/.test(upper)) flush();
            }
        } else if (newVerbOrTerminator.test(upper)) {
            flush();
            if (/^\s*MOVE\b/.test(upper)) {
                inMove = true;
                moveStartLine = i;
                moveStmt = upper;
                if (withoutLit.includes('.') || /\bEND-MOVE\b/.test(upper)) flush();
            }
        } else {
            moveStmt += ' ' + upper;
            if (withoutLit.includes('.') || /\bEND-MOVE\b/.test(upper)) flush();
        }
    }
    flush();
    return diags;
}

/**
 * Analizza una singola istruzione MOVE cercando il troncamento verso una
 * destinazione con PIC piu' piccola. Considera solo sorgente = identificatore
 * semplice (no literal/subscript/reference-mod) e destinazioni semplici, con
 * sorgente e destinazione della stessa categoria (alfanumerica o numerica).
 */
function _checkMoveTruncationStatement(stmt, lineNum, picMap, diags, cfg) {
    let body = stmt.replace(/^\s*MOVE\s+/, '').replace(/\bEND-MOVE\b/g, '').trim();
    body = body.replace(/\.\s*$/, '').trim();
    if (/^(CORRESPONDING|CORR)\b/.test(body)) return;
    if (/\bFUNCTION\b/.test(body)) return;

    const literals = [];
    const masked = body.replace(/'[^']*'|"[^"]*"/g, (m) => {
        literals.push(m);
        return `@LIT${literals.length - 1}@`;
    });
    const toMatch = masked.match(/^([\s\S]*?)\s+TO\s+([\s\S]+)$/);
    if (!toMatch) return;
    let srcPart = toMatch[1].trim();
    const destMasked = toMatch[2].trim();
    srcPart = srcPart.replace(/^ALL\s+/, '').trim();

    // La sorgente deve essere un identificatore semplice (le literal e i campi
    // con subscript/reference-mod hanno dimensione ambigua: non li trattiamo).
    if (srcPart.includes('(') || /@LIT\d+@/.test(srcPart)) return;
    const srcId = (srcPart.match(/^([A-Z][A-Z0-9-]*[A-Z0-9]|[A-Z])$/) || [])[1];
    if (!srcId) return;
    const srcInfo = picMap.get(srcId);
    if (!srcInfo) return;

    const destParts = destMasked.split(/\s+/).filter(Boolean);
    const reported = new Set();
    for (const dp of destParts) {
        if (dp.includes('(') || /@LIT\d+@/.test(dp)) continue;
        const dm = dp.match(/^([A-Z][A-Z0-9-]*[A-Z0-9]|[A-Z])$/);
        if (!dm) continue;
        const destId = dm[1];
        if (COBOL_RESERVED_EXTENDED.has(destId) || reported.has(destId)) continue;
        const destInfo = picMap.get(destId);
        if (!destInfo) continue;
        if (srcInfo.category !== destInfo.category) continue;
        if (srcInfo.category === 'alpha') {
            if (srcInfo.size > destInfo.size) {
                diags.push(makeDiag(lineNum, cfg.severity, 'move-truncation',
                    msg('moveTruncation', srcId, srcInfo.size, destId, destInfo.size),
                    undefined, undefined, destId));
                reported.add(destId);
            }
        } else if (srcInfo.intDigits > destInfo.intDigits) {
            diags.push(makeDiag(lineNum, cfg.severity, 'move-truncation',
                msg('moveTruncation', srcId, srcInfo.intDigits, destId, destInfo.intDigits),
                undefined, undefined, destId));
            reported.add(destId);
        }
    }
}

// ============================================================================
// Soppressione diagnostiche (commenti magici cobol-lens-disable*)
// ============================================================================

/**
 * Estrae il testo di commento da una riga, ai fini del riconoscimento delle
 * direttive di soppressione. Riconosce sia i commenti a riga intera (indicatore
 * '*' o '/' in colonna 7) sia i commenti inline '*>' (Micro Focus), validi in
 * qualunque colonna.
 * @param {string} line
 * @returns {string|null} il testo del commento, oppure null se la riga non ha commenti
 */
function getSuppressionComment(line) {
    if (isComment(line)) {
        return line.length > 7 ? line.substring(7) : '';
    }
    const idx = line.indexOf('*>');
    if (idx >= 0) return line.substring(idx + 2);
    return null;
}

// Le alternative piu' lunghe vanno prima: 'disable' e' prefisso di
// 'disable-next-line'/'disable-line' e con \b verrebbe altrimenti catturato.
const SUPPRESS_DIRECTIVE_RE = /cobol-lens-(disable-next-line|disable-line|disable|enable)\b([^]*)/i;

/**
 * Estrae i nomi delle regole da un frammento di direttiva. Un separatore '--'
 * introduce un motivo/nota libera che viene ignorato. Nessun id = tutte le regole.
 * @param {string} rest
 * @returns {string[]} elenco di rule id in minuscolo (vuoto = tutte le regole)
 */
function parseSuppressRules(rest) {
    let r = rest || '';
    const dash = r.indexOf('--');
    if (dash >= 0) r = r.substring(0, dash);
    return r.split(/[\s,]+/)
        .map(s => s.trim().toLowerCase().replace(/[.,;:]+$/, ''))
        .filter(Boolean);
}

/**
 * Analizza le direttive di soppressione presenti nel sorgente e restituisce un
 * oggetto con il metodo isSuppressed(line, code).
 *
 * Direttive supportate (dentro un commento):
 *   cobol-lens-disable-next-line [regole...]  -> sopprime sulla riga di codice successiva
 *   cobol-lens-disable-line [regole...]       -> sopprime sulla riga corrente (commento inline)
 *   cobol-lens-disable [regole...]            -> sopprime da qui in poi
 *   cobol-lens-enable [regole...]             -> riabilita da qui in poi
 * Senza regole la direttiva vale per TUTTE le regole.
 * @param {string[]} lines
 * @returns {{ isSuppressed: (line: number, code: string) => boolean }}
 */
function computeSuppressions(lines) {
    const N = lines.length;
    /** @type {Map<number, {all: boolean, rules: Set<string>}>} */
    const lineSuppress = new Map();
    /** @type {Array<{line: number, kind: string, all: boolean, rules: string[]}>} */
    const blockEvents = [];

    const addLine = (line, all, rules) => {
        let entry = lineSuppress.get(line);
        if (!entry) { entry = { all: false, rules: new Set() }; lineSuppress.set(line, entry); }
        if (all) entry.all = true;
        else for (const r of rules) entry.rules.add(r);
    };

    for (let i = 0; i < N; i++) {
        const comment = getSuppressionComment(lines[i]);
        if (comment === null) continue;
        const m = comment.match(SUPPRESS_DIRECTIVE_RE);
        if (!m) continue;
        const kind = m[1].toLowerCase();
        const rules = parseSuppressRules(m[2]);
        const all = rules.length === 0;
        if (kind === 'disable-next-line') {
            // Bersaglio: la prima riga successiva che non sia vuota o di commento.
            let j = i + 1;
            while (j < N && (isBlank(lines[j]) || isComment(lines[j]))) j++;
            if (j < N) addLine(j, all, rules);
        } else if (kind === 'disable-line') {
            addLine(i, all, rules);
        } else {
            blockEvents.push({ line: i, kind, all, rules });
        }
    }

    const blockSuppressedAt = (line, code) => {
        let disabledAll = false;
        const disabledRules = new Set();
        const enabledExc = new Set();
        for (const e of blockEvents) {
            if (e.line > line) break;
            if (e.kind === 'disable') {
                if (e.all) { disabledAll = true; enabledExc.clear(); }
                else for (const r of e.rules) { disabledRules.add(r); enabledExc.delete(r); }
            } else { // enable
                if (e.all) { disabledAll = false; disabledRules.clear(); enabledExc.clear(); }
                else for (const r of e.rules) { disabledRules.delete(r); enabledExc.add(r); }
            }
        }
        if (disabledRules.has(code)) return true;
        if (disabledAll && !enabledExc.has(code)) return true;
        return false;
    };

    return {
        isSuppressed(line, code) {
            const entry = lineSuppress.get(line);
            if (entry) {
                if (entry.all) return true;
                if (entry.rules.has(code)) return true;
            }
            return blockSuppressedAt(line, code);
        }
    };
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

    // Imposta la lingua per tutti i messaggi di questa esecuzione
    setLang(getLang());

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
        checkDuplicateParagraph, checkAlterStatement,
        checkNextSentence, checkEvaluateWithoutWhenOther,
        checkPerformVaryingWithoutUntil, checkLevel88WithoutParent,
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
    allDiags.push(...checkAlphanumericInCompute(lines, workspaceRoot));
    allDiags.push(...checkMoveAlphaToNumeric(lines, workspaceRoot));
    allDiags.push(...checkMoveTruncation(lines, workspaceRoot));

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

    // Filtra le diagnostiche soppresse dai commenti magici cobol-lens-disable*
    let result = allDiags;
    if (config.get('suppressions.enabled', true)) {
        const supp = computeSuppressions(lines);
        result = allDiags.filter(d => !supp.isSuppressed(d.range.start.line, String(d.code)));
    }

    // Ripristina il formato per sicurezza
    currentSourceFormat = 'fixed';

    return result;
}

module.exports = { runLinter };
