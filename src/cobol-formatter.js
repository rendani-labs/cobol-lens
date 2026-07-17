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

/**
 * Opzioni di formattazione. I valori riflettono le impostazioni
 * `cobolLens.format.*`; i default corrispondono allo stile predefinito.
 * @typedef {Object} FormatOptions
 * @property {number} pictureColumn - colonna 1-based di allineamento PIC/VALUE.
 * @property {number} indentStep - passo di indentazione (dati e blocchi PROCEDURE).
 * @property {boolean} alignMoveTo - allinea il TO di MOVE/ADD alla colonna PIC.
 * @property {boolean} indentThru - indenta THRU/THROUGH sotto il PERFORM.
 * @property {boolean} sectionSeparators - inserisce righe separatore *---- (Stage 2).
 * @property {boolean} blankLines - inserisce righe vuote tra blocchi (Stage 2).
 */

/** @type {FormatOptions} */
const DEFAULT_OPTIONS = {
    pictureColumn: ALIGN_COL,
    indentStep: INDENT,
    alignMoveTo: true,
    indentThru: true,
    sectionSeparators: false,
    blankLines: false,
};

/**
 * Riempie le opzioni mancanti con i default e valida i valori numerici.
 * @param {Partial<FormatOptions>} [options]
 * @returns {FormatOptions}
 */
function normalizeOptions(options) {
    const o = Object.assign({}, DEFAULT_OPTIONS, options || {});
    if (!(o.pictureColumn >= AREA_B)) o.pictureColumn = ALIGN_COL;
    if (!(o.indentStep >= 1)) o.indentStep = INDENT;
    o.alignMoveTo = o.alignMoveTo !== false;
    o.indentThru = o.indentThru !== false;
    o.sectionSeparators = o.sectionSeparators === true;
    o.blankLines = o.blankLines === true;
    return o;
}

/**
 * Verbi che, a inizio riga, indicano contenuto di PROCEDURE. Servono a
 * riconoscere un copybook di soli statement (privo di intestazioni di DIVISION)
 * per formattarlo come PROCEDURE anziche' come tracciato dati.
 */
const PROC_VERBS = new Set([
    'PERFORM', 'MOVE', 'IF', 'ELSE', 'EVALUATE', 'WHEN', 'SET', 'ADD',
    'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'COMPUTE', 'DISPLAY', 'ACCEPT', 'CALL',
    'GO', 'GOBACK', 'STOP', 'READ', 'WRITE', 'REWRITE', 'DELETE', 'START',
    'OPEN', 'CLOSE', 'INITIALIZE', 'STRING', 'UNSTRING', 'INSPECT', 'SEARCH',
    'EXEC', 'CONTINUE', 'EXIT', 'RETURN', 'INVOKE', 'CANCEL', 'NEXT',
    'END-IF', 'END-EVALUATE', 'END-PERFORM', 'END-READ', 'END-CALL',
    'END-STRING', 'END-UNSTRING', 'END-SEARCH',
]);

/**
 * Euristica: un copybook senza intestazioni di DIVISION e' considerato di
 * PROCEDURE se tra le prime righe di codice significative (max 20) compare un
 * verbo COBOL a inizio riga. Altrimenti e' trattato come tracciato dati.
 * @param {string[]} lines
 * @returns {boolean}
 */
function detectCopybookProcedure(lines) {
    let scanned = 0;
    for (let i = 0; i < lines.length && scanned < 20; i++) {
        const raw = lines[i];
        if (raw.trim() === '') continue;
        const indicator = raw.length > 6 ? raw.charAt(6) : '';
        if (indicator === '*' || indicator === '/' || indicator === '-'
            || indicator === 'D' || indicator === 'd'
            || raw.trim().toUpperCase().startsWith('$SET')) continue;
        const code = (raw.length > 7 ? raw.substring(7, CODE_END) : '').trim();
        if (code === '') continue;
        scanned++;
        const fw = (stripLit(code).toUpperCase().match(/^[A-Z0-9][A-Z0-9-]*/) || [''])[0];
        if (PROC_VERBS.has(fw)) return true;
    }
    return false;
}

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
 * Indica se il testo contiene un letterale stringa non chiuso (numero dispari
 * di apici, tenendo conto dell'escape con apice doppio). Serve a capire se la
 * coda in colonna 73+ e' codice sbordato oltre la col 72 anziche' area di
 * identificazione.
 * @param {string} text
 * @returns {boolean}
 */
function hasUnterminatedLiteral(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"') {
            quote = ch;
        }
    }
    return quote !== null;
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
 * Indica se la riga appare come una voce della DATA DIVISION: numero di livello
 * (01-49, 66, 77, 88), voce FD/SD/RD/CD, oppure continuazione di una clausola
 * dati gia' aperta. Serve a formattare correttamente i copybook che contengono
 * solo il tracciato dati, privi dell'intestazione DATA DIVISION.
 * @param {string} upper - testo codice in MAIUSCOLO (senza letterali)
 * @param {string} firstWord
 * @param {boolean} dataPending - una clausola dati e' rimasta aperta dalla riga precedente
 * @returns {boolean}
 */
