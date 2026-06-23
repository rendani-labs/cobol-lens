// @ts-check
'use strict';

/**
 * Formattatore per il formato FIXED del COBOL (Micro Focus / Rocket).
 *
 * Regole applicate (decise con l'utente):
 *  - Area A (colonna 8): DIVISION, SECTION, paragrafi, livelli 01 e 77,
 *    voci FD/SD/RD/CD e i paragrafi standard di IDENTIFICATION/ENVIRONMENT.
 *  - Dati: indentazione gerarchica di 3 spazi per livello di annidamento
 *    (01 -> col 8, figlio -> col 11, nipote -> col 14, ...). Le voci 88 sono
 *    figlie dell'elemento corrente.
 *  - Esattamente 1 spazio tra il numero di livello e il nome; 1 spazio anche
 *    dopo FD/SD/RD/CD prima del nome file.
 *  - Allineamento della clausola PIC alla colonna 45; per gli 88 (senza PIC)
 *    si allinea la clausola VALUE alla colonna 45. Le clausole successive (es.
 *    VALUE dopo il PIC) seguono con un solo spazio.
 *  - PROCEDURE: gli statement partono dalla colonna 12; i blocchi annidati
 *    (IF/ELSE, EVALUATE/WHEN, PERFORM inline) rientrano di 3 spazi per livello.
 *    La keyword TO di MOVE/SET/ADD viene allineata alla colonna 45.
 *    Il punto di fine frase chiude tutti gli ambiti aperti.
 *  - Rimozione di TUTTI gli spazi finali.
 *  - Gestione del superamento della colonna 72: lo spazio prima di PIC/TO/VALUE
 *    viene ridotto progressivamente fino a 1 byte senza cancellare contenuto;
 *    se una voce dati non sta comunque in una riga, le clausole vengono spezzate
 *    su piu' righe allineate alla colonna 45.
 *  - L'area di identificazione (colonne 73+) e i commenti (colonna 7) NON
 *    vengono toccati; le righe di continuazione (colonna 7 = '-') e di debug
 *    ('D') sono lasciate invariate.
 *
 * Il formattatore agisce solo quando il formato sorgente e' 'fixed'
 * (impostazione cobolLens.sourceFormat) e non c'e' una direttiva
 * $SET SOURCEFORMAT(VARIABLE|FREE) nel file.
 */

const vscode = require('vscode');

const AREA_A = 8;   // colonna 1-based di inizio Area A
const AREA_B = 12;  // colonna 1-based di inizio Area B
const INDENT = 3;   // passo di indentazione
const CODE_END = 72; // ultima colonna dell'area codice (1-based)
const ALIGN_COL = 45; // colonna di allineamento per PIC / TO / VALUE (88)

/** Keyword che, a inizio riga di continuazione dati, si allineano a col 45. */
const CLAUSE_KW = /^(PIC|PICTURE|VALUE|VALUES|OCCURS|REDEFINES|RENAMES|USAGE|COMP|COMP-1|COMP-2|COMP-3|COMP-4|COMP-5|COMP-X|BINARY|PACKED-DECIMAL|SIGN|SYNC|SYNCHRONIZED|JUST|JUSTIFIED|BLANK|INDEXED)\b/;

/** Paragrafi standard della IDENTIFICATION DIVISION (Area A). */
const ID_PARAGRAPHS = new Set([
    'PROGRAM-ID', 'AUTHOR', 'INSTALLATION', 'DATE-WRITTEN',
    'DATE-COMPILED', 'SECURITY', 'REMARKS', 'CLASS-ID', 'METHOD-ID',
]);

/** Paragrafi standard della ENVIRONMENT DIVISION (Area A). */
const ENV_PARAGRAPHS = new Set([
    'SOURCE-COMPUTER', 'OBJECT-COMPUTER', 'SPECIAL-NAMES',
    'FILE-CONTROL', 'I-O-CONTROL', 'REPOSITORY',
]);

