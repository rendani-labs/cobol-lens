// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

/**
 * Regex per istruzioni COPY.
 * Cattura il nome della copybook (gruppo 1).
 * Supporta anche COPY ... REPLACING (la clausola REPLACING viene gestita separatamente).
 */
const COPY_REGEX = /\bCOPY\s+['"]?([A-Za-z0-9_-]+)['"]?/i;

/**
 * Regex per estrarre le coppie REPLACING da una COPY statement multi-riga.
 * Supporta sia ==OLD== BY ==NEW== che 'OLD' BY 'NEW' e OLD BY NEW.
 */
const REPLACING_PAIR_REGEX = /==([^=]+)==\s+BY\s+==([^=]*)==/gi;

/**
 * Regex per definizioni di variabili nella DATA DIVISION.
 * Cattura: livello (gruppo 1), nome (gruppo 2)
 * Livelli: 01-49, 66, 77, 88
 * Le prime 6 colonne (area sequenza) possono contenere qualsiasi carattere
 * (numeri di sequenza, tag di modifica, spazi); la col 7 (indicatore) è
 * gestita separatamente da isComment().
 */
const VARIABLE_DEF_REGEX = /^.{0,6}\s+(0[1-9]|[1-4]\d|66|77|88)\s+([A-Za-z][A-Za-z0-9-]*)/i;

/**
 * Regex per definizioni di paragrafi (nome che inizia in area A, colonne 8-11).
 * Un paragrafo: un nome seguito da un punto, senza keyword SECTION.
 * Colonne 1-6: qualsiasi contenuto (numeri sequenza, marcatori debug, spazi).
 * Esclude keyword COBOL riservate.
 */
const PARAGRAPH_REGEX = /^.{0,6}\s{1,4}([A-Za-z][A-Za-z0-9-]+)\s*\./;

/**
 * Regex per definizioni di sezioni nella PROCEDURE DIVISION.
 * Nome SECTION.
 */
const SECTION_REGEX = /^.{0,6}\s{1,4}([A-Za-z][A-Za-z0-9-]+)\s+SECTION\s*\.\s*$/i;

/**
 * Keyword COBOL da escludere dal riconoscimento di paragrafi.
 */
const COBOL_RESERVED = new Set([
    'IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE',
    'DIVISION', 'SECTION', 'WORKING-STORAGE', 'LOCAL-STORAGE',
    'LINKAGE', 'FILE', 'INPUT-OUTPUT', 'FILE-CONTROL',
    'CONFIGURATION', 'SPECIAL-NAMES', 'REPOSITORY',
    'FD', 'SD', 'RD', 'COPY', 'REPLACE', 'EXEC', 'END-EXEC',
    'SELECT', 'ASSIGN', 'ORGANIZATION', 'ACCESS',
    'IF', 'ELSE', 'END-IF', 'EVALUATE', 'END-EVALUATE',
    'PERFORM', 'END-PERFORM', 'MOVE', 'COMPUTE', 'ADD',
    'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'STRING', 'UNSTRING',
    'ACCEPT', 'DISPLAY', 'READ', 'WRITE', 'REWRITE', 'DELETE',
    'OPEN', 'CLOSE', 'START', 'STOP', 'CALL', 'CANCEL',
    'GO', 'ALTER', 'EXIT', 'CONTINUE', 'INITIALIZE',
    'INSPECT', 'SEARCH', 'SET', 'SORT', 'MERGE', 'RETURN',
    'RELEASE', 'GENERATE', 'INITIATE', 'TERMINATE',
    'WHEN', 'NOT', 'AND', 'OR', 'ALSO', 'OTHER', 'THRU', 'THROUGH',
    'WITH', 'VARYING', 'UNTIL', 'TIMES', 'TEST', 'BEFORE', 'AFTER',
    'GIVING', 'RETURNING', 'INTO', 'FROM', 'TO', 'BY',
    'ON', 'SIZE', 'ERROR', 'OVERFLOW', 'EXCEPTION',
    'AT', 'END', 'INVALID', 'KEY', 'STATUS',
    'PROGRAM-ID', 'AUTHOR', 'DATE-WRITTEN', 'DATE-COMPILED',
    'REMARKS', 'SECURITY',
    'PIC', 'PICTURE', 'VALUE', 'VALUES', 'OCCURS', 'REDEFINES',
    'RENAMES', 'FILLER', 'USAGE', 'COMP', 'COMP-1', 'COMP-2',
    'COMP-3', 'COMP-4', 'COMP-5', 'BINARY', 'PACKED-DECIMAL',
    'DISPLAY-1', 'INDEX', 'POINTER', 'OBJECT', 'REFERENCE',
    'ASCENDING', 'DESCENDING', 'DEPENDING', 'INDEXED',
    'GLOBAL', 'EXTERNAL', 'SYNCHRONIZED', 'JUSTIFIED',
    'BLANK', 'SIGN', 'LEADING', 'TRAILING', 'SEPARATE'
]);

/**
 * Tipo di simbolo COBOL.
 * @typedef {'variable' | 'paragraph' | 'section' | 'copy'} SymbolType
 */

/**
 * @typedef {Object} CobolSymbol
 * @property {string} name - Nome del simbolo (maiuscolo per confronto)
 * @property {string} originalName - Nome come appare nel sorgente
 * @property {SymbolType} type - Tipo di simbolo
 * @property {string} filePath - Path assoluto del file dove è definito
 * @property {number} line - Numero di riga (0-based)
 * @property {number} column - Colonna iniziale (0-based)
 * @property {number} [level] - Livello per le variabili (01-49, 66, 77, 88)
 * @property {string} [lineText] - Testo completo della riga
 */

/**
 * Verifica se una riga è un commento COBOL.
 * Colonna 7 (indice 6) = '*' o '/' indica commento nel formato fisso.
 * @param {string} line
 * @returns {boolean}
 */
function isComment(line) {
    if (line.length < 7) return false;
    const col7 = line.charAt(6);
    return col7 === '*' || col7 === '/';
}

/**
 * Determina la divisione corrente in base al testo della riga.
 * @param {string} line
 * @param {string} currentDivision
 * @returns {string}
 */
function detectDivision(line, currentDivision) {
    const upper = line.toUpperCase();
    if (upper.includes('IDENTIFICATION') && upper.includes('DIVISION')) return 'IDENTIFICATION';
    if (upper.includes('ENVIRONMENT') && upper.includes('DIVISION')) return 'ENVIRONMENT';
    if (upper.includes('DATA') && upper.includes('DIVISION')) return 'DATA';
    if (upper.includes('PROCEDURE') && upper.includes('DIVISION')) return 'PROCEDURE';
    return currentDivision;
}

/**
 * Estrae le coppie REPLACING da una COPY statement (può essere multi-riga).
 * @param {string[]} lines - Tutte le righe del file
 * @param {number} startLine - Riga dove inizia la COPY
 * @returns {{ replacements: Array<{from: string, to: string}>, endLine: number }}
 */
function extractReplacements(lines, startLine) {
    const replacements = [];
    let fullStatement = '';
    let endLine = startLine;

    // Accumula righe fino al punto finale della COPY statement
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        if (isComment(line)) continue;
        fullStatement += ' ' + line;
        endLine = i;
        if (line.includes('.')) break;
    }

    // Estrai le coppie REPLACING
    let match;
    const regex = new RegExp(REPLACING_PAIR_REGEX.source, 'gi');
    while ((match = regex.exec(fullStatement)) !== null) {
        replacements.push({
            from: match[1].trim().toUpperCase(),
            to: match[2].trim().toUpperCase()
        });
    }

    return { replacements, endLine };
}