function looksLikeDataItem(upper, firstWord, dataPending) {
    if (/^\d{1,2}\b/.test(upper)) return true;
    if (/^(FD|SD|RD|CD)$/.test(firstWord)) return true;
    return dataPending;
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
 * gli 88) alla colonna `alignCol`. L'ancora va SEMPRE alla colonna di
 * allineamento (il gap si riduce solo se il nome la supererebbe); se la riga
 * eccede la colonna 72, il letterale del VALUE va a capo sotto il nome.
 * @param {string} codeText - testo codice (con numero di livello gia' normalizzato)
 * @param {number} col - colonna 1-based di inizio della voce
 * @param {number} [alignCol] - colonna 1-based di allineamento della clausola
 * @returns {{ col?: number, text?: string, raw?: string }[]}
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
    // L'ancora (PIC o VALUE) va sempre alla colonna di allineamento; il gap si
    // riduce solo se il nome la supererebbe (min 1 spazio). Il gap NON viene
    // compresso per far stare un VALUE lungo: in quel caso il valore va a capo.
    const maxLen = CODE_END - col + 1;
    let gap = (alignCol - col) - before.length;
    if (gap < 1) gap = 1;
    const oneLine = before + ' '.repeat(gap) + after;
    if (oneLine.length <= maxLen) {
        return [{ col, text: oneLine }];
    }
    return splitDataClauses(before, after, col, alignCol, gap);
}

/**
 * Spezza una voce dati troppo lunga: la clausola PIC resta in linea allineata
 * alla colonna di allineamento (seguita da VALUE), mentre il letterale del
 * VALUE va a capo: se ci sta, allineato alla colonna dell'ancora (la P di PIC);
 * altrimenti alla colonna iniziale del nome della variabile (piu' a sinistra,
 * quindi con piu' spazio disponibile).
 * @param {string} before - livello + nome (gia' senza spazi finali)
 * @param {string} after - keyword di ancoraggio (PIC/VALUE) + resto
 * @param {number} col - colonna 1-based di inizio della voce
 * @param {number} [alignCol] - colonna 1-based di allineamento dell'ancora
 * @param {number} [gap] - spazi tra `before` e l'ancora (per tenere l'ancora a alignCol)
 * @returns {{ col?: number, text?: string, raw?: string }[]}
 */
function splitDataClauses(before, after, col, alignCol = ALIGN_COL, gap) {
    // Colonna iniziale del nome della variabile (il letterale va sotto il nome).
    const sp = before.indexOf(' ');
    const nameCol = sp >= 0 ? col + sp + 1 : col;
    if (gap === undefined) {
        gap = (alignCol - col) - before.length;
        if (gap < 1) gap = 1;
    }
    const strippedAfter = stripLit(after).toUpperCase();
    const vm = strippedAfter.match(/\bVALUES?\b/);
    if (!vm) {
        // Nessuna clausola VALUE da mandare a capo: riga unica, best-effort.
        return [{ col, text: before + ' '.repeat(gap) + after }];
    }
    const kwLen = (after.slice(vm.index).match(/^\S+/) || ['VALUE'])[0].length;
    // Testa: "... PIC ... VALUE" (o solo "VALUE" per gli 88), con l'ancora a alignCol.
    const head = after.substring(0, vm.index + kwLen).replace(/\s+$/, '');
    // Operando: il letterale (e gli eventuali valori seguenti).
    const operand = after.substring(vm.index + kwLen).replace(/^\s+/, '');
    if (operand === '') {
        return [{ col, text: before + ' '.repeat(gap) + after }];
    }
    const line1 = before + ' '.repeat(gap) + head;
    // Il letterale a capo parte dalla colonna dell'ancora (col 45) se ci sta;
    // altrimenti dalla colonna del nome (piu' spazio a disposizione).
    if ((alignCol + operand.length - 1) <= CODE_END) {
        return [{ col, text: line1 }, { col: alignCol, text: operand }];
    }
    if ((nameCol + operand.length - 1) <= CODE_END) {
        return [{ col, text: line1 }, { col: nameCol, text: operand }];
    }
    // Troppo lungo anche dalla colonna del nome: se e' un singolo letterale
    // semplice, lo si spezza su piu' righe con la continuazione fixed (col 7 = '-').
    const cont = continuationSegments(operand, nameCol);
    if (cont) return [{ col, text: line1 }, ...cont];
    // Altrimenti best-effort su una riga (potrebbe eccedere la col 72).
    return [{ col, text: line1 }, { col: nameCol, text: operand }];
}

