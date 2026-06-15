// @ts-check
'use strict';

const fs = require('fs');
const { isComment, VARIABLE_DEF_REGEX, COPY_REGEX, resolveCopybookPath } = require('./cobol-parser');

/**
 * Calcolo della dimensione in byte di campi e gruppi COBOL.
 *
 * Regole implementate:
 * - DISPLAY: 1 byte per ogni posizione della PICTURE (V e P non occupano byte,
 *   il segno S in overpunch non aggiunge byte; SIGN SEPARATE aggiunge 1 byte).
 * - COMP-3 / PACKED-DECIMAL: floor(cifre / 2) + 1.
 * - COMP / COMP-4 / BINARY / COMP-5: 2 byte (1-4 cifre), 4 byte (5-9),
 *   8 byte (10-18).
 * - COMP-1: 4 byte. COMP-2: 8 byte. INDEX: 4 byte. POINTER: 4 byte.
 * - OCCURS n: moltiplica la dimensione del campo/gruppo per n.
 * - REDEFINES: i campi che ridefiniscono un'area esistente NON si sommano.
 * - Livelli 88 (condition name) e 66 (RENAMES): non occupano storage.
 * - I FILLER vengono conteggiati (a differenza dell'indice simboli, che li salta).
 */

/**
 * @typedef {Object} DataEntry
 * @property {number} level - Livello (01-49, 66, 77, 88)
 * @property {string} name - Nome del campo (o FILLER)
 * @property {number} startLine - Riga 0-based dove inizia la definizione
 * @property {string|null} pic - Stringa PICTURE (es. "X(4)") oppure null
 * @property {string} usage - Usage normalizzato (DISPLAY, COMP-3, COMP, ...)
 * @property {number} occurs - Numero di occorrenze (1 se assente)
 * @property {boolean} redefines - true se l'entry ha clausola REDEFINES
 * @property {boolean} signSeparate - true se l'entry ha clausola SIGN SEPARATE
 * @property {boolean} fromCopy - true se l'entry proviene da una copybook espansa
 */

/**
 * Regex che riconosce una riga di definizione dato includendo FILLER.
 * Riusa lo stesso schema di VARIABLE_DEF_REGEX (livello + nome).
 */
const DATA_DEF_REGEX = VARIABLE_DEF_REGEX;

/**
 * Espande una PICTURE risolvendo le ripetizioni con parentesi.
 * Esempi: "X(4)" -> "XXXX", "S9(3)V99" -> "S999V99".
 * @param {string} pic
 * @returns {string} picture espansa in maiuscolo
 */
function expandPicture(pic) {
    const p = pic.toUpperCase();
    let result = '';
    let lastSymbol = '';
    let i = 0;
    while (i < p.length) {
        const ch = p[i];
        if (ch === '(') {
            // Leggi il numero fino a ')'
            let j = i + 1;
            let num = '';
            while (j < p.length && p[j] !== ')') {
                if (/[0-9]/.test(p[j])) num += p[j];
                j++;
            }
            const count = parseInt(num, 10);
            if (lastSymbol && count > 0) {
                // Il simbolo e' gia' stato aggiunto una volta: aggiungi le ripetizioni rimanenti
                result += lastSymbol.repeat(count - 1);
            }
            i = j + 1;
            continue;
        }
        result += ch;
        lastSymbol = ch;
        i++;
    }
    return result;
}

/**
 * Conta le posizioni di visualizzazione (byte per usage DISPLAY).
 * V (decimale implicito), P (scaling) e S (segno overpunch) non occupano byte.
 * @param {string} expanded
 * @returns {number}
 */
function countDisplayPositions(expanded) {
    let count = 0;
    for (const ch of expanded) {
        if (ch === 'V' || ch === 'P' || ch === 'S') continue;
        count++;
    }
    return count;
}

/**
 * Conta le cifre numeriche (per COMP/COMP-3). Considera '9' e 'P'.
 * @param {string} expanded
 * @returns {number}
 */
function countNumericDigits(expanded) {
    let count = 0;
    for (const ch of expanded) {
        if (ch === '9' || ch === 'P') count++;
    }
    return count;
}

/**
 * Estrae la clausola USAGE normalizzata dal testo dell'entry.
 * @param {string} text
 * @returns {string}
 */