/**
 * Applica le sostituzioni REPLACING ai nomi dei simboli di una copybook.
 * @param {CobolSymbol[]} symbols
 * @param {Array<{from: string, to: string}>} replacements
 * @returns {CobolSymbol[]}
 */
function applyReplacements(symbols, replacements) {
    if (replacements.length === 0) return symbols;

    return symbols.map(sym => {
        let newName = sym.name;
        let newOriginal = sym.originalName;
        for (const repl of replacements) {
            if (newName.includes(repl.from)) {
                newName = newName.replace(repl.from, repl.to);
                newOriginal = newOriginal.toUpperCase().replace(repl.from, repl.to);
            }
        }
        if (newName !== sym.name) {
            return { ...sym, name: newName, originalName: newOriginal };
        }
        return sym;
    });
}

/**
 * Parsa un file COBOL ed estrae tutti i simboli.
 * @param {string} filePath - Path assoluto del file
 * @param {string} content - Contenuto del file
 * @param {string} workspaceRoot - Root del workspace
 * @param {Set<string>} [visitedCopybooks] - Per evitare ricorsione infinita
 * @param {string} [initialDivision] - Divisione eredidata dal file chiamante per copybook senza header
 * @returns {CobolSymbol[]}
 */
function parseCobolSymbols(filePath, content, workspaceRoot, visitedCopybooks, initialDivision) {
    if (!visitedCopybooks) {
        visitedCopybooks = new Set();
    }

    /** @type {CobolSymbol[]} */
    const symbols = [];
    const lines = content.split(/\r?\n/);
    let currentDivision = initialDivision || '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Salta righe vuote e commenti
        if (!line.trim() || isComment(line)) {
            continue;
        }

        // Rileva divisione corrente
        currentDivision = detectDivision(line, currentDivision);

        // COPY statement ? registra come simbolo e parsa la copybook
        const copyMatch = COPY_REGEX.exec(line);
        if (copyMatch) {
            const copyName = copyMatch[1];
            const copyStartIdx = line.toUpperCase().indexOf(copyName.toUpperCase(),
                line.toUpperCase().indexOf('COPY') + 4);

            symbols.push({
                name: copyName.toUpperCase(),
                originalName: copyName,
                type: 'copy',
                filePath: filePath,
                line: i,
                column: copyStartIdx >= 0 ? copyStartIdx : 0,
                lineText: line
            });

            // Estrai le coppie REPLACING (anche su righe successive)
            const { replacements, endLine } = extractReplacements(lines, i);
            if (endLine > i) {
                i = endLine; // Salta le righe della clausola REPLACING
            }

            // Risolvi e parsa la copybook ricorsivamente
            if (!visitedCopybooks.has(copyName.toUpperCase())) {
                visitedCopybooks.add(copyName.toUpperCase());
                const resolved = resolveCopybookPath(copyName, workspaceRoot);
                if (resolved) {
                    try {
                        const copyContent = fs.readFileSync(resolved, 'utf-8');
                        let copySymbols = parseCobolSymbols(
                            resolved,
                            copyContent,
                            workspaceRoot,
                            visitedCopybooks,
                            currentDivision
                        );
                        // Applica REPLACING ai simboli della copybook
                        copySymbols = applyReplacements(copySymbols, replacements);
                        symbols.push(...copySymbols);
                    } catch (e) {
                        // Ignora errori di lettura
                    }
                }
            }
            continue;
        }

        // Variabili nella DATA DIVISION (o prima della PROCEDURE)
        if (currentDivision !== 'PROCEDURE' && currentDivision !== 'IDENTIFICATION') {
            // Indici dichiarati con OCCURS ... INDEXED BY idx-1 [idx-2 ...]
            // (puo' trovarsi sulla stessa riga del livello o su una riga di continuazione)
            const idxMatch = /(?:^|\s)INDEXED(?:\s+BY)?\s+(.+)$/i.exec(line);
            if (idxMatch) {
                let rest = idxMatch[1].replace(/\.\s*$/, '');
                let searchFrom = line.toUpperCase().indexOf('INDEXED');
                for (const tok of rest.split(/\s+/)) {
                    const idxName = tok.replace(/[.,]+$/, '');
                    if (!idxName) continue;
                    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(idxName)) break;
                    if (COBOL_RESERVED.has(idxName.toUpperCase())) break;
                    const col = line.indexOf(idxName, searchFrom);
                    symbols.push({
                        name: idxName.toUpperCase(),
                        originalName: idxName,
                        type: 'variable',
                        filePath: filePath,
                        line: i,
                        column: col >= 0 ? col : 0,
                        level: undefined,
                        lineText: line
                    });
                    if (col >= 0) searchFrom = col + idxName.length;
                }
            }

            const varMatch = VARIABLE_DEF_REGEX.exec(line);
            if (varMatch) {
                const level = parseInt(varMatch[1], 10);
                const varName = varMatch[2];

                // Salta FILLER
                if (varName.toUpperCase() === 'FILLER') continue;

                const col = line.indexOf(varName, line.indexOf(varMatch[1]) + varMatch[1].length);
                symbols.push({
                    name: varName.toUpperCase(),
                    originalName: varName,
                    type: 'variable',
                    filePath: filePath,
                    line: i,
                    column: col >= 0 ? col : 0,
                    level: level,
                    lineText: line
                });
                continue;
            }
        }

        // Sezioni e paragrafi nella PROCEDURE DIVISION
        if (currentDivision === 'PROCEDURE') {
            const sectionMatch = SECTION_REGEX.exec(line);
            if (sectionMatch) {
                const secName = sectionMatch[1];
                if (!COBOL_RESERVED.has(secName.toUpperCase())) {
                    const col = line.indexOf(secName);
                    symbols.push({
                        name: secName.toUpperCase(),
                        originalName: secName,
                        type: 'section',
                        filePath: filePath,
                        line: i,
                        column: col >= 0 ? col : 0,
                        lineText: line
                    });
                }
                continue;
            }

            const paraMatch = PARAGRAPH_REGEX.exec(line);
            if (paraMatch) {
                const paraName = paraMatch[1];
                if (!COBOL_RESERVED.has(paraName.toUpperCase())) {
                    const col = line.indexOf(paraName);
                    symbols.push({
                        name: paraName.toUpperCase(),
                        originalName: paraName,
                        type: 'paragraph',
                        filePath: filePath,
                        line: i,
                        column: col >= 0 ? col : 0,
                        lineText: line
                    });
                }
                continue;
            }
        }
    }

    return symbols;
}

