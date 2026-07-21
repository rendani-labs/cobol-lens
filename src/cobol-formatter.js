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
 * Verbi che aprono un ambito o una condizione: la loro continuazione su piu'
 * righe non e' un semplice elenco di operandi da allineare sotto il primo
 * operando (condizioni di IF/EVALUATE, VARYING/UNTIL di PERFORM, ecc.), quindi
 * sono esclusi dall'allineamento degli operandi di continuazione.
 */
const SCOPE_VERBS = new Set(['IF', 'EVALUATE', 'PERFORM', 'SEARCH']);

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

/** Colonna 1-based del valore dei paragrafi IDENTIFICATION (dopo "DATE-WRITTEN. "). */
const ID_VALUE_COL = 22;

/** Colonna 1-based delle clausole SELECT (ASSIGN/ORGANIZATION/...). */
const SELECT_CLAUSE_COL = 29;
/** Colonna 1-based del valore delle clausole SELECT. */
const SELECT_VALUE_COL = 42;

/**
 * Clausole della SELECT riconosciute, in ordine di priorita' (i prefissi piu'
 * lunghi vanno prima). `kw` e' la forma normalizzata; `strip` rimuove il
 * prefisso della clausola (incluso IS/MODE) lasciando il valore.
 */
const SELECT_CLAUSES = [
    { re: /^ASSIGN\s+TO\b/i, kw: 'ASSIGN TO', strip: /^ASSIGN\s+TO\s+/i },
    { re: /^ASSIGN\b/i, kw: 'ASSIGN TO', strip: /^ASSIGN\s+/i },
    { re: /^ALTERNATE\s+RECORD\s+KEY\b/i, kw: 'ALTERNATE RECORD KEY', strip: /^ALTERNATE\s+RECORD\s+KEY\s+(IS\s+)?/i },
    { re: /^RECORD\s+KEY\b/i, kw: 'RECORD KEY', strip: /^RECORD\s+KEY\s+(IS\s+)?/i },
    { re: /^FILE\s+STATUS\b/i, kw: 'STATUS', strip: /^FILE\s+STATUS\s+(IS\s+)?/i },
    { re: /^STATUS\b/i, kw: 'STATUS', strip: /^STATUS\s+(IS\s+)?/i },
    { re: /^ORGANIZATION\b/i, kw: 'ORGANIZATION', strip: /^ORGANIZATION\s+(IS\s+)?/i },
    { re: /^ACCESS\b/i, kw: 'ACCESS', strip: /^ACCESS\s+(MODE\s+)?(IS\s+)?/i },
    { re: /^RESERVE\b/i, kw: 'RESERVE', strip: /^RESERVE\s+/i },
    { re: /^LOCK\s+MODE\b/i, kw: 'LOCK MODE', strip: /^LOCK\s+MODE\s+(IS\s+)?/i },
    { re: /^PADDING\b/i, kw: 'PADDING', strip: /^PADDING\s+(CHARACTER\s+)?(IS\s+)?/i },
];

/**
 * Allinea una clausola SELECT: keyword normalizzata a `SELECT_CLAUSE_COL` e
 * valore a `SELECT_VALUE_COL` (con IS/MODE omessi). Restituisce la stringa
 * clausola posizionata a partire dalla colonna della keyword, oppure null se la
 * clausola non e' riconosciuta.
 * @param {string} clauseText
 * @returns {string|null}
 */
function alignSelectClause(clauseText) {
    const t = collapseSpaces(clauseText);
    for (const c of SELECT_CLAUSES) {
        if (c.re.test(t)) {
            const value = t.replace(c.strip, '').trim();
            let gap = (SELECT_VALUE_COL - SELECT_CLAUSE_COL) - c.kw.length;
            if (gap < 1) gap = 1;
            return value ? c.kw + ' '.repeat(gap) + value : c.kw;
        }
    }
    return null;
}

/**
 * Formatta una riga di FILE-CONTROL: SELECT a col 12 (con il nome file), la
 * clausola eventualmente presente sulla stessa riga e le clausole di
 * continuazione a `SELECT_CLAUSE_COL`. Se una clausola non e' riconosciuta la
 * riga viene lasciata in Area B (best-effort, nessuna perdita di token).
 * @param {string} seq
 * @param {string} idArea
 * @param {string} codeText
 * @param {boolean} isSelect - true se la riga inizia con SELECT
 * @returns {string}
 */
function formatSelectLine(seq, idArea, codeText, isSelect) {
    const collapsed = collapseSpaces(codeText);
    if (isSelect) {
        const m = collapsed.match(/^SELECT\s+(\S+)\s*(.*)$/i);
        if (!m) return buildLine(seq, idArea, AREA_B, collapsed);
        let text = 'SELECT ' + m[1];
        const clauseText = m[2].trim();
        if (clauseText) {
            const cl = alignSelectClause(clauseText);
            if (cl === null) return buildLine(seq, idArea, AREA_B, collapsed);
            let gap = SELECT_CLAUSE_COL - (AREA_B + text.length);
            if (gap < 1) gap = 1;
            text = text + ' '.repeat(gap) + cl;
        }
        return buildLine(seq, idArea, AREA_B, text);
    }
    const cl = alignSelectClause(collapsed);
    if (cl === null) return buildLine(seq, idArea, AREA_B, collapsed);
    return buildLine(seq, idArea, SELECT_CLAUSE_COL, cl);
}

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
 * Descrive la voce dati logica in corso di riunione tra piu' righe fisiche.
 * @typedef {Object} DataItemMerge
 * @property {number[]} indices - indici delle righe fisiche della voce.
 * @property {string} text - testo logico (livello + nome + clausole) riunito.
 * @property {number} col - colonna 1-based di inizio della voce.
 * @property {number} alignCol - colonna di allineamento della clausola.
 * @property {string} seq - area sequenza (col 1-6) della prima riga fisica.
 * @property {string} idArea - area di identificazione (col 73+) della prima riga.
 * @property {string[]} legacy - rendering "legacy" (per riga) da ripristinare.
 */

/**
 * Distribuisce i segmenti di una voce dati (ottenuti riunendo le sue righe
 * fisiche in un'unica riga logica e ri-spezzandola) sulle righe fisiche
 * originali `indices`, riscrivendo `out` in-place. Restituisce false se i
 * segmenti sono MENO delle righe fisiche: nel modello di edit riga-per-riga non
 * e' possibile rimuovere righe, quindi il chiamante ripristina il rendering
 * legacy. Se i segmenti sono di piu', quelli in eccedenza confluiscono
 * (multi-riga) sull'ultima riga fisica.
 * @param {string[]} out
 * @param {number[]} indices - indici fisici della voce (>= 2)
 * @param {{col?:number,text?:string,raw?:string}[]} segments
 * @param {string} seq
 * @param {string} idArea
 * @returns {boolean}
 */