/**
 * Rimuove il contenuto dei letterali stringa (sostituendolo con spazi) per
 * non far rilevare keyword/punti che si trovano dentro gli apici.
 * @param {string} text
 * @returns {string}
 */
function stripLit(text) {
    return text
        .replace(/'[^']*'/g, m => ' '.repeat(m.length))
        .replace(/"[^"]*"/g, m => ' '.repeat(m.length));
}

/**
 * Indica se il testo codice termina con un punto di fine frase.
 * @param {string} codeText - gia' trimmato
 * @returns {boolean}
 */
function endsWithTerminator(codeText) {
    return /\.$/.test(stripLit(codeText).replace(/\s+$/, ''));
}

/**
 * Determina la DIVISION introdotta da una riga, se presente.
 * @param {string} upper - testo codice in MAIUSCOLO
 * @returns {string|null}
 */
function divisionOf(upper) {
    const m = upper.match(/\b(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION\b/);
    return m ? m[1] : null;
}

/**
 * Indica se la riga e' un'intestazione di SECTION.
 * @param {string} upper
 * @returns {boolean}
 */
function isSectionHeader(upper) {
    return /^[A-Z0-9][A-Z0-9-]*\s+SECTION\b/.test(upper);
}

/**
 * Scompone una riga fixed nelle sue aree.
 * @param {string} raw
 * @returns {{ seq: string, indicator: string, code: string, idArea: string }}
 */
function splitLine(raw) {
    const seq = raw.substring(0, 6);
    const indicator = raw.length > 6 ? raw.charAt(6) : '';
    const code = raw.length > 7 ? raw.substring(7, CODE_END) : '';
    const idArea = raw.length > CODE_END ? raw.substring(CODE_END) : '';
    return { seq, indicator, code, idArea };
}

/**
 * Ricostruisce una riga di codice posizionando il testo alla colonna target,
 * preservando l'area sequenza (col 1-6) e l'area di identificazione (col 73+).
 * @param {string} seq
 * @param {string} idArea
 * @param {number} targetCol - colonna 1-based di inizio del codice
 * @param {string} codeText - testo codice (trimmato)
 * @returns {string}
 */
function buildLine(seq, idArea, targetCol, codeText) {
    const prefix = seq.padEnd(6, ' ') + ' '; // col 1-6 + indicatore (spazio)
    const indent = ' '.repeat(Math.max(0, targetCol - AREA_A));
    let area = indent + codeText;
    if (idArea !== '') {
        // Mantiene l'area di identificazione allineata alla colonna 73.
        const width = CODE_END - 7; // 65 colonne (col 8-72)
        if (area.length < width) area = area.padEnd(width, ' ');
        return prefix + area + idArea;
    }
    return (prefix + area).replace(/\s+$/, '');
}

/**
 * Indice (profondita') dell'ambito piu' interno del tipo richiesto.
 * @param {string[]} stack
 * @param {string} kind
 * @returns {number} indice, oppure -1
 */
function lastIndexOfKind(stack, kind) {
    for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j] === kind) return j;
    }
    return -1;
}

/**
 * Comprime le sequenze di spazi/tab in un singolo spazio, preservando il
 * contenuto dei letterali stringa (apici singoli o doppi). Rimuove gli spazi
 * finali.
 * @param {string} text
 * @returns {string}
 */