/**
 * Risolve il path di una copybook cercando nelle cartelle configurate.
 * @param {string} copyName
 * @param {string} workspaceRoot
 * @returns {string | undefined}
 */
function resolveCopybookPath(copyName, workspaceRoot) {
    const config = vscode.workspace.getConfiguration('cobolLens');
    const folders = config.get('copyFolders', ['Copy', 'Copy_DR', 'Copy_Prod']);
    const extensions = config.get('copyExtensions', ['', '.cpy', '.CPY', '.COPY', '.copy']);

    for (const folder of folders) {
        const folderPath = path.join(workspaceRoot, folder);
        for (const ext of extensions) {
            const filePath = path.join(folderPath, copyName + ext);
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }
    }
    return undefined;
}

/**
 * Analizza una riga alla ricerca di una CALL a un programma.
 * Riconosce sia CALL 'NOME' / "NOME" (letterale) sia CALL identificatore
 * (variabile). Restituisce il nome grezzo, la posizione sulla riga e se il
 * bersaglio e' un letterale.
 * @param {string} line
 * @returns {{ name: string, nameStart: number, nameEnd: number, isLiteral: boolean } | undefined}
 */
function parseCallStatement(line) {
    if (isComment(line)) return undefined;

    // CALL 'NOME' oppure CALL "NOME"
    const litRe = /\bCALL\s+(['"])([^'"]+)\1/i;
    const mLit = litRe.exec(line);
    if (mLit) {
        // Posizione del nome: fine del match meno la lunghezza del nome e la
        // virgoletta di chiusura.
        const nameStart = mLit.index + mLit[0].length - mLit[2].length - 1;
        return { name: mLit[2], nameStart, nameEnd: nameStart + mLit[2].length, isLiteral: true };
    }

    // CALL identificatore (variabile che contiene il nome del programma)
    const idRe = /\bCALL\s+([A-Za-z][\w-]*)/i;
    const mId = idRe.exec(line);
    if (mId) {
        const nameStart = mId.index + mId[0].length - mId[1].length;
        return { name: mId[1], nameStart, nameEnd: nameStart + mId[1].length, isLiteral: false };
    }

    return undefined;
}

/**
 * Risolve il percorso del file sorgente di un programma chiamato via CALL,
 * cercandolo nelle cartelle configurate (cobolLens.programFolders) con le
 * estensioni configurate (cobolLens.programExtensions).
 * @param {string} programName
 * @param {string} workspaceRoot
 * @returns {string | undefined}
 */
function resolveProgramPath(programName, workspaceRoot) {
    const config = vscode.workspace.getConfiguration('cobolLens');
    const folders = config.get('programFolders', ['', 'src', 'Source', 'source', 'cbl', 'CBL', 'Cobol', 'COBOL']);
    const extensions = config.get('programExtensions', ['.CBL', '.cbl', '.cob', '.COB', '.cobol', '.COBOL', '']);

    for (const folder of folders) {
        const folderPath = folder ? path.join(workspaceRoot, folder) : workspaceRoot;
        for (const ext of extensions) {
            const filePath = path.join(folderPath, programName + ext);
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }
    }
    return undefined;
}

/**
 * Estrae livello e nome da una riga di definizione dati (fixed o variable).
 * @param {string} lineText
 * @returns {{ level: number, name: string } | undefined}
 */
function parseDataLevel(lineText) {
    if (isComment(lineText)) return undefined;
    const m = VARIABLE_DEF_REGEX.exec(lineText);
    if (!m) return undefined;
    return { level: parseInt(m[1], 10), name: m[2] };
}

/**
 * Estrae la clausola VALUE/VALUES da una riga (tipicamente un condition-name
 * 88). Restituisce il testo grezzo dei valori, senza la keyword e senza il
 * punto finale di chiusura frase, oppure undefined se assente.
 * @param {string} lineText
 * @returns {string | undefined}
 */
function parseValueClause(lineText) {
    if (isComment(lineText)) return undefined;
    const m = /\bVALUES?\b\s+(?:IS\s+|ARE\s+)?([\s\S]+)$/i.exec(lineText);
    if (!m) return undefined;
    const v = m[1].trim().replace(/\.\s*$/, '').trim();
    return v || undefined;
}

/**
 * Trova i condition-name (livello 88) immediatamente subordinati a una voce
 * dati elementare.
 * @param {string[]} lines
 * @param {number} dataLineIndex - indice 0-based della voce dati
 * @returns {{ name: string, value: (string|undefined), line: number }[]}
 */
function findConditionNames(lines, dataLineIndex) {
    const parent = parseDataLevel(lines[dataLineIndex] || '');
    if (!parent || parent.level === 88) return [];
    const result = [];
    for (let i = dataLineIndex + 1; i < lines.length; i++) {
        const raw = lines[i];
        if (isComment(raw) || !raw || !raw.trim()) continue;
        const info = parseDataLevel(raw);
        if (!info) continue; // riga di continuazione di clausola: la si salta
        if (info.level === 88) {
            result.push({ name: info.name, value: parseValueClause(raw), line: i });
        } else {
            break; // primo elemento non-88: gli 88 seguono direttamente il campo
        }
    }
    return result;
}

/**
 * Per un condition-name (88), trova la voce dati padre (il campo elementare che
 * lo precede immediatamente).
 * @param {string[]} lines
 * @param {number} condLineIndex - indice 0-based della riga 88
 * @returns {{ name: string, level: number, line: number } | undefined}
 */
function findConditionParent(lines, condLineIndex) {
    for (let i = condLineIndex - 1; i >= 0; i--) {
        const raw = lines[i];
        if (isComment(raw) || !raw || !raw.trim()) continue;
        const info = parseDataLevel(raw);
        if (!info) continue;
        if (info.level !== 88) return { name: info.name, level: info.level, line: i };
    }
    return undefined;
}

/**
 * Effettua l'escape dei metacaratteri di una regexp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Applica le sostituzioni REPLACING (pseudo-testo) al testo di una copybook.
 * Le righe di commento non vengono toccate.
 * @param {string[]} lines
 * @param {Array<{from: string, to: string}>} replacements
 * @returns {string[]}
 */
function applyTextReplacements(lines, replacements) {
    if (!replacements || replacements.length === 0) return lines;
    return lines.map(line => {
        if (isComment(line)) return line;
        let result = line;
        for (const r of replacements) {
            if (!r.from) continue;
            result = result.replace(new RegExp(escapeRegExp(r.from), 'gi'), r.to);
        }
        return result;
    });
}

/**
 * Espande ricorsivamente le istruzioni COPY di un sorgente producendo il testo
 * risultante (righe). Applica le clausole REPLACING al testo della copybook e
 * previene la ricorsione infinita. Le COPY non risolvibili vengono lasciate
 * invariate. Il lettore/risolutore sono iniettabili (per i test).
 * @param {string[]} lines
 * @param {string} workspaceRoot
 * @param {object} [opts]
 * @param {(name: string, root: string) => (string|undefined)} [opts.resolve]
 * @param {(filePath: string) => string} [opts.read]
 * @param {boolean} [opts.markers] - inserisci commenti marcatori (default true)
 * @param {Set<string>} [opts.chain] - copybook in corso di espansione (anti-ricorsione)
 * @returns {string[]}
 */
function expandCopyText(lines, workspaceRoot, opts) {
    opts = opts || {};
    const resolve = opts.resolve || resolveCopybookPath;
    const read = opts.read || ((p) => fs.readFileSync(p, 'utf-8'));
    const markers = opts.markers !== false;
    const chain = opts.chain || new Set();
    /** @type {string[]} */
    const out = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isComment(line)) { out.push(line); continue; }

        const copyMatch = COPY_REGEX.exec(line);
        if (!copyMatch) { out.push(line); continue; }

        const copyName = copyMatch[1];
        const key = copyName.toUpperCase();
        const { replacements, endLine } = extractReplacements(lines, i);
        const resolved = resolve(copyName, workspaceRoot);

        // Codice che precede la COPY sulla stessa riga (es. "01 WS-OUTER. COPY X.")
        // va preservato per non perderlo nell'espansione.
        const prefix = line.substring(0, copyMatch.index).replace(/\s+$/, '');
        const hasPrefix = prefix.trim().length > 0;

        // COPY non risolvibile o ricorsiva: lascia le righe originali.
        if (!resolved || chain.has(key)) {
            for (let k = i; k <= endLine; k++) out.push(lines[k]);
            if (markers) {
                out.push('      * COBOL Lens: COPY ' + copyName +
                    (chain.has(key) ? ' non espansa (ricorsione)' : ' non trovata'));
            }
            i = endLine;
            continue;
        }

        let content;
        try {
            content = read(resolved);
        } catch (e) {
            for (let k = i; k <= endLine; k++) out.push(lines[k]);
            i = endLine;
            continue;
        }

        const childChain = new Set(chain);
        childChain.add(key);
        let subLines = expandCopyText(content.split(/\r?\n/), workspaceRoot, {
            resolve, read, markers, chain: childChain
        });
        subLines = applyTextReplacements(subLines, replacements);

        if (hasPrefix) out.push(prefix);
        if (markers) {
            out.push('      * >>> COPY ' + copyName +
                (replacements.length ? ' REPLACING' : '') + ' (COBOL Lens)');
        }
        for (const s of subLines) out.push(s);
        if (markers) {
            out.push('      * <<< END COPY ' + copyName);
        }

        i = endLine;
    }

    return out;
}