/**
 * Costruisce una riga fisica per la continuazione di un letterale: area
 * sequenza vuota, indicatore ('-' per le righe di continuazione, spazio per la
 * riga sorgente), quindi il testo a partire dalla colonna `anchor`. Le righe
 * intermedie arrivano esattamente alla colonna 72 (il contenuto non viene mai
 * troncato).
 * @param {boolean} isCont - true se e' una riga di continuazione (indicatore '-')
 * @param {number} anchor - colonna 1-based di inizio del testo (l'apice)
 * @param {string} codeStr - testo (apice + contenuto, con eventuale chiusura)
 * @returns {string}
 */
function buildContLine(isCont, anchor, codeStr) {
    return '      ' + (isCont ? '-' : ' ') + ' '.repeat(anchor - AREA_A) + codeStr;
}

/**
 * Spezza un singolo letterale non-numerico troppo lungo su piu' righe usando la
 * continuazione fixed (indicatore '-' in colonna 7, apice in Area B). Gestisce
 * SOLO un letterale semplice (nessun apice nel contenuto e nessun altro valore
 * dopo la chiusura); negli altri casi restituisce null (best-effort a monte).
 * Il contenuto viene preservato esattamente: le righe intermedie riempiono fino
 * alla colonna 72 e la concatenazione dei frammenti riproduce il letterale.
 * @param {string} operand - es. "'AAA...'." (apice + contenuto + apice + coda)
 * @param {number} startCol - colonna di partenza preferita (portata in Area B)
 * @returns {{ raw: string }[] | null}
 */
function continuationSegments(operand, startCol) {
    const q = operand.charAt(0);
    if (q !== "'" && q !== '"') return null;
    const close = operand.indexOf(q, 1);
    if (close < 0) return null;
    const content = operand.substring(1, close);
    const tail = operand.substring(close + 1);
    // Solo letterali semplici: niente apici nel contenuto o dopo la chiusura.
    if (content.indexOf(q) >= 0 || tail.indexOf("'") >= 0 || tail.indexOf('"') >= 0) {
        return null;
    }
    // La continuazione richiede l'apice in Area B (colonna >= 12).
    const anchor = Math.max(startCol, AREA_B);
    const lineCap = CODE_END - anchor;          // contenuto per riga piena (fino a col 72)
    const lastCap = lineCap - 1 - tail.length;  // contenuto sull'ultima riga (con chiusura + coda)
    if (lineCap < 2 || lastCap < 1) return null;

    /** @type {{ raw: string }[]} */
    const segs = [];
    if (content.length <= lastCap) {
        // Sta su una sola riga di continuazione (caso di confine).
        segs.push({ raw: buildContLine(false, anchor, q + content + q + tail) });
        return segs;
    }
    // Righe "piene" (riempite fino alla col 72) prima della riga di chiusura.
    const full = Math.ceil((content.length - lastCap) / lineCap);
    const closing = content.length - full * lineCap;
    // "Zona morta": l'ultima riga resterebbe senza contenuto (o eccederebbe).
    // In quel caso NON si spezza (best-effort a monte) per non corrompere il valore.
    if (closing < 1 || closing > lastCap) return null;

    let idx = 0;
    for (let f = 0; f < full; f++) {
        segs.push({ raw: buildContLine(f > 0, anchor, q + content.substr(idx, lineCap)) });
        idx += lineCap;
    }
    segs.push({ raw: buildContLine(full > 0, anchor, q + content.substring(idx) + q + tail) });
    return segs;
}

/**
 * Restituisce la colonna 1-based della keyword VALUE nei segmenti renderizzati,
 * oppure 0 se non presente. Serve ad allineare i VALUE degli 88 a quello del
 * livello superiore.
 * @param {{ col?: number, text?: string, raw?: string }[]} segments
 * @returns {number}
 */