function collapseSpaces(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "'" || ch === '"') {
            const q = ch;
            out += ch;
            i++;
            while (i < text.length) {
                out += text[i];
                if (text[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            out += ' ';
            while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
            continue;
        }
        out += ch;
        i++;
    }
    return out.replace(/\s+$/, '');
}

/**
 * Unisce `before` e `after` su una sola riga allineando `after` (la keyword di
 * ancoraggio) alla colonna `alignCol`. Se la riga supererebbe la colonna 72,
 * riduce progressivamente lo spazio fino a un minimo di 1 byte (senza mai
 * cancellare contenuto).
 * @param {string} before - testo che precede l'ancora (gia' senza spazi finali)
 * @param {string} after - keyword di ancoraggio + resto (gia' compresso)
 * @param {number} col - colonna 1-based di inizio della riga
 * @param {number} [alignCol] - colonna 1-based di allineamento dell'ancora
 * @returns {{ text: string, overflow: boolean }}
 */
function joinAligned(before, after, col, alignCol = ALIGN_COL) {
    const maxLen = CODE_END - col + 1;       // caratteri disponibili (col..72)
    const targetIdx = alignCol - col;        // indice desiderato dell'ancora
    let gap = targetIdx - before.length;
    if (gap < 1) gap = 1;
    if (before.length + gap + after.length > maxLen) {
        const maxGap = maxLen - before.length - after.length;
        gap = maxGap >= 1 ? maxGap : 1;
    }
    const text = before + ' '.repeat(gap) + after;
    return { text, overflow: text.length > maxLen };
}

/**
 * Allinea le clausole di una voce dati: PIC (o, in assenza di PIC, VALUE per
 * gli 88) alla colonna `alignCol`. Se la riga supera la colonna 72 e non basta
 * ridurre lo spazio, spezza le clausole su piu' righe.
 * @param {string} codeText - testo codice (con numero di livello gia' normalizzato)
 * @param {number} col - colonna 1-based di inizio della voce
 * @param {number} [alignCol] - colonna 1-based di allineamento della clausola
 * @returns {{ col: number, text: string }[]}
 */
function alignDataClauses(codeText, col, alignCol = ALIGN_COL) {
    const collapsed = collapseSpaces(codeText.replace(/^\s+/, ''));
    const stripped = stripLit(collapsed).toUpperCase();
    let m = stripped.match(/\bPIC(?:TURE)?\b/);
    if (!m) m = stripped.match(/\bVALUES?\b/);
    if (!m || m.index === 0) {
        return [{ col, text: collapsed }];
    }
    const anchorIdx = m.index;
    const before = collapsed.substring(0, anchorIdx).replace(/\s+$/, '');
    const after = collapsed.substring(anchorIdx);
    const joined = joinAligned(before, after, col, alignCol);
    if (!joined.overflow) {
        return [{ col, text: joined.text }];
    }
    return splitDataClauses(before, after, col, alignCol);
}

/**
 * Spezza le clausole di una voce dati su piu' righe quando non stanno entro la
 * colonna 72. La clausola di ancoraggio resta in linea; la clausola VALUE (o le
 * successive) va a capo allineata alla colonna `alignCol`.
 * @param {string} before
 * @param {string} after - keyword di ancoraggio + resto (compresso)
 * @param {number} col
 * @param {number} [alignCol]
 * @returns {{ col: number, text: string }[]}
 */
function splitDataClauses(before, after, col, alignCol = ALIGN_COL) {
    const strippedAfter = stripLit(after).toUpperCase();
    const vm = strippedAfter.match(/\bVALUES?\b/);
    if (!vm || vm.index === 0) {
        // Nessun punto di taglio utile: riga unica, best-effort.
        const { text } = joinAligned(before, after, col, alignCol);
        return [{ col, text }];
    }
    const part1 = after.substring(0, vm.index).replace(/\s+$/, ''); // clausola PIC/...
    const part2 = after.substring(vm.index);                       // VALUE ...
    const seg1 = alignDataClauses(before + ' ' + part1, col, alignCol);
    const seg2 = { col: alignCol, text: collapseSpaces(part2) };
    return [...seg1, seg2];
}

/**
 * Restituisce la colonna 1-based della keyword VALUE nei segmenti renderizzati,
 * oppure 0 se non presente. Serve ad allineare i VALUE degli 88 a quello del
 * livello superiore.
 * @param {{ col: number, text: string }[]} segments
 * @returns {number}
 */
function valueColumnOf(segments) {
    for (const s of segments) {
        const stripped = stripLit(s.text).toUpperCase();
        const m = stripped.match(/\bVALUES?\b/);
        if (m) return s.col + m.index;
    }
    return 0;
}

/**
 * Allinea la keyword TO (per MOVE/SET/ADD) alla colonna ALIGN_COL.
 * @param {string} codeText
 * @param {number} col
 * @returns {string|null} testo allineato, oppure null se non applicabile
 */
function alignProcedureTo(codeText, col) {
    const collapsed = collapseSpaces(codeText);
    const stripped = stripLit(collapsed).toUpperCase();
    const m = stripped.match(/\bTO\b/);
    if (!m || m.index === 0) return null;
    const before = collapsed.substring(0, m.index).replace(/\s+$/, '');
    const after = collapsed.substring(m.index);
    return joinAligned(before, after, col).text;
}

/**
 * Rende uno o piu' segmenti come righe fisiche. Solo il primo segmento
 * conserva l'area sequenza (col 1-6) e l'area di identificazione (col 73+).
 * @param {{ col: number, text: string }[]} segments
 * @param {string} seq
 * @param {string} idArea
 * @returns {string}
 */
function renderSegments(segments, seq, idArea) {
    return segments.map((s, k) =>
        buildLine(k === 0 ? seq : '', k === 0 ? idArea : '', s.col, s.text)
    ).join('\n');
}

/**
 * Calcola il testo formattato per ogni riga del documento.
 * Lo stato (division, annidamento dati, blocchi PROCEDURE) viene calcolato a
 * partire dalla prima riga, indipendentemente dall'eventuale range richiesto.
 * @param {string[]} lines
 * @param {Set<number>} procDefLines - righe con definizione paragrafo/sezione (PROCEDURE)
 * @returns {string[]} testo formattato per ciascuna riga
 */
function computeFormatted(lines, procDefLines) {
    /** @type {string[]} */
    const out = new Array(lines.length);

    let division = '';
    /** @type {number[]} */
    let dataStack = [];
    /** @type {string[]} */
    let procStack = [];
    let dataPending = false;
    let dataContIndent = AREA_B;
    let dataValueCol = 0;
    const procState = { varyingActive: false, varyingEndCol: 0 };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];

        // Righe vuote -> stringa vuota (rimuove spazi).
        if (raw.trim() === '') { out[i] = ''; continue; }

        const indicator = raw.length > 6 ? raw.charAt(6) : '';
        // Commenti, continuazione, debug, direttive: invariati (solo trim finale).
        if (indicator === '*' || indicator === '/' || indicator === '-'
            || indicator === 'D' || indicator === 'd'
            || raw.trim().toUpperCase().startsWith('$SET')) {
            out[i] = raw.replace(/\s+$/, '');
            continue;
        }

        const { seq, code, idArea } = splitLine(raw);
        const codeText = code.replace(/^\s+/, '').replace(/\s+$/, '');
        if (codeText === '') { out[i] = ''; continue; }
        const upper = stripLit(codeText).toUpperCase();

        // --- Intestazioni di DIVISION ---
        const div = divisionOf(upper);
        if (div) {
            division = div;
            dataStack = []; procStack = []; dataPending = false;
            dataValueCol = 0; procState.varyingActive = false;
            out[i] = buildLine(seq, idArea, AREA_A, codeText);
            continue;
        }

        // --- Intestazioni di SECTION (qualsiasi division) ---
        if (isSectionHeader(upper)) {
            dataStack = []; procStack = []; dataPending = false;
            dataValueCol = 0; procState.varyingActive = false;
            out[i] = buildLine(seq, idArea, AREA_A, codeText);
            continue;
        }

        const firstWord = (upper.match(/^[A-Z0-9][A-Z0-9-]*/) || [''])[0];

        if (division === 'IDENTIFICATION') {
            const col = ID_PARAGRAPHS.has(firstWord) ? AREA_A : AREA_B;
            out[i] = buildLine(seq, idArea, col, codeText);
            continue;
        }

        if (division === 'ENVIRONMENT') {
            const col = ENV_PARAGRAPHS.has(firstWord) ? AREA_A : AREA_B;
            out[i] = buildLine(seq, idArea, col, codeText);
            continue;
        }

        if (division === 'DATA') {
            out[i] = formatDataLine(seq, idArea, codeText, upper, firstWord,
                dataStack, () => dataPending, v => { dataPending = v; },
                () => dataContIndent, v => { dataContIndent = v; },
                () => dataValueCol, v => { dataValueCol = v; });
            continue;
        }

        if (division === 'PROCEDURE') {
            // Definizione di paragrafo/sezione -> Area A, azzera i blocchi.
            if (procDefLines.has(i)) {
                procStack = [];
                procState.varyingActive = false;
                out[i] = buildLine(seq, idArea, AREA_A, codeText);
                continue;
            }
            out[i] = formatProcedureLine(seq, idArea, codeText, upper, procStack, procState);
            continue;
        }

        // Fuori da qualsiasi division nota: Area A.
        out[i] = buildLine(seq, idArea, AREA_A, codeText);
    }

    return out;
}