function distributeDataSegments(out, indices, segments, seq, idArea) {
    const n = indices.length;
    if (segments.length < n) return false;
    for (let k = 0; k < n; k++) {
        const isFirst = k === 0;
        const segs = (k === n - 1) ? segments.slice(k) : [segments[k]];
        out[indices[k]] = renderSegments(segs, isFirst ? seq : '', isFirst ? idArea : '');
    }
    return true;
}

/**
 * Riunisce le righe fisiche di una voce dati in un'unica riga logica: quando
 * arriva una riga di continuazione di clausola (es. VALUE su riga separata), il
 * suo testo viene riattaccato a quello della voce e l'insieme viene ri-spezzato
 * con `alignDataClauses`. Cosi' la clausola resta accanto al PIC (colonna di
 * allineamento) e l'eventuale letterale lungo va a capo sotto il nome, invece di
 * restare isolato in colonna PIC ed eventualmente sforare la colonna 72. Se la
 * riunione non e' rappresentabile senza rimuovere righe, ripristina il
 * rendering legacy prodotto riga-per-riga.
 * @param {string[]} out
 * @param {number} i - indice fisico corrente
 * @param {{role?:string,col?:number,alignCol?:number,logicalText?:string,contText?:string}} mc
 * @param {DataItemMerge|null} dataItem
 * @param {string} seq
 * @param {string} idArea
 * @returns {DataItemMerge|null}
 */