function valueColumnOf(segments) {
    for (const s of segments) {
        if (s.text === undefined) continue;
        const stripped = stripLit(s.text).toUpperCase();
        const m = stripped.match(/\bVALUES?\b/);
        if (m) return s.col + m.index;
    }
    return 0;
}

/**
 * Allinea la keyword TO (per MOVE/ADD) alla colonna di allineamento.
 * @param {string} codeText
 * @param {number} col
 * @param {number} [alignCol]
 * @returns {string|null} testo allineato, oppure null se non applicabile
 */
function alignProcedureTo(codeText, col, alignCol = ALIGN_COL) {
    const collapsed = collapseSpaces(codeText);
    const stripped = stripLit(collapsed).toUpperCase();
    const m = stripped.match(/\bTO\b/);
    if (!m || m.index === 0) return null;
    const before = collapsed.substring(0, m.index).replace(/\s+$/, '');
    const after = collapsed.substring(m.index);
    return joinAligned(before, after, col, alignCol).text;
}

/**
 * Rende uno o piu' segmenti come righe fisiche. Solo il primo segmento
 * conserva l'area sequenza (col 1-6) e l'area di identificazione (col 73+).
 * @param {{ col?: number, text?: string, raw?: string }[]} segments
 * @param {string} seq
 * @param {string} idArea
 * @returns {string}
 */
function renderSegments(segments, seq, idArea) {
    return segments.map((s, k) => {
        if (s.raw !== undefined) return s.raw;
        return buildLine(k === 0 ? seq : '', k === 0 ? idArea : '', s.col, s.text);
    }).join('\n');
}

/**
 * Calcola il testo formattato per ogni riga del documento.
 * Lo stato (division, annidamento dati, blocchi PROCEDURE) viene calcolato a
 * partire dalla prima riga, indipendentemente dall'eventuale range richiesto.
 * @param {string[]} lines
 * @param {Set<number>} procDefLines - righe con definizione paragrafo/sezione (PROCEDURE)
 * @param {Partial<FormatOptions>} [options] - impostazioni di formattazione
 * @returns {string[]} testo formattato per ciascuna riga
 */