/**
 * Formatta una riga della DATA DIVISION.
 * @param {string} seq
 * @param {string} idArea
 * @param {string} codeText
 * @param {string} upper
 * @param {string} firstWord
 * @param {number[]} dataStack
 * @param {() => boolean} getPending
 * @param {(v: boolean) => void} setPending
 * @param {() => number} getContIndent
 * @param {(v: number) => void} setContIndent
 * @param {() => number} getValueCol
 * @param {(v: number) => void} setValueCol
 * @returns {string}
 */
function formatDataLine(seq, idArea, codeText, upper, firstWord, dataStack,
    getPending, setPending, getContIndent, setContIndent, getValueCol, setValueCol) {
    const ends = endsWithTerminator(codeText);

    // Voci FD/SD/RD/CD -> Area A, con 1 solo spazio prima del nome.
    if (/^(FD|SD|RD|CD)$/.test(firstWord)) {
        dataStack.length = 0;
        setPending(!ends);
        setContIndent(AREA_A + INDENT);
        setValueCol(0);
        const normalizedFd = codeText.replace(/^(FD|SD|RD|CD)\s+/, '$1 ');
        return buildLine(seq, idArea, AREA_A, normalizedFd);
    }

    // Voce dati con numero di livello.
    const lvlMatch = upper.match(/^(\d{1,2})\b/);
    if (lvlMatch) {
        const level = parseInt(lvlMatch[1], 10);
        // Esattamente 1 spazio tra livello e nome.
        const normalized = codeText.replace(/^(\d{1,2})\s+/, '$1 ');
        let col;
        if (level === 1 || level === 77) {
            dataStack.length = 0;
            if (level === 1) dataStack.push(1);
            col = AREA_A;
        } else if (level === 66) {
            col = AREA_A;
        } else if (level === 88) {
            col = AREA_A + dataStack.length * INDENT;
        } else {
            while (dataStack.length && dataStack[dataStack.length - 1] >= level) {
                dataStack.pop();
            }
            col = AREA_A + dataStack.length * INDENT;
            dataStack.push(level);
        }
        // Gli 88 allineano il VALUE a quello del livello superiore (se presente);
        // gli altri livelli allineano il PIC (o il proprio VALUE) alla colonna 45.
        let alignCol = ALIGN_COL;
        if (level === 88) {
            const pv = getValueCol();
            if (pv > 0) alignCol = pv;
        }
        const segments = alignDataClauses(normalized, col, alignCol);
        const lastText = segments[segments.length - 1].text;
        setPending(!endsWithTerminator(lastText));
        setContIndent(col + INDENT);
        // Memorizza la colonna del VALUE del livello superiore (non degli 88,
        // cosi' piu' 88 fratelli restano allineati allo stesso VALUE).
        if (level !== 88) setValueCol(valueColumnOf(segments));
        return renderSegments(segments, seq, idArea);
    }

    // Riga di continuazione o voce varia (es. COPY) nella DATA DIVISION.
    const clauseCont = getPending() && CLAUSE_KW.test(firstWord);
    const col = clauseCont ? ALIGN_COL : (getPending() ? getContIndent() : AREA_B);
    const contText = clauseCont ? collapseSpaces(codeText) : codeText;
    if (ends) setPending(false);
    return buildLine(seq, idArea, col, contText);
}