function mergeDataItem(out, i, mc, dataItem, seq, idArea) {
    if (mc.role === 'level') {
        return {
            indices: [i], text: mc.logicalText || '', col: mc.col || AREA_A,
            alignCol: mc.alignCol || ALIGN_COL, seq, idArea, legacy: [out[i]],
        };
    }
    if (mc.role === 'cont' && dataItem) {
        const indices = dataItem.indices.concat(i);
        const legacy = dataItem.legacy.concat(out[i]);
        const joined = dataItem.text + ' ' + (mc.contText || '');
        const segs = alignDataClauses(joined, dataItem.col, dataItem.alignCol);
        if (distributeDataSegments(out, indices, segs, dataItem.seq, dataItem.idArea)) {
            if (endsWithTerminator(stripLit(joined).replace(/\s+$/, ''))) return null;
            return {
                indices, text: joined, col: dataItem.col, alignCol: dataItem.alignCol,
                seq: dataItem.seq, idArea: dataItem.idArea, legacy,
            };
        }
        // Riunione non rappresentabile: ripristina il rendering legacy.
        for (let k = 0; k < indices.length; k++) out[indices[k]] = legacy[k];
        return null;
    }
    return null;
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
    let envFileControl = false;
    let envSelect = false;
    // true quando un letterale non-numerico e' aperto e prosegue su righe
    // fisiche successive (continuazione fixed): quelle righe vanno lasciate
    // invariate per non spostarle e restare idempotenti.
    let litOpen = false;
    // Voce dati logica in corso di riunione tra piu' righe fisiche (es. una
    // clausola VALUE mandata su una riga separata): consente di riattaccare la
    // clausola alla voce e ri-spezzare l'insieme in modo coerente.
    /** @type {DataItemMerge|null} */
    let dataItem = null;
    // MOVE/ADD in sospeso la cui clausola TO/operando e' finita su una riga
    // successiva: consente di riunirlo su una riga (TO a col 45) o, se non ci
    // sta, di allineare il TO a col 45 sulla riga di continuazione.
    /** @type {{first:number,col:number,seq:string,idArea:string,logical:string}|null} */
    let procItem = null;
    const procState = { contAnchor: null, performCol: 0, stmtOpen: false, operandCol: 0 };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];

        // Righe vuote -> stringa vuota (rimuove spazi).
        if (raw.trim() === '') { out[i] = ''; dataItem = null; procItem = null; continue; }

        const indicator = raw.length > 6 ? raw.charAt(6) : '';

        // --- Continuazione di un letterale su piu' righe fisiche ---
        // In COBOL nessuna voce dati o statement valido inizia con un apice:
        // una riga il cui codice inizia con un apice e' quindi la continuazione
        // di un letterale della riga precedente (operando VALUE mandato a capo o
        // continuazione fixed con '-' in colonna 7). Tali righe, e quelle
        // interne a un letterale ancora aperto, vanno lasciate invariate: non
        // riposizionarle e' cio' che rende la formattazione idempotente.
        const contCode = raw.length > 7 ? raw.substring(7, CODE_END) : '';
        const contTrim = contCode.replace(/^\s+|\s+$/g, '');
        const startsQuote = contTrim.charAt(0) === "'" || contTrim.charAt(0) === '"';
        if (indicator !== '*' && indicator !== '/' && (litOpen || startsQuote)) {
            out[i] = raw.replace(/\s+$/, '');
            litOpen = hasUnterminatedLiteral(contTrim);
            // La riga del letterale non e' catturata in `dataItem`: chiude la
            // catena di riunione e, se termina la frase, azzera il pending.
            dataItem = null;
            procItem = null;
            if (!litOpen && endsWithTerminator(contTrim)) dataPending = false;
            continue;
        }

        // Commenti, continuazione, debug, direttive: invariati (solo trim finale).
        if (indicator === '*' || indicator === '/' || indicator === '-'
            || indicator === 'D' || indicator === 'd'
            || raw.trim().toUpperCase().startsWith('$SET')) {
            out[i] = raw.replace(/\s+$/, '');
            dataItem = null;
            procItem = null;
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
        // Righe PROCEDURE che portano una condizione VARYING/IF oltre la
        // colonna 72: recupera la coda (codice finito in area identificazione)
        // cosi' lo split/reflow della condizione lavora sul testo completo.
        if (idArea !== '' && division === 'PROCEDURE'
            && /(?:^|[^A-Za-z0-9-])(VARYING|IF)(?![A-Za-z0-9-])/i.test(stripLit(code).toUpperCase())) {
            code = code + idArea;
            idArea = '';
        }
        const codeText = code.replace(/^\s+/, '').replace(/\s+$/, '');
        if (codeText === '') { out[i] = ''; dataItem = null; procItem = null; continue; }
        const upper = stripLit(codeText).toUpperCase();

        // --- Intestazioni di DIVISION ---
        const div = divisionOf(upper);
        if (div) {
            division = div;
            dataStack = []; procStack = []; dataPending = false;
            dataValueCol = 0; procState.contAnchor = null; procState.performCol = 0;
            procState.stmtOpen = false; procState.operandCol = 0;
            envFileControl = false; envSelect = false; dataItem = null; procItem = null;
            out[i] = buildLine(seq, idArea, AREA_A, codeText);
            continue;
        }

        // --- Intestazioni di SECTION (qualsiasi division) ---
        if (isSectionHeader(upper)) {
            dataStack = []; procStack = []; dataPending = false;
            dataValueCol = 0; procState.contAnchor = null; procState.performCol = 0;
            procState.stmtOpen = false; procState.operandCol = 0;
            envFileControl = false; envSelect = false; dataItem = null; procItem = null;
            out[i] = buildLine(seq, idArea, AREA_A, codeText);
            continue;
        }

        const firstWord = (upper.match(/^[A-Z0-9][A-Z0-9-]*/) || [''])[0];

        if (division === 'IDENTIFICATION') {
            if (ID_PARAGRAPHS.has(firstWord)) {
                // Allinea il valore del paragrafo alla colonna 22.
                const m = codeText.match(/^([A-Z0-9][A-Z0-9-]*)\s*\.\s*(\S.*)$/i);
                if (m) {
                    const kw = m[1] + '.';
                    let gap = (ID_VALUE_COL - AREA_A) - kw.length;
                    if (gap < 1) gap = 1;
                    out[i] = buildLine(seq, idArea, AREA_A,
                        kw + ' '.repeat(gap) + collapseSpaces(m[2]));
                } else {
                    out[i] = buildLine(seq, idArea, AREA_A, codeText);
                }
            } else {
                out[i] = buildLine(seq, idArea, AREA_B, codeText);
            }
            continue;
        }

        if (division === 'ENVIRONMENT') {
            if (ENV_PARAGRAPHS.has(firstWord)) {
                envFileControl = (firstWord === 'FILE-CONTROL');
                envSelect = false;
                out[i] = buildLine(seq, idArea, AREA_A, codeText);
                continue;
            }
            if (envFileControl && (firstWord === 'SELECT' || envSelect)) {
                out[i] = formatSelectLine(seq, idArea, codeText, firstWord === 'SELECT');
                envSelect = !endsWithTerminator(codeText);
                continue;
            }
            out[i] = buildLine(seq, idArea, AREA_B, codeText);
            continue;
        }

        if (division === 'DATA') {
            const mc = { role: 'none' };
            out[i] = formatDataLine(seq, idArea, codeText, upper, firstWord,
                dataStack, () => dataPending, v => { dataPending = v; },
                () => dataContIndent, v => { dataContIndent = v; },
                () => dataValueCol, v => { dataValueCol = v; }, opts, mc);
            dataItem = mergeDataItem(out, i, mc, dataItem, seq, idArea);
            continue;
        }

        if (division === 'PROCEDURE') {
            // Definizione di paragrafo/sezione -> Area A, azzera i blocchi.
            if (procDefLines.has(i)) {
                procStack = [];
                procState.contAnchor = null; procState.performCol = 0;
                procState.stmtOpen = false; procState.operandCol = 0;
                procItem = null;
                out[i] = buildLine(seq, idArea, AREA_A, codeText);
                continue;
            }
            // IF con condizione composta: riformatta l'intero blocco condizione
            // (AND in coda, OR a inizio, operandi/operatori incolonnati).
            if (firstWord === 'IF') {
                const consumed = tryReflowIf(lines, i, out, procStack, procDefLines, opts, seq, idArea, codeText);
                if (consumed >= 0) {
                    procState.contAnchor = null; procState.performCol = 0;
                    procState.stmtOpen = false; procState.operandCol = 0;
                    procItem = null;
                    i = consumed;
                    continue;
                }
            }
            out[i] = formatProcedureLine(seq, idArea, codeText, upper, procStack, procState, opts);
            procItem = mergeProcMove(out, i, seq, idArea, codeText, firstWord, procState, procItem, opts);
            continue;
        }

        // Copybook senza intestazioni di DIVISION.
        if (division === '') {
            // Frammento di soli statement -> formattazione PROCEDURE.
            if (headerlessProcedure) {
                if (procDefLines.has(i)) {
                    procStack = [];
                    procState.contAnchor = null; procState.performCol = 0;
                    procState.stmtOpen = false; procState.operandCol = 0;
                    procItem = null;
                    out[i] = buildLine(seq, idArea, AREA_A, codeText);
                    continue;
                }
                out[i] = formatProcedureLine(seq, idArea, codeText, upper, procStack, procState, opts);
                procItem = mergeProcMove(out, i, seq, idArea, codeText, firstWord, procState, procItem, opts);
                continue;
            }
            // Tracciato dati: numero di livello / FD-SD / continuazione di
            // clausola aperta -> indentazione gerarchica + PIC a colonna PIC.
            if (looksLikeDataItem(upper, firstWord, dataPending)) {
                const mc = { role: 'none' };
                out[i] = formatDataLine(seq, idArea, codeText, upper, firstWord,
                    dataStack, () => dataPending, v => { dataPending = v; },
                    () => dataContIndent, v => { dataContIndent = v; },
                    () => dataValueCol, v => { dataValueCol = v; }, opts, mc);
                dataItem = mergeDataItem(out, i, mc, dataItem, seq, idArea);
                continue;
            }
        }

        // Fuori da qualsiasi division nota: Area A.
        out[i] = buildLine(seq, idArea, AREA_A, codeText);
        dataItem = null;
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
 * @param {{role?:string,col?:number,alignCol?:number,logicalText?:string,contText?:string}} [mc]
 *   contesto di riunione (in output): descrive il ruolo della riga ('level' per
 *   una voce con numero di livello, 'cont' per una continuazione di clausola,
 *   'none' altrimenti) e i dati per riattaccare le clausole spezzate su piu' righe.
 * @returns {string}
 */
function formatDataLine(seq, idArea, codeText, upper, firstWord, dataStack,
    getPending, setPending, getContIndent, setContIndent, getValueCol, setValueCol, opts, mc) {
    const indent = opts.indentStep;
    const ends = endsWithTerminator(codeText);
    if (mc) mc.role = 'none';

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
        if (mc) {
            mc.role = 'level';
            mc.col = col;
            mc.alignCol = alignCol;
            mc.logicalText = normalized;
        }
        return renderSegments(segments, seq, idArea);
    }

    // Riga di continuazione o voce varia (es. COPY) nella DATA DIVISION.
    const clauseCont = getPending() && CLAUSE_KW.test(firstWord);
    const col = clauseCont ? opts.pictureColumn : (getPending() ? getContIndent() : AREA_B);
    const contText = clauseCont ? collapseSpaces(codeText) : codeText;
    if (mc && clauseCont) {
        mc.role = 'cont';
        mc.contText = contText;
    }
    if (ends) setPending(false);
    return buildLine(seq, idArea, col, contText);
}