/**
 * Individua i blocchi EXEC SQL/CICS/DLI ... END-EXEC che si estendono su piu'
 * righe fisiche. Restituisce gli intervalli [start, end] (0-based, inclusivi).
 * I blocchi EXEC ... END-EXEC su una sola riga vengono ignorati (nulla da
 * ripiegare). Righe vuote e commenti non interrompono il blocco.
 * @param {string[]} lines
 * @returns {{ start: number, end: number }[]}
 */
function findExecBlocks(lines) {
    /** @type {{ start: number, end: number }[]} */
    const blocks = [];
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || isComment(line) || !line.trim()) continue;
        const upper = line.toUpperCase();
        if (start < 0) {
            if (/\bEXEC\s+(SQL|CICS|DLI|DL1|ADS)\b/.test(upper) && !/\bEND-EXEC\b/.test(upper)) {
                start = i;
            }
        } else if (/\bEND-EXEC\b/.test(upper)) {
            if (i > start) blocks.push({ start, end: i });
            start = -1;
        }
    }
    return blocks;
}

module.exports = {
    parseCobolSymbols,
    resolveCopybookPath,
    parseCallStatement,
    resolveProgramPath,
    parseDataLevel,
    parseValueClause,
    findConditionNames,
    findConditionParent,
    expandCopyText,
    applyTextReplacements,
    findExecBlocks,
    isComment,
    COPY_REGEX,
    REPLACING_PAIR_REGEX,
    VARIABLE_DEF_REGEX,
    PARAGRAPH_REGEX,
    SECTION_REGEX,
    COBOL_RESERVED
};