/**
 * Formatta una riga della PROCEDURE DIVISION applicando l'indentazione dei
 * blocchi (IF/ELSE, EVALUATE/WHEN, PERFORM inline). Il punto di fine frase
 * chiude tutti gli ambiti aperti.
 * @param {string} seq
 * @param {string} idArea
 * @param {string} codeText
 * @param {string} upper - testo in MAIUSCOLO senza letterali
 * @param {string[]} procStack
 * @param {{ varyingActive: boolean, varyingEndCol: number }} procState
 * @returns {string}
 */
function formatProcedureLine(seq, idArea, codeText, upper, procStack, procState) {
    const tokens = upper.match(/[A-Z0-9][A-Z0-9-]*/g) || [];
    const fw = tokens[0] || '';

    // Continuazione della condizione di un PERFORM VARYING: UNTIL si allinea
    // alla 'R' di VARYING, mentre AND/OR si allineano in modo che la fine della
    // parola coincida con la fine di VARYING.
    if (procState.varyingActive && (fw === 'UNTIL' || fw === 'AND' || fw === 'OR')) {
        const startCol = Math.max(AREA_B, procState.varyingEndCol - fw.length + 1);
        if (endsWithTerminator(codeText)) {
            procStack.length = 0;
            procState.varyingActive = false;
        }
        return buildLine(seq, idArea, startCol, codeText);
    }
    // Qualsiasi altra riga termina la modalita' di continuazione VARYING.
    procState.varyingActive = false;

    let drawDepth;
    let scanFrom;
    if (fw === 'ELSE') {
        const idx = lastIndexOfKind(procStack, 'IF');
        drawDepth = idx >= 0 ? idx : procStack.length;
        scanFrom = 1;
    } else if (fw === 'WHEN') {
        if (procStack[procStack.length - 1] === 'WHEN') procStack.pop();
        drawDepth = procStack.length;
        procStack.push('WHEN');
        scanFrom = 1;
    } else if (fw.startsWith('END-')) {
        const kind = fw.substring(4);
        const idx = lastIndexOfKind(procStack, kind);
        if (idx >= 0) { drawDepth = idx; procStack.length = idx; }
        else drawDepth = procStack.length;
        scanFrom = 1;
    } else {
        drawDepth = procStack.length;
        scanFrom = 0;
    }

    const col = AREA_B + drawDepth * INDENT;

    // Aggiorna lo stack con gli ambiti aperti/chiusi nel resto della riga.
    for (let t = scanFrom; t < tokens.length; t++) {
        const w = tokens[t];
        if (w === 'IF') {
            procStack.push('IF');
        } else if (w === 'EVALUATE') {
            procStack.push('EVALUATE');
        } else if (w === 'PERFORM') {
            const nxt = tokens[t + 1] || '';
            const inline = nxt === '' || nxt === 'UNTIL' || nxt === 'VARYING'
                || (/^\d+$/.test(nxt) && tokens[t + 2] === 'TIMES');
            if (inline) procStack.push('PERFORM');
        } else if (w === 'END-IF') {
            const idx = lastIndexOfKind(procStack, 'IF');
            if (idx >= 0) procStack.length = idx;
        } else if (w === 'END-EVALUATE') {
            const idx = lastIndexOfKind(procStack, 'EVALUATE');
            if (idx >= 0) procStack.length = idx;
        } else if (w === 'END-PERFORM') {
            const idx = lastIndexOfKind(procStack, 'PERFORM');
            if (idx >= 0) procStack.length = idx;
        } else if (w === 'WHEN') {
            if (procStack[procStack.length - 1] === 'WHEN') procStack.pop();
            procStack.push('WHEN');
        }
    }

    // Il punto di fine frase chiude tutti gli ambiti aperti.
    if (endsWithTerminator(codeText)) procStack.length = 0;

    // Allineamento della keyword TO alla colonna 45 (MOVE/SET/ADD).
    let outText = codeText;
    if (fw === 'MOVE' || fw === 'SET' || fw === 'ADD') {
        const aligned = alignProcedureTo(codeText, col);
        if (aligned !== null) outText = aligned;
    }

    // Attiva la modalita' di continuazione se la riga apre un PERFORM VARYING:
    // memorizza la colonna dell'ultima lettera di VARYING.
    if (tokens.includes('PERFORM') && tokens.includes('VARYING')) {
        const vm = stripLit(outText).toUpperCase().match(/\bVARYING\b/);
        if (vm) {
            procState.varyingActive = true;
            procState.varyingEndCol = col + vm.index + 6; // 'G' di VARYING (7 lettere)
        }
    }

    return buildLine(seq, idArea, col, outText);
}