/**
 * Unisce un MOVE/ADD spezzato su piu' righe fisiche riportando la clausola TO
 * accanto agli operandi. Quando la riga di apertura (`MOVE ...`/`ADD ...`) non
 * contiene ancora un `TO <operando>` e non termina con il punto, viene messa in
 * sospeso; alla riga di continuazione successiva si prova a unire il tutto su
 * una sola riga con il `TO` allineato alla colonna PIC (45). Se non ci sta entro
 * la colonna 72, si resta su due righe con il `TO` comunque a colonna 45; la
 * riga di continuazione svuotata resta vuota (il modello di edit 1:1 non rimuove
 * righe). Vale solo per MOVE/ADD.
 * @param {string[]} out
 * @param {number} i - indice fisico corrente
 * @param {string} seq
 * @param {string} idArea
 * @param {string} codeText
 * @param {string} firstWord
 * @param {{ stmtOpen: boolean }} procState
 * @param {{first:number,col:number,seq:string,idArea:string,logical:string}|null} procItem
 * @param {FormatOptions} opts
 * @returns {{first:number,col:number,seq:string,idArea:string,logical:string}|null}
 */
function mergeProcMove(out, i, seq, idArea, codeText, firstWord, procState, procItem, opts) {
    if (procItem) {
        // Riga di continuazione del MOVE/ADD in sospeso: se ora compare il TO,
        // unisci; altrimenti abbandona (nessun accumulo oltre una riga).
        const collapsed = collapseSpaces(procItem.logical + ' ' + codeText);
        const stripped = stripLit(collapsed).toUpperCase();
        const mTo = stripped.match(/\bTO\b/);
        if (mTo && mTo.index > 0) {
            const before = collapsed.substring(0, mTo.index).replace(/\s+$/, '');
            const after = collapsed.substring(mTo.index);
            const joined = joinAligned(before, after, procItem.col, opts.pictureColumn);
            if (!joined.overflow) {
                // Ci sta su una riga: unisci sulla prima, svuota la continuazione.
                out[procItem.first] = buildLine(procItem.seq, procItem.idArea, procItem.col, joined.text);
                out[i] = '';
            } else {
                // Non ci sta: resta su due righe, con il TO a colonna PIC.
                out[procItem.first] = buildLine(procItem.seq, procItem.idArea, procItem.col, before);
                out[i] = buildLine(seq, idArea, opts.pictureColumn, after);
            }
        }
        return null;
    }
    if ((firstWord === 'MOVE' || firstWord === 'ADD') && procState.stmtOpen) {
        // Solo se il TO con operando NON e' gia' presente sulla riga.
        if (!/\bTO\b\s+\S/.test(stripLit(codeText).toUpperCase())) {
            const first = out[i].split('\n')[0];
            // Colonna del codice: si cerca dal carattere 8 (col 8) in poi, per
            // NON confondere l'area sequenza (col 1-6) con l'inizio del codice.
            const rel = first.substring(7).search(/\S/);
            if (rel >= 0) {
                return { first: i, col: 8 + rel, seq, idArea, logical: collapseSpaces(codeText) };
            }
        }
    }
    return null;
}

/**
 * Indice (0-based) di `word` in `upper` come parola COBOL (delimitata da
 * caratteri non alfanumerici e non trattino), a partire da `from`. -1 se assente.
 * @param {string} upper - testo in MAIUSCOLO (idealmente gia' senza letterali)
 * @param {string} word
 * @param {number} [from]
 * @returns {number}
 */
function cobolWordIndex(upper, word, from = 0) {
    let idx = upper.indexOf(word, from);
    while (idx >= 0) {
        const b = idx > 0 ? upper[idx - 1] : ' ';
        const a = idx + word.length < upper.length ? upper[idx + word.length] : ' ';
        if (!/[A-Za-z0-9-]/.test(b) && !/[A-Za-z0-9-]/.test(a)) return idx;
        idx = upper.indexOf(word, idx + 1);
    }
    return -1;
}

/**
 * Spezza una condizione (che inizia con UNTIL) nei suoi segmenti a ogni parola
 * UNTIL/AND/OR (parole COBOL, fuori dai letterali), preservando le parentesi
 * dove compaiono. Ogni segmento inizia con la sua keyword.
 * @param {string} condText
 * @returns {string[]}
 */
function splitAnchorSegments(condText) {
    const upper = stripLit(condText).toUpperCase();
    const positions = [];
    const re = /UNTIL|AND|OR/g;
    let m;
    while ((m = re.exec(upper)) !== null) {
        const s = m.index;
        const e = s + m[0].length;
        const before = s > 0 ? upper[s - 1] : ' ';
        const after = e < upper.length ? upper[e] : ' ';
        if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) positions.push(s);
    }
    if (positions.length === 0) return [condText.replace(/\s+$/, '')];
    const segs = [];
    for (let k = 0; k < positions.length; k++) {
        const start = positions[k];
        const end = k + 1 < positions.length ? positions[k + 1] : condText.length;
        segs.push(condText.substring(start, end).replace(/\s+$/, ''));
    }
    return segs;
}

/**
 * Costruisce una riga di clausola ancorata a destra: la keyword iniziale
 * (UNTIL/AND/OR/INTO) termina alla colonna `anchorEndCol`; se dopo la keyword
 * c'e' una parentesi aperta viene attaccata (senza spazio) cosi' l'operando
 * resta allineato con quello delle altre clausole, altrimenti un solo spazio.
 * @param {string} seq
 * @param {string} idArea
 * @param {string} segText - segmento (keyword + resto)
 * @param {number} anchorEndCol - colonna 1-based dell'ultima lettera della keyword
 * @returns {string}
 */