function detectUsage(text) {
    const u = text.toUpperCase();
    if (/\b(COMP-3|COMPUTATIONAL-3|PACKED-DECIMAL)\b/.test(u)) return 'COMP-3';
    if (/\b(COMP-5|COMPUTATIONAL-5)\b/.test(u)) return 'COMP-5';
    if (/\b(COMP-4|COMPUTATIONAL-4|BINARY)\b/.test(u)) return 'COMP-4';
    if (/\b(COMP-1|COMPUTATIONAL-1)\b/.test(u)) return 'COMP-1';
    if (/\b(COMP-2|COMPUTATIONAL-2)\b/.test(u)) return 'COMP-2';
    if (/\b(COMP|COMPUTATIONAL)\b/.test(u)) return 'COMP';
    if (/\bINDEX\b/.test(u)) return 'INDEX';
    if (/\bPOINTER\b/.test(u)) return 'POINTER';
    return 'DISPLAY';
}

/**
 * Estrae la stringa PICTURE dal testo dell'entry, rimuovendo il punto finale.
 * @param {string} text
 * @returns {string|null}
 */
function detectPicture(text) {
    const m = /\bPIC(?:TURE)?\b\s+(?:IS\s+)?(\S+)/i.exec(text);
    if (!m) return null;
    let pic = m[1];
    // Rimuove un eventuale punto terminatore (es. "X(4065)." -> "X(4065)")
    if (pic.endsWith('.')) pic = pic.slice(0, -1);
    return pic || null;
}

/**
 * Estrae il numero di OCCURS (usa il valore massimo per "OCCURS m TO n").
 * @param {string} text
 * @returns {number}
 */
function detectOccurs(text) {
    const m = /\bOCCURS\s+(\d+)(?:\s+TO\s+(\d+))?/i.exec(text);
    if (!m) return 1;
    const max = m[2] ? parseInt(m[2], 10) : parseInt(m[1], 10);
    return max > 0 ? max : 1;
}

/**
 * Indica se l'entry ha la clausola SIGN ... SEPARATE.
 * @param {string} text
 * @returns {boolean}
 */
function hasSignSeparate(text) {
    return /\bSIGN\b[^.]*\bSEPARATE\b/i.test(text);
}

/**
 * Raccoglie tutte le entry dato del file (DATA DIVISION), inclusi i FILLER.
 * Gestisce le definizioni su piu' righe fisiche (le righe di continuazione,
 * cioe' senza livello, vengono unite alla loro definizione) e l'espansione
 * ricorsiva delle copybook (COPY) quando e' fornito il workspaceRoot, cosi'
 * i campi dichiarati in una copybook annidata in un gruppo vengono inclusi.
 * Le righe vuote e i commenti vengono saltati.
 * @param {string[]} lines
 * @param {string} [workspaceRoot] - Root per risolvere le COPY (se assente, le COPY sono ignorate)
 * @param {Set<string>} [visited] - Copybook gia' espanse (anti-ricorsione)
 * @param {boolean} [fromCopy] - true se queste righe provengono da una copybook
 * @returns {DataEntry[]}
 */
function collectDataEntries(lines, workspaceRoot, visited, fromCopy) {
    if (!visited) visited = new Set();
    /** @type {DataEntry[]} */
    const entries = [];
    let inProcedure = false;
    let i = 0;

    // Espande inline una copybook (se risolvibile) accodando le sue entry.
    function expandCopy(rawName) {
        if (!workspaceRoot) return;
        const copyName = rawName.toUpperCase();
        if (visited.has(copyName)) return;
        visited.add(copyName);
        const resolved = resolveCopybookPath(rawName, workspaceRoot);
        if (!resolved) return;
        try {
            const content = fs.readFileSync(resolved, 'utf-8');
            const sub = collectDataEntries(
                content.split(/\r?\n/), workspaceRoot, visited, true);
            for (const s of sub) entries.push(s);
        } catch (e) { /* ignora errori di lettura */ }
    }

    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim() || isComment(line)) { i++; continue; }

        const upper = line.toUpperCase();
        if (upper.includes('PROCEDURE') && upper.includes('DIVISION')) {
            inProcedure = true;
        }
        if (inProcedure) { i++; continue; }

        const m = DATA_DEF_REGEX.exec(line);
        if (!m) {
            // Nessuna definizione: la riga puo' essere una COPY a se stante.
            const copyMatch = COPY_REGEX.exec(line);
            if (copyMatch) expandCopy(copyMatch[1]);
            i++;
            continue;
        }

        const startLine = i;
        let text = line;

        // Unisci le righe di continuazione: righe non vuote, non commento,
        // che non iniziano una nuova definizione ne' una COPY.
        let j = i + 1;
        while (j < lines.length) {
            const nxt = lines[j];
            if (!nxt.trim() || isComment(nxt)) break;
            if (DATA_DEF_REGEX.test(nxt)) break;
            if (COPY_REGEX.test(nxt)) break;
            const nu = nxt.toUpperCase();
            if (nu.includes('PROCEDURE') && nu.includes('DIVISION')) break;
            text += ' ' + nxt;
            j++;
        }
        i = j;

        const level = parseInt(m[1], 10);
        const name = m[2];

        entries.push({
            level,
            name,
            startLine,
            pic: detectPicture(text),
            usage: detectUsage(text),
            occurs: detectOccurs(text),
            redefines: /\bREDEFINES\b/i.test(text),
            signSeparate: hasSignSeparate(text),
            fromCopy: !!fromCopy
        });

        // La stessa definizione puo' contenere una COPY dopo il punto
        // (es. "01 WS-OUTER. COPY LAYSUB."): espandila come campi del gruppo.
        const copyOnSame = COPY_REGEX.exec(text);
        if (copyOnSame) expandCopy(copyOnSame[1]);
    }

    return entries;
}