/**
 * Rileva se il file usa un formato diverso da 'fixed' tramite direttiva $SET.
 * @param {string[]} lines
 * @returns {boolean} true se variable/free
 */
function isNonFixed(lines) {
    const limit = Math.min(lines.length, 20);
    for (let i = 0; i < limit; i++) {
        if (/\$SET\s+SOURCEFORMAT\s*\(\s*(VARIABLE|FREE)\s*\)/i.test(lines[i])) {
            return true;
        }
    }
    return false;
}

/**
 * Provider di formattazione (documento intero e selezione) per il COBOL fixed.
 */
class CobolFormattingProvider {
    /**
     * @param {import('./symbol-index').SymbolIndex} symbolIndex
     */
    constructor(symbolIndex) {
        this._symbolIndex = symbolIndex;
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Range|null} range
     * @returns {vscode.TextEdit[]}
     */
    _computeEdits(document, range) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('format.enabled', false)) return [];
        if (cfg.get('sourceFormat', 'fixed') !== 'fixed') return [];

        const lines = document.getText().split(/\r?\n/);
        if (isNonFixed(lines)) return [];

        // Righe con definizione di paragrafo/sezione nella PROCEDURE DIVISION.
        /** @type {Set<number>} */
        const procDefLines = new Set();
        for (const sym of this._symbolIndex.getSymbols(document)) {
            if ((sym.type === 'paragraph' || sym.type === 'section')
                && sym.filePath === document.uri.fsPath) {
                procDefLines.add(sym.line);
            }
        }

        const formatted = computeFormatted(lines, procDefLines);

        const startLine = range ? range.start.line : 0;
        const endLine = range ? range.end.line : lines.length - 1;

        /** @type {vscode.TextEdit[]} */
        const edits = [];
        for (let i = startLine; i <= endLine && i < lines.length; i++) {
            if (formatted[i] !== lines[i]) {
                edits.push(vscode.TextEdit.replace(
                    document.lineAt(i).range, formatted[i]));
            }
        }
        return edits;
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.TextEdit[]}
     */
    provideDocumentFormattingEdits(document) {
        return this._computeEdits(document, null);
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Range} range
     * @returns {vscode.TextEdit[]}
     */
    provideDocumentRangeFormattingEdits(document, range) {
        return this._computeEdits(document, range);
    }
}

module.exports = { CobolFormattingProvider, computeFormatted };