function buildAnchorLine(seq, idArea, segText, anchorEndCol) {
    const collapsed = collapseSpaces(segText);
    const m = collapsed.match(/^([A-Za-z]+)([\s\S]*)$/);
    const kw = m ? m[1] : collapsed;
    const rest = m ? m[2].replace(/^\s+/, '') : '';
    const startCol = Math.max(AREA_B, anchorEndCol - kw.length + 1);
    let text;
    if (rest.startsWith('(')) text = kw + rest;
    else if (rest) text = kw + ' ' + rest;
    else text = kw;
    return buildLine(seq, idArea, startCol, text);
}

/**
 * Riformatta una condizione IF composta (con AND/OR) nello stile richiesto:
 *  - ogni sotto-condizione su una riga, con gli operandi allineati alla colonna
 *    OP_COL (subito dopo "IF ");
 *  - AND in coda alla riga precedente, OR a inizio riga;
 *  - parentesi aperta "sospesa" a OP_COL-1 (l'operando resta a OP_COL).
 * Restituisce un array di righe logiche { col, text } (senza area sequenza/id),
 * oppure null se la condizione e' semplice (nessun AND/OR di primo livello) e
 * non richiede riformattazione. NOTA: prima versione (solo struttura); l'ulteriore
 * incolonnamento di operatori/valori sara' aggiunto in un passo successivo.
 * @param {string} condText - testo della condizione (senza "IF" iniziale)
 * @param {number} ifCol - colonna 1-based della parola IF
 * @returns {{col:number,text:string}[]|null}
 */