/**
 * Calcola la dimensione in byte di un campo elementare.
 * @param {DataEntry} e
 * @returns {number} byte (0 se non determinabile)
 */
function elementarySize(e) {
    switch (e.usage) {
        case 'COMP-1': return 4;
        case 'COMP-2': return 8;
        case 'INDEX': return 4;
        case 'POINTER': return 4;
    }

    if (!e.pic) return 0;
    const expanded = expandPicture(e.pic);

    if (e.usage === 'COMP-3') {
        const digits = countNumericDigits(expanded);
        return Math.floor(digits / 2) + 1;
    }

    if (e.usage === 'COMP' || e.usage === 'COMP-4' || e.usage === 'COMP-5') {
        const digits = countNumericDigits(expanded);
        if (digits <= 4) return 2;
        if (digits <= 9) return 4;
        return 8;
    }

    // DISPLAY
    let size = countDisplayPositions(expanded);
    if (e.signSeparate) size += 1;
    return size;
}

/**
 * Calcola la dimensione (in byte) dell'entry all'indice idx e di tutta la
 * sua sottostruttura. Restituisce anche l'indice della prossima entry non
 * appartenente alla sottostruttura.
 * @param {DataEntry[]} entries
 * @param {number} idx
 * @returns {{ size: number, isGroup: boolean, next: number }}
 */
function sizeOfEntryAt(entries, idx) {
    const e = entries[idx];

    // Livelli 88/66: nessuno storage
    if (e.level === 88 || e.level === 66) {
        return { size: 0, isGroup: false, next: idx + 1 };
    }

    // Campo elementare: ha PICTURE oppure usage con dimensione implicita
    const hasImplicitSize = ['COMP-1', 'COMP-2', 'INDEX', 'POINTER'].includes(e.usage);
    if (e.pic || hasImplicitSize) {
        const size = elementarySize(e) * e.occurs;
        return { size, isGroup: false, next: idx + 1 };
    }

    // Gruppo: somma i figli diretti (livello maggiore)
    let total = 0;
    let j = idx + 1;
    while (j < entries.length && entries[j].level > e.level) {
        const child = entries[j];
        // 66 (RENAMES) non si somma e non ha sottostruttura propria
        if (child.level === 66) { j++; continue; }
        const r = sizeOfEntryAt(entries, j);
        if (!child.redefines && child.level !== 88) {
            total += r.size;
        }
        j = r.next;
    }

    return { size: total * e.occurs, isGroup: true, next: j };
}

/**
 * Calcola la dimensione del campo/gruppo definito alla riga indicata.
 * @param {string[]} lines - Righe del file dove e' definito il simbolo
 * @param {number} defLine - Riga 0-based della definizione del simbolo
 * @param {string} [workspaceRoot] - Root per risolvere le COPY annidate
 * @returns {{ size: number, isGroup: boolean } | undefined}
 */
function computeFieldSize(lines, defLine, workspaceRoot) {
    const entries = collectDataEntries(lines, workspaceRoot);
    // La definizione cercata appartiene al file principale (non a una copybook):
    // confronta startLine solo tra le entry non provenienti da COPY.
    const idx = entries.findIndex(e => !e.fromCopy && e.startLine === defLine);
    if (idx < 0) return undefined;

    const r = sizeOfEntryAt(entries, idx);
    if (!r.size || r.size <= 0) return undefined;
    return { size: r.size, isGroup: r.isGroup };
}

module.exports = {
    computeFieldSize,
    collectDataEntries,
    sizeOfEntryAt,
    elementarySize,
    expandPicture,
    detectUsage,
    detectPicture,
    detectOccurs
};