function computeFormatted(lines, procDefLines, options) {
    const opts = normalizeOptions(options);
    /** @type {string[]} */
    const out = new Array(lines.length);

    // Determina, per i copybook privi di intestazioni di DIVISION, se il
    // frammento e' di PROCEDURE (statement) o di dati (tracciato).
    const hasDivisionHeader = lines.some(l => {
        const ind = l.length > 6 ? l.charAt(6) : '';
        if (ind === '*' || ind === '/' || ind === '-' || ind === 'D' || ind === 'd') return false;
        const code = l.length > 7 ? l.substring(7, CODE_END) : '';
        return divisionOf(stripLit(code).toUpperCase()) !== null;
    });
    const headerlessProcedure = !hasDivisionHeader && detectCopybookProcedure(lines);

    let division = '';
    /** @type {number[]} */
    let dataStack = [];
    /** @type {string[]} */
    let procStack = [];
    let dataPending = false;
    let dataContIndent = AREA_B;
    let dataValueCol = 0;
    const procState = { varyingActive: false, varyingEndCol: 0, performCol: 0 };

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

        const { seq } = splitLine(raw);
        let { code, idArea } = splitLine(raw);
        // Se il codice (col 8-72) contiene un letterale non chiuso e c'e'
        // contenuto in col 73+, quella coda non e' area di identificazione ma
        // codice sbordato oltre la col 72: la si recupera come parte del codice.
        if (idArea !== '' && hasUnterminatedLiteral(code)) {
            code = code + idArea;
            idArea = '';
        }
        const codeText = code.replace(/^\s+/, '').replace(/\s+$/, '');
        if (codeText === '') { out[i] = ''; continue; }
        const upper = stripLit(codeText).toUpperCase();

        // --- Intestazioni di DIVISION ---
        const div = divisionOf(upper);
        if (div) {
            division = div;
            dataStack = []; procStack = []; dataPending = false;
            dataValueCol = 0; procState.varyingActive = false; procState.performCol = 0;
            out[i] = buildLine(seq, idArea, AREA_A, codeText);
            continue;
        }

        // --- Intestazioni di SECTION (qualsiasi division) ---
        if (isSectionHeader(upper)) {
            dataStack = []; procStack = []; dataPending = false;
            dataValueCol = 0; procState.varyingActive = false; procState.performCol = 0;
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
                () => dataValueCol, v => { dataValueCol = v; }, opts);
            continue;
        }

        if (division === 'PROCEDURE') {
            // Definizione di paragrafo/sezione -> Area A, azzera i blocchi.
            if (procDefLines.has(i)) {
                procStack = [];
                procState.varyingActive = false; procState.performCol = 0;
                out[i] = buildLine(seq, idArea, AREA_A, codeText);
                continue;
            }
            out[i] = formatProcedureLine(seq, idArea, codeText, upper, procStack, procState, opts);
            continue;
        }

        // Copybook senza intestazioni di DIVISION.
        if (division === '') {
            // Frammento di soli statement -> formattazione PROCEDURE.
            if (headerlessProcedure) {
                if (procDefLines.has(i)) {
                    procStack = [];
                    procState.varyingActive = false; procState.performCol = 0;
                    out[i] = buildLine(seq, idArea, AREA_A, codeText);
                    continue;
                }
                out[i] = formatProcedureLine(seq, idArea, codeText, upper, procStack, procState, opts);
                continue;
            }
            // Tracciato dati: numero di livello / FD-SD / continuazione di
            // clausola aperta -> indentazione gerarchica + PIC a colonna PIC.
            if (looksLikeDataItem(upper, firstWord, dataPending)) {
                out[i] = formatDataLine(seq, idArea, codeText, upper, firstWord,
                    dataStack, () => dataPending, v => { dataPending = v; },
                    () => dataContIndent, v => { dataContIndent = v; },
                    () => dataValueCol, v => { dataValueCol = v; }, opts);
                continue;
            }
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
 * @param {FormatOptions} opts
 * @returns {string}
 */
function formatDataLine(seq, idArea, codeText, upper, firstWord, dataStack,
    getPending, setPending, getContIndent, setContIndent, getValueCol, setValueCol, opts) {
    const indent = opts.indentStep;
    const ends = endsWithTerminator(codeText);

    // Voci FD/SD/RD/CD -> Area A, con 1 solo spazio prima del nome.
    if (/^(FD|SD|RD|CD)$/.test(firstWord)) {
        dataStack.length = 0;
        setPending(!ends);
        setContIndent(AREA_A + indent);
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
            col = AREA_A + dataStack.length * indent;
        } else {
            while (dataStack.length && dataStack[dataStack.length - 1] >= level) {
                dataStack.pop();
            }
            col = AREA_A + dataStack.length * indent;
            dataStack.push(level);
        }
        // Gli 88 allineano il VALUE a quello del livello superiore (se presente);
        // gli altri livelli allineano il PIC (o il proprio VALUE) alla colonna PIC.
        let alignCol = opts.pictureColumn;
        if (level === 88) {
            const pv = getValueCol();
            if (pv > 0) alignCol = pv;
        }
        const segments = alignDataClauses(normalized, col, alignCol);
        const last = segments[segments.length - 1];
        const lastText = last.text !== undefined ? last.text : last.raw;
        setPending(!endsWithTerminator(lastText));
        setContIndent(col + indent);
        // Memorizza la colonna del VALUE del livello superiore (non degli 88,
        // cosi' piu' 88 fratelli restano allineati allo stesso VALUE).
        if (level !== 88) setValueCol(valueColumnOf(segments));
        return renderSegments(segments, seq, idArea);
    }

    // Riga di continuazione o voce varia (es. COPY) nella DATA DIVISION.
    const clauseCont = getPending() && CLAUSE_KW.test(firstWord);
    const col = clauseCont ? opts.pictureColumn : (getPending() ? getContIndent() : AREA_B);
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
 * @param {{ varyingActive: boolean, varyingEndCol: number, performCol: number }} procState
 * @param {FormatOptions} opts
 * @returns {string}
 */
function formatProcedureLine(seq, idArea, codeText, upper, procStack, procState, opts) {
    const indent = opts.indentStep;
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

    // Continuazione THRU/THROUGH di un PERFORM out-of-line su riga precedente:
    // si indenta di un passo sotto la colonna del PERFORM.
    if (procState.performCol && opts.indentThru
        && (fw === 'THRU' || fw === 'THROUGH')) {
        const thruCol = procState.performCol + indent;
        if (endsWithTerminator(codeText)) {
            procStack.length = 0;
            procState.performCol = 0;
        }
        return buildLine(seq, idArea, thruCol, collapseSpaces(codeText));
    }
    // Qualsiasi altra riga chiude l'attesa di un THRU.
    procState.performCol = 0;

    let drawDepth;
    let scanFrom;
    if (fw === 'ELSE') {
        const idx = lastIndexOfKind(procStack, 'IF');
        drawDepth = idx >= 0 ? idx : procStack.length;
        scanFrom = 1;
    } else if (fw === 'WHEN') {
        // WHEN si allinea alla stessa colonna del suo EVALUATE; gli statement
        // del ramo WHEN rientrano di un livello (lo slot EVALUATE sullo stack).
        const idx = lastIndexOfKind(procStack, 'EVALUATE');
        if (idx >= 0) {
            drawDepth = idx;
            procStack.length = idx + 1; // mantiene EVALUATE, scarta il ramo WHEN precedente
        } else {
            drawDepth = procStack.length;
        }
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

    const col = AREA_B + drawDepth * indent;

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
            const idx = lastIndexOfKind(procStack, 'EVALUATE');
            if (idx >= 0) procStack.length = idx + 1;
        }
    }

    // Il punto di fine frase chiude tutti gli ambiti aperti.
    if (endsWithTerminator(codeText)) procStack.length = 0;

    // Allineamento della keyword TO. Per MOVE/ADD (configurabile) si porta il TO
    // alla colonna PIC; il SET resta sempre ravvicinato (spazi compressi).
    let outText = codeText;
    if (fw === 'SET') {
        outText = collapseSpaces(codeText);
    } else if ((fw === 'MOVE' || fw === 'ADD') && opts.alignMoveTo) {
        const aligned = alignProcedureTo(codeText, col, opts.pictureColumn);
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

    // PERFORM out-of-line (verso un paragrafo) senza THRU e non terminato:
    // memorizza la colonna per indentare l'eventuale THRU sulla riga seguente.
    if (fw === 'PERFORM' && !endsWithTerminator(codeText)) {
        const nxt = tokens[1] || '';
        const inlineOrVarying = nxt === '' || nxt === 'UNTIL' || nxt === 'VARYING'
            || (/^\d+$/.test(nxt) && tokens[2] === 'TIMES');
        const hasThru = tokens.includes('THRU') || tokens.includes('THROUGH');
        if (!inlineOrVarying && !hasThru) procState.performCol = col;
    }

    return buildLine(seq, idArea, col, outText);
}

// ---------------------------------------------------------------------------
// STAGE 2 (opt-in): inserimento di righe separatore e righe vuote tra blocchi.
// Opera sull'array 1:1 prodotto da computeFormatted e restituisce un nuovo
// array (le voci inserite sono '' o la riga separatore). E' insert-only e
// idempotente; la sicurezza (nessuna riga di codice alterata/persa) e'
// verificata a valle in formatDocument tramite codeSignature.
// ---------------------------------------------------------------------------

/** Riga separatore: '*' in col 7 seguito da trattini fino alla col 72. */
const SEPARATOR = '      *' + '-'.repeat(CODE_END - 7);

/** Sezioni della DATA DIVISION che ricevono un separatore (scelta utente). */
const DATA_SEP_SECTIONS = new Set(['WORKING-STORAGE', 'LINKAGE', 'FILE', 'LOCAL-STORAGE']);

/** Verbi di blocco/enfasi: separano i loro statement con una riga vuota. */
const BLOCK_VERBS = new Set(['IF', 'EVALUATE', 'PERFORM', 'SET', 'SEARCH']);

/** Suffissi dei paragrafi di uscita (nessun separatore, solo riga vuota). */
const EXIT_SUFFIX = /-(EX|EXIT|FINE|END|X|USCITA)$/;

/**
 * Colonna 1-based del primo carattere non-spazio di una riga (0 se vuota).
 * @param {string} line
 * @returns {number}
 */
function firstNonSpaceCol(line) {
    const m = line.match(/^(\s*)\S/);
    return m ? m[1].length + 1 : 0;
}

/**
 * Indica se la riga e' un separatore commento (col 7 = '*' e resto solo trattini).
 * @param {string} line
 * @returns {boolean}
 */
function isSeparatorLine(line) {
    if (line.length < 8) return false;
    if (line.charAt(6) !== '*') return false;
    const rest = line.substring(7).trim();
    return rest.length > 0 && /^-+$/.test(rest);
}

/**
 * Estrae la "firma" del codice: righe non vuote e non commento, con gli spazi
 * finali rimossi. Serve a garantire che lo Stage 2 non alteri nessuna riga di
 * codice reale (solo inserimento di righe vuote/commento).
 * @param {string[]} physLines
 * @returns {string[]}
 */
function codeSignature(physLines) {
    const sig = [];
    for (const l of physLines) {
        if (l.trim() === '') continue;
        const ind = l.length > 6 ? l.charAt(6) : '';
        if (ind === '*' || ind === '/') continue;
        sig.push(l.replace(/\s+$/, ''));
    }
    return sig;
}

/**
 * Applica lo Stage 2 (separatori + righe vuote tra blocchi) all'array 1:1
 * prodotto da computeFormatted.
 * @param {string[]} out - array formattato 1:1 (le voci possono essere multi-riga)
 * @param {string[]} lines - righe di input originali (stesso indice di out)
 * @param {Set<number>} procDefLines - indici di riga con paragrafo/sezione PROCEDURE
 * @param {FormatOptions} opts
 * @returns {string[]}
 */
function applyStage2(out, lines, procDefLines, opts) {
    /** @type {string[]} */
    const result = [];
    let division = '';
    let inProc = false;
    let stmtOpen = false;        // uno statement (sentence) e' aperto e prosegue
    let stmtStartKind = null;    // verbo iniziale della sentence corrente
    let stmtStartBase = false;   // la sentence corrente inizia a livello base (col 12)
    let prevBaseKind = null;     // verbo dell'ultima sentence base-level adiacente
    let blankAfterHeader = false;// va inserita una riga vuota dopo l'header di paragrafo

    const prevNonBlank = () => {
        for (let k = result.length - 1; k >= 0; k--) {
            const parts = result[k].split('\n');
            const t = parts[parts.length - 1];
            if (t.trim() !== '') return t;
        }
        return '';
    };
    const pushBlankIfNeeded = () => {
        if (result.length === 0) return;
        const parts = result[result.length - 1].split('\n');
        const last = parts[parts.length - 1];
        if (last.trim() !== '') result.push('');
    };
    const pushSepIfNeeded = () => {
        if (!isSeparatorLine(prevNonBlank())) result.push(SEPARATOR);
    };
    const resetStmt = () => {
        stmtOpen = false; stmtStartKind = null; stmtStartBase = false; prevBaseKind = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const fmt = out[i];
        const indicator = raw.length > 6 ? raw.charAt(6) : '';
        const isComment = indicator === '*' || indicator === '/';
        const isBlank = raw.trim() === '';
        const isCont = indicator === '-';
        const codeText = (raw.length > 7 ? raw.substring(7, CODE_END) : '').trim();
        const upper = stripLit(codeText).toUpperCase();
        const firstWord = (upper.match(/^[A-Z0-9][A-Z0-9-]*/) || [''])[0];

        const div = (!isComment && !isBlank && codeText) ? divisionOf(upper) : null;
        const isSection = (!isComment && !isBlank && codeText) ? isSectionHeader(upper) : false;

        // --- DIVISION header ---
        if (div) {
            if (opts.sectionSeparators && div !== 'IDENTIFICATION') pushSepIfNeeded();
            result.push(fmt);
            division = div; inProc = (div === 'PROCEDURE');
            resetStmt(); blankAfterHeader = false;
            continue;
        }
        // --- SECTION header ---
        if (isSection) {
            if (opts.sectionSeparators
                && (DATA_SEP_SECTIONS.has(firstWord) || division === 'PROCEDURE')) {
                pushSepIfNeeded();
            }
            result.push(fmt);
            resetStmt(); blankAfterHeader = false;
            continue;
        }
        // --- PROCEDURE paragraph header ---
        if (inProc && !isComment && !isBlank && codeText && procDefLines.has(i)) {
            const isExit = EXIT_SUFFIX.test(firstWord);
            if (isExit) {
                // Un paragrafo di uscita non riceve il separatore ma una riga
                // vuota (fa parte della delimitazione visiva del paragrafo).
                if (opts.sectionSeparators || opts.blankLines) pushBlankIfNeeded();
            } else if (opts.sectionSeparators) {
                pushSepIfNeeded();
            }
            result.push(fmt);
            resetStmt();
            blankAfterHeader = opts.blankLines && !isExit;
            continue;
        }
        // --- righe vuote / commento: passano invariate, azzerano l'adiacenza ---
        if (isBlank || isComment) {
            result.push(fmt);
            prevBaseKind = null; blankAfterHeader = false;
            continue;
        }
        // --- riga di continuazione: parte dello statement aperto ---
        if (isCont) { result.push(fmt); continue; }

        // --- riga di statement PROCEDURE ---
        if (inProc) {
            const firstPhys = fmt.split('\n')[0];
            const baseLevel = firstNonSpaceCol(firstPhys) === AREA_B;
            if (!stmtOpen) {
                // inizio di una nuova sentence
                if (blankAfterHeader) { pushBlankIfNeeded(); blankAfterHeader = false; }
                stmtStartKind = firstWord;
                stmtStartBase = baseLevel;
                if (opts.blankLines && baseLevel && prevBaseKind !== null
                    && (BLOCK_VERBS.has(firstWord) || BLOCK_VERBS.has(prevBaseKind))) {
                    pushBlankIfNeeded();
                }
            }
            result.push(fmt);
            if (endsWithTerminator(codeText)) {
                if (stmtStartBase && stmtStartKind) prevBaseKind = stmtStartKind;
                stmtOpen = false; stmtStartKind = null; stmtStartBase = false;
            } else {
                stmtOpen = true;
            }
            continue;
        }

        // --- altre righe (ID/ENV/DATA): invariate ---
        result.push(fmt);
        prevBaseKind = null;
    }
    return result;
}

/**
 * Formatta l'intero documento restituendo le righe fisiche finali. Se lo Stage 2
 * e' attivo applica separatori/righe vuote, ma solo dopo aver verificato che la
 * firma del codice non cambi (fail-safe: in caso contrario restituisce il
 * risultato del solo Stage 1).
 * @param {string[]} lines
 * @param {Set<number>} procDefLines
 * @param {Partial<FormatOptions>} [options]
 * @returns {string[]}
 */
function formatDocument(lines, procDefLines, options) {
    const opts = normalizeOptions(options);
    const formatted = computeFormatted(lines, procDefLines, opts);
    const stage1 = formatted.join('\n').split('\n');
    if (!opts.sectionSeparators && !opts.blankLines) return stage1;

    const stage2 = applyStage2(formatted, lines, procDefLines, opts).join('\n').split('\n');
    const before = codeSignature(stage1);
    const after = codeSignature(stage2);
    if (before.length !== after.length) return stage1;
    for (let k = 0; k < before.length; k++) {
        if (before[k] !== after[k]) return stage1;
    }
    return stage2;
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
     * @param {boolean} [force] - se true ignora il setting format.enabled
     *   (usato dai comandi espliciti COBOL Lens: Format Document / Selection).
     * @returns {vscode.TextEdit[]}
     */
    _computeEdits(document, range, force) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!force && !cfg.get('format.enabled', false)) return [];
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

        /** @type {Partial<FormatOptions>} */
        const opts = {
            pictureColumn: cfg.get('format.pictureColumn', ALIGN_COL),
            indentStep: cfg.get('format.indentStep', INDENT),
            alignMoveTo: cfg.get('format.alignMoveTo', true),
            indentThru: cfg.get('format.indentThru', true),
            sectionSeparators: cfg.get('format.sectionSeparators', false),
            blankLines: cfg.get('format.blankLines', false),
        };

        // Stage 2 (separatori / righe vuote) solo sul documento intero: inserisce
        // righe, quindi non e' compatibile con l'edit riga-per-riga usato per le
        // selezioni. Per la formattazione di una selezione resta attivo il solo
        // Stage 1 (indentazione/allineamento), che non cambia il numero di righe.
        const stage2 = (opts.sectionSeparators || opts.blankLines) && range === null;
        if (stage2) {
            const finalLines = formatDocument(lines, procDefLines, opts);
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const newText = finalLines.join(eol);
            if (newText === document.getText()) return [];
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length));
            return [vscode.TextEdit.replace(fullRange, newText)];
        }

        const formatted = computeFormatted(lines, procDefLines, opts);

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

    /**
     * Calcola gli edit per il comando esplicito "COBOL Lens: Format Document",
     * ignorando il setting format.enabled (l'utente ha richiesto l'azione).
     * @param {vscode.TextDocument} document
     * @returns {vscode.TextEdit[]}
     */
    computeDocumentEdits(document) {
        return this._computeEdits(document, null, true);
    }

    /**
     * Calcola gli edit per il comando esplicito "COBOL Lens: Format Selection",
     * ignorando il setting format.enabled.
     * @param {vscode.TextDocument} document
     * @param {vscode.Range} range
     * @returns {vscode.TextEdit[]}
     */
    computeRangeEdits(document, range) {
        return this._computeEdits(document, range, true);
    }
}

module.exports = { CobolFormattingProvider, computeFormatted, formatDocument };