function reflowIfCondition(condText, ifCol) {
    const OP_COL = ifCol + 3; // colonna degli operandi (dopo "IF ")
    const upper = stripLit(condText).toUpperCase();
    // Connettori AND/OR come parole COBOL.
    const conns = [];
    const re = /AND|OR/g;
    let m;
    while ((m = re.exec(upper)) !== null) {
        const s = m.index;
        const e = s + m[0].length;
        const b = s > 0 ? upper[s - 1] : ' ';
        const a = e < upper.length ? upper[e] : ' ';
        if (/[A-Za-z0-9-]/.test(b) || /[A-Za-z0-9-]/.test(a)) continue;
        conns.push({ s, e, kind: upper.substring(s, e) });
    }
    if (conns.length === 0) return null;
    // Sotto-condizioni (testo tra i connettori).
    const conds = [];
    let last = 0;
    for (const c of conns) { conds.push(collapseSpaces(condText.substring(last, c.s)).trim()); last = c.e; }
    conds.push(collapseSpaces(condText.substring(last)).trim());

    // Parse di ogni sotto-condizione in operando / NOT / operatore / valore
    // (parentesi aperta iniziale a parte). Serve a incolonnare =/EQUAL e valori.
    const parsed = conds.map((cond) => {
        const leadParen = /^\(/.test(cond);
        const core = leadParen ? cond.replace(/^\(\s*/, '') : cond;
        const mm = core.match(/^(.*?)\s+(NOT\s+)?(<>|>=|<=|=|>|<|EQUALS?|UNEQUAL)\s+(.+)$/i);
        if (mm) {
            return {
                leadParen, hasOp: true,
                operand: mm[1].trim(),
                notKw: mm[2] ? 'NOT' : '',
                op: mm[3].trim(),
                value: mm[4].trim(),
            };
        }
        return { leadParen, hasOp: false, operand: core.trim(), notKw: '', op: '', value: '' };
    });

    // Colonne di allineamento operatore/valore (assolute), su tutte le
    // sotto-condizioni con operatore. L'operando parte sempre a OP_COL.
    let operCol = 0;
    let maxOp = 0;
    for (const p of parsed) {
        if (!p.hasOp) continue;
        const notLen = p.notKw ? p.notKw.length + 1 : 0; // "NOT "
        operCol = Math.max(operCol, OP_COL + p.operand.length + 1 + notLen);
        maxOp = Math.max(maxOp, p.op.length);
    }
    const valCol = operCol > 0 ? operCol + maxOp + 1 : 0;

    // Corpo (a partire dall'operando in OP_COL) con operatore/valore incolonnati.
    const buildCore = (p) => {
        let core = p.operand;
        if (p.hasOp) {
            const opRel = (p.notKw ? operCol - (p.notKw.length + 1) : operCol) - OP_COL;
            while (core.length < opRel) core += ' ';
            if (p.notKw) core += p.notKw + ' ';
            core += p.op;
            const valRel = valCol - OP_COL;
            while (core.length < valRel) core += ' ';
            core += p.value;
        }
        return core;
    };

    const lines = [];
    for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const connBefore = i > 0 ? conns[i - 1].kind : null;
        const connAfter = i < conns.length ? conns[i].kind : null;
        const core = buildCore(p);
        let col;
        let text;
        if (i === 0) {
            col = ifCol; text = 'IF ' + core;
        } else if (connBefore === 'OR') {
            col = ifCol; text = 'OR ' + core;
        } else { // AND era in coda alla riga precedente
            if (p.leadParen) { col = OP_COL - 1; text = '(' + core; }
            else { col = OP_COL; text = core; }
        }
        if (connAfter === 'AND') text = text + ' AND';
        lines.push({ col, text });
    }
    return lines;
}

/**
 * Prova a riformattare un blocco IF con condizione composta: raccoglie la
 * condizione dalla riga IP e dalle sue righe di continuazione, la riformatta con
 * `reflowIfCondition` e distribuisce le righe risultanti sulle righe fisiche
 * raccolte (riscrivendo `out` in-place). Apre l'ambito IF sullo stack.
 * Restituisce l'indice dell'ultima riga consumata, oppure -1 se non applicabile
 * (condizione semplice, statement in linea, o non rappresentabile senza
 * rimuovere righe): in tal caso il chiamante formatta la riga IF normalmente.
 * @param {string[]} lines
 * @param {number} i - indice della riga IF
 * @param {string[]} out
 * @param {string[]} procStack
 * @param {Set<number>} procDefLines
 * @param {FormatOptions} opts
 * @param {string} seq
 * @param {string} idArea
 * @param {string} ifCodeText - codice (trimmato) della riga IF
 * @returns {number}
 */
function tryReflowIf(lines, i, out, procStack, procDefLines, opts, seq, idArea, ifCodeText) {
    const indent = opts.indentStep;
    const ifCol = AREA_B + procStack.length * indent;
    const mIf = ifCodeText.match(/^IF\b\s*/i);
    if (!mIf) return -1;
    const cond0 = ifCodeText.substring(mIf[0].length);
    // Niente reflow se sulla riga IF c'e' un verbo (statement in linea) o
    // THEN/ELSE/END-... (troppo rischioso da riformattare).
    const tokens0 = stripLit(cond0).toUpperCase().match(/[A-Z0-9][A-Z0-9-]*/g) || [];
    for (const t of tokens0) {
        if (PROC_VERBS.has(t) || t === 'THEN' || t === 'ELSE' || t.startsWith('END-')) return -1;
    }
    const gathered = [i];
    const parts = [cond0.replace(/\s+$/, '')];
    let ended = endsWithTerminator(cond0);
    let j = i + 1;
    while (!ended && j < lines.length) {
        const raw = lines[j];
        if (raw.trim() === '') break;
        const ind = raw.length > 6 ? raw.charAt(6) : '';
        if (ind === '*' || ind === '/' || ind === '-' || ind === 'D' || ind === 'd') break;
        if (raw.trim().toUpperCase().startsWith('$SET')) break;
        if (procDefLines.has(j)) break;
        let code = raw.length > 7 ? raw.substring(7, CODE_END) : '';
        const idA = raw.length > CODE_END ? raw.substring(CODE_END) : '';
        if (idA !== '' && hasUnterminatedLiteral(code)) code = code + idA;
        const ct = code.replace(/^\s+|\s+$/g, '');
        if (ct === '') break;
        const up = stripLit(ct).toUpperCase();
        const fw = (up.match(/^[A-Z0-9][A-Z0-9-]*/) || [''])[0];
        if (PROC_VERBS.has(fw) || fw === 'ELSE' || fw === 'WHEN' || fw.startsWith('END-')
            || divisionOf(up) || isSectionHeader(up)) break;
        parts.push(ct.replace(/\s+$/, ''));
        gathered.push(j);
        if (endsWithTerminator(ct)) ended = true;
        j++;
    }
    const fullCond = parts.join(' ').trim();
    const reflowed = reflowIfCondition(fullCond, ifCol);
    if (!reflowed) return -1;
    const phys = reflowed.map((l, k) =>
        buildLine(k === 0 ? seq : '', k === 0 ? idArea : '', l.col, l.text));
    // Il modello di edit 1:1 non rimuove righe: servono almeno tante righe
    // fisiche quante le righe raccolte.
    if (phys.length < gathered.length) return -1;
    for (let k = 0; k < gathered.length; k++) {
        out[gathered[k]] = (k === gathered.length - 1) ? phys.slice(k).join('\n') : phys[k];
    }
    procStack.push('IF');
    if (ended) procStack.length = 0;
    return gathered[gathered.length - 1];
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
 * @param {{ contAnchor: ({endCol:number,words:string[]}|null), performCol: number, stmtOpen: boolean, operandCol: number }} procState
 * @param {FormatOptions} opts
 * @returns {string}
 */
function formatProcedureLine(seq, idArea, codeText, upper, procStack, procState, opts) {
    const indent = opts.indentStep;
    const tokens = upper.match(/[A-Z0-9][A-Z0-9-]*/g) || [];
    const fw = tokens[0] || '';

    // Continuazione di una clausola ancorata a destra su righe successive:
    //  - dopo VARYING: UNTIL/AND/OR terminano alla stessa colonna di VARYING;
    //  - dopo STRING/UNSTRING: INTO termina alla stessa colonna di STRING.
    // La parola viene allineata a destra sull'ancora memorizzata.
    if (procState.contAnchor && procState.contAnchor.words.indexOf(fw) >= 0) {
        const anchorEndCol = procState.contAnchor.endCol;
        if (endsWithTerminator(codeText)) {
            procStack.length = 0;
            procState.contAnchor = null;
        }
        // Spezza anche gli eventuali AND/OR presenti sulla stessa riga di
        // continuazione, cosi' ogni clausola va su una riga propria allineata a
        // destra (coerente con lo split del PERFORM VARYING su una riga sola).
        const segs = splitAnchorSegments(codeText);
        return segs.map((s, k) =>
            buildAnchorLine(k === 0 ? seq : '', k === 0 ? idArea : '', s, anchorEndCol)
        ).join('\n');
    }
    // Qualsiasi altra riga chiude l'ancoraggio di continuazione.
    procState.contAnchor = null;

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

    // Continuazione di operandi di uno statement semplice aperto: la riga
    // precedente era un verbo senza punto finale e questa riga non inizia con un
    // verbo/delimitatore, quindi e' un operando (o una clausola come TO/FROM)
    // che va allineato sotto il primo operando della riga di apertura.
    const isStmtStartKw = PROC_VERBS.has(fw) || fw === 'ELSE' || fw === 'WHEN'
        || fw.startsWith('END-');
    if (procState.stmtOpen && procState.operandCol > 0 && !isStmtStartKw) {
        const alignCol = procState.operandCol;
        if (endsWithTerminator(codeText)) {
            procState.stmtOpen = false;
            procState.operandCol = 0;
            procStack.length = 0;
        }
        return buildLine(seq, idArea, alignCol, collapseSpaces(codeText));
    }
    // Una qualsiasi altra riga (nuovo verbo o delimitatore) chiude l'eventuale
    // statement semplice rimasto aperto; verra' riaperto in fondo se questa
    // stessa riga e' un nuovo statement semplice non terminato.
    procState.stmtOpen = false;
    procState.operandCol = 0;

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

    // Compressione degli spazi interni (literal-aware) per tutti gli statement
    // PROCEDURE: le parole restano separate da un solo spazio (es.
    // "INITIALIZE   AREA" -> "INITIALIZE AREA"), preservando gli spazi dentro
    // le stringhe. Per MOVE/ADD, se attivo l'allineamento del TO (che gestisce
    // da se' la spaziatura fino alla colonna PIC) ha la priorita'.
    let outText = collapseSpaces(codeText);
    if ((fw === 'MOVE' || fw === 'ADD') && opts.alignMoveTo) {
        const aligned = alignProcedureTo(codeText, col, opts.pictureColumn);
        if (aligned !== null) outText = aligned;
    }

    // Imposta l'ancoraggio di continuazione per l'allineamento a destra delle
    // clausole portate su righe successive:
    //  - PERFORM ... VARYING (o riga che inizia con VARYING): UNTIL/AND/OR si
    //    allineano a destra alla fine di VARYING;
    //  - STRING/UNSTRING: INTO si allinea a destra alla fine di STRING/UNSTRING.
    const anchorUpper = stripLit(outText).toUpperCase();
    if (fw === 'VARYING' || (tokens.includes('PERFORM') && tokens.includes('VARYING'))) {
        const vm = anchorUpper.match(/\bVARYING\b/);
        if (vm) {
            const anchorEndCol = col + vm.index + 6;
            const untilIdx = cobolWordIndex(anchorUpper, 'UNTIL', vm.index + 7);
            if (untilIdx >= 0) {
                // UNTIL sulla stessa riga: spezza la condizione su piu' righe
                // fisiche, con UNTIL/OR/AND allineati a destra alla fine di
                // VARYING (gli operandi risultano incolonnati).
                const before = outText.substring(0, untilIdx).replace(/\s+$/, '');
                const cond = outText.substring(untilIdx);
                const segs = splitAnchorSegments(cond);
                const physical = [buildLine(seq, idArea, col, collapseSpaces(before))];
                for (const s of segs) physical.push(buildAnchorLine('', '', s, anchorEndCol));
                if (endsWithTerminator(codeText)) procStack.length = 0;
                return physical.join('\n');
            }
            procState.contAnchor = { endCol: anchorEndCol, words: ['UNTIL', 'AND', 'OR'] };
        }
    } else if (fw === 'STRING' || fw === 'UNSTRING') {
        const sm = anchorUpper.match(/\b(UN)?STRING\b/);
        if (sm) {
            procState.contAnchor = { endCol: col + sm.index + (sm[0] === 'UNSTRING' ? 7 : 5), words: ['INTO'] };
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

    // PERFORM ... THRU inline (range) su una sola riga: porta il THRU sulla riga
    // sotto, indentato di un passo (stile template), se indentThru e' attivo.
    if (fw === 'PERFORM' && opts.indentThru) {
        const sm = stripLit(outText).toUpperCase().match(/\bTHR(?:U|OUGH)\b/);
        if (sm && sm.index > 0) {
            const p1 = collapseSpaces(outText.substring(0, sm.index).replace(/\s+$/, ''));
            const p2 = collapseSpaces(outText.substring(sm.index));
            return buildLine(seq, idArea, col, p1) + '\n'
                + buildLine('', '', col + indent, p2);
        }
    }

    // Statement semplice (non di ambito) non terminato dal punto: resta aperto
    // e le eventuali righe successive di soli operandi si allineeranno sotto il
    // primo operando (colonna = inizio codice + verbo + 1 spazio).
    const isSimpleStmt = PROC_VERBS.has(fw) && !SCOPE_VERBS.has(fw)
        && fw !== 'ELSE' && fw !== 'WHEN' && !fw.startsWith('END-');
    if (isSimpleStmt && !endsWithTerminator(codeText)) {
        procState.stmtOpen = true;
        procState.operandCol = col + fw.length + 1;
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
const EXIT_SUFFIX = /-(EX|EXIT|USCITA)$/;

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
    // Per ogni riga di input, indice (nell'array `result`) della sua voce
    // formattata (dopo eventuali righe inserite prima di essa): serve a mappare
    // una selezione sulle righe finali quando lo Stage 2 e' applicato a una
    // selezione (Format Selection) e non solo al documento intero.
    const entryStart = new Array(lines.length).fill(-1);
    let division = '';
    let inProc = false;
    // Ultimo verbo di statement visto per ciascuna colonna (livello di
    // indentazione): serve a decidere la riga vuota tra statement adiacenti
    // anche dentro i blocchi (IF/EVALUATE), non solo a livello base.
    const lastVerbAtCol = new Map();
    let blankAfterHeader = false;// va inserita una riga vuota dopo l'header di paragrafo
    let inFileSection = false;   // dentro la FILE SECTION
    let fdSeen = false;          // gia' visto un FD/SD nella FILE SECTION corrente
    let inFileControl = false;   // dentro il paragrafo FILE-CONTROL
    let selectSeen = false;      // gia' visto un SELECT nel FILE-CONTROL corrente

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
        lastVerbAtCol.clear();
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
            entryStart[i] = result.length; result.push(fmt);
            division = div; inProc = (div === 'PROCEDURE');
            resetStmt();
            blankAfterHeader = opts.blankLines && div === 'PROCEDURE';
            inFileSection = false; fdSeen = false;
            inFileControl = false; selectSeen = false;
            continue;
        }
        // --- SECTION header ---
        if (isSection) {
            if (opts.sectionSeparators
                && (DATA_SEP_SECTIONS.has(firstWord) || division === 'PROCEDURE')) {
                pushSepIfNeeded();
            }
            entryStart[i] = result.length; result.push(fmt);
            resetStmt(); blankAfterHeader = false;
            inFileSection = (firstWord === 'FILE'); fdSeen = false;
            inFileControl = false; selectSeen = false;
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
            entryStart[i] = result.length; result.push(fmt);
            resetStmt();
            blankAfterHeader = opts.blankLines && !isExit;
            continue;
        }
        // --- righe vuote / commento: passano invariate, azzerano l'adiacenza ---
        if (isBlank || isComment) {
            entryStart[i] = result.length; result.push(fmt);
            lastVerbAtCol.clear(); blankAfterHeader = false;
            continue;
        }
        // --- riga di continuazione (trattino in col 7): parte dello statement
        // precedente, passa invariata senza toccare l'adiacenza. ---
        if (isCont) {
            entryStart[i] = result.length; result.push(fmt);
            continue;
        }

        // --- riga di statement PROCEDURE ---
        if (inProc) {
            const firstPhys = fmt.split('\n')[0];
            // Colonna del codice ignorando l'indicatore in col 7 (es. 'D' debug).
            let cc = 7;
            while (cc < firstPhys.length && firstPhys[cc] === ' ') cc++;
            const col = cc + 1;
            // Delimitatori di blocco: non sono statement e non ricevono riga vuota.
            const isBlockDelim = firstWord === 'ELSE' || firstWord === 'WHEN'
                || firstWord.startsWith('END-');
            // Uno statement e' un verbo noto non delimitatore. La riga vuota si
            // decide per COLONNA (livello di indentazione), cosi' vale anche
            // dentro i blocchi IF/EVALUATE e non solo a livello base. Un nuovo
            // verbo apre una nuova istruzione anche senza punto sulla precedente.
            const isStmt = PROC_VERBS.has(firstWord) && !isBlockDelim;
            if (isStmt) {
                if (blankAfterHeader) { pushBlankIfNeeded(); blankAfterHeader = false; }
                // Riga vuota tra due statement adiacenti allo stesso livello, a
                // meno che abbiano lo stesso verbo NON di blocco (es. MOVE+MOVE
                // restano ravvicinati; verbi diversi o di blocco si separano).
                const prev = lastVerbAtCol.get(col);
                if (opts.blankLines && prev !== undefined
                    && (firstWord !== prev || BLOCK_VERBS.has(firstWord))) {
                    pushBlankIfNeeded();
                }
                // Rientro: gli statement di un blocco piu' interno (colonne
                // maggiori) sono conclusi, si scartano dalla mappa.
                for (const c of Array.from(lastVerbAtCol.keys())) {
                    if (c > col) lastVerbAtCol.delete(c);
                }
                lastVerbAtCol.set(col, firstWord);
            } else if (isBlockDelim) {
                // ELSE/WHEN/END-...: chiudono il blocco piu' interno (colonne
                // maggiori della propria); la propria colonna resta, cosi' lo
                // statement successivo allo stesso livello riceve la riga vuota
                // rispetto al verbo di blocco (es. una riga vuota dopo END-IF).
                for (const c of Array.from(lastVerbAtCol.keys())) {
                    if (c > col) lastVerbAtCol.delete(c);
                }
            }
            entryStart[i] = result.length; result.push(fmt);
            continue;
        }

        // --- FD/SD/RD/CD nella FILE SECTION: riga vuota prima (tranne il primo). ---
        if (inFileSection && (firstWord === 'FD' || firstWord === 'SD'
            || firstWord === 'RD' || firstWord === 'CD')) {
            if (opts.blankLines && fdSeen) pushBlankIfNeeded();
            fdSeen = true;
            entryStart[i] = result.length; result.push(fmt);
            lastVerbAtCol.clear();
            continue;
        }

        // --- ENVIRONMENT / FILE-CONTROL: separa i blocchi SELECT. ---
        if (division === 'ENVIRONMENT') {
            if (firstWord === 'FILE-CONTROL') {
                inFileControl = true; selectSeen = false;
            } else if (ENV_PARAGRAPHS.has(firstWord)) {
                inFileControl = false;
            } else if (inFileControl && firstWord === 'SELECT') {
                if (opts.blankLines && selectSeen) pushBlankIfNeeded();
                selectSeen = true;
            }
        }

        // --- altre righe (ID/ENV/DATA): invariate ---
        entryStart[i] = result.length; result.push(fmt);
        lastVerbAtCol.clear();
    }
    return { result, entryStart };
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
/**
 * Formatta l'intero documento e restituisce, oltre alle righe fisiche finali,
 * una mappa da ogni riga di input alla porzione di righe finali corrispondente
 * ([lineStart, lineEndEx)). La mappa consente di formattare una SELEZIONE con
 * lo Stage 2 (separatori/righe vuote) usando il contesto dell'intero documento,
 * sostituendo solo il blocco selezionato. Se lo Stage 2 altererebbe una riga di
 * codice (fail-safe via codeSignature) si ricade sul solo Stage 1.
 * @param {string[]} lines
 * @param {Set<number>} procDefLines
 * @param {Partial<FormatOptions>} [options]
 * @returns {{ finalLines: string[], lineStart: number[], lineEndEx: number[] }}
 */
function formatDocumentMapped(lines, procDefLines, options) {
    const opts = normalizeOptions(options);
    const formatted = computeFormatted(lines, procDefLines, opts);

    // Somme prefisse delle righe fisiche prodotte da ogni voce (una voce puo'
    // contenere '\n', es. letterale spezzato): entry index -> intervallo righe.
    const flatMap = (entries) => {
        const start = new Array(entries.length);
        const endEx = new Array(entries.length);
        let acc = 0;
        for (let k = 0; k < entries.length; k++) {
            start[k] = acc;
            acc += entries[k].split('\n').length;
            endEx[k] = acc;
        }
        return { start, endEx };
    };

    const stage1 = formatted.join('\n').split('\n');
    const stage1Mapped = () => {
        const m = flatMap(formatted);
        return { finalLines: stage1, lineStart: m.start, lineEndEx: m.endEx };
    };
    if (!opts.sectionSeparators && !opts.blankLines) return stage1Mapped();

    const { result, entryStart } = applyStage2(formatted, lines, procDefLines, opts);
    const stage2 = result.join('\n').split('\n');
    const before = codeSignature(stage1);
    const after = codeSignature(stage2);
    if (before.length !== after.length) return stage1Mapped();
    for (let k = 0; k < before.length; k++) {
        if (before[k] !== after[k]) return stage1Mapped();
    }
    const rm = flatMap(result);
    const lineStart = new Array(lines.length);
    const lineEndEx = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
        const e = entryStart[i];
        lineStart[i] = rm.start[e];
        lineEndEx[i] = rm.endEx[e];
    }
    return { finalLines: stage2, lineStart, lineEndEx };
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
    return formatDocumentMapped(lines, procDefLines, options).finalLines;
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
        if (!force && !cfg.get('format.enabled', true)) return [];
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

        // Stage 2 su una SELEZIONE: formatta l'intero documento (contesto
        // completo) e sostituisce solo il blocco selezionato con la sua versione
        // formattata + spaziata, cosi' Format Selection si comporta come Format
        // Document per il blocco scelto (righe vuote/separatori tra i blocchi).
        // Le righe vuote/separatori inserite prima della selezione o subito dopo
        // l'ultima riga non vengono aggiunte: solo quelle interne al blocco.
        if ((opts.sectionSeparators || opts.blankLines) && range !== null) {
            const { finalLines, lineStart, lineEndEx } =
                formatDocumentMapped(lines, procDefLines, opts);
            let s = range.start.line;
            let e = range.end.line;
            if (s < 0) s = 0;
            if (e > lines.length - 1) e = lines.length - 1;
            if (s > e) return [];
            const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const replacement = finalLines.slice(lineStart[s], lineEndEx[e]).join(eol);
            const startPos = new vscode.Position(s, 0);
            const endPos = document.lineAt(e).range.end;
            const selRange = new vscode.Range(startPos, endPos);
            if (document.getText(selRange) === replacement) return [];
            return [vscode.TextEdit.replace(selRange, replacement)];
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

module.exports = { CobolFormattingProvider, computeFormatted, formatDocument, formatDocumentMapped, reflowIfCondition };
