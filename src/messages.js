// @ts-check
'use strict';

/**
 * Localized diagnostic messages for COBOL Lens linter.
 * Supports Italian (it) and English (en).
 * Call setLang() once before each linter run.
 */

const vscode = require('vscode');

/** @type {'it'|'en'} */
let _lang = 'en';

/**
 * Sets the active language for subsequent msg() calls.
 * @param {'it'|'en'} lang
 */
function setLang(lang) {
    _lang = lang;
}

/**
 * Detects the language to use based on the cobolLens.language setting,
 * falling back to the VS Code display language when set to "auto".
 * @returns {'it'|'en'}
 */
function getLang() {
    const cfg = vscode.workspace.getConfiguration('cobolLens');
    const setting = cfg.get('language', 'auto');
    if (setting === 'it') return 'it';
    if (setting === 'en') return 'en';
    // auto: detect from VS Code locale
    const locale = (vscode.env.language || 'en').toLowerCase();
    return locale.startsWith('it') ? 'it' : 'en';
}

const MESSAGES = {
    col72: {
        it: () => 'Contenuto non consentito oltre la colonna 72',
        en: () => 'Content beyond column 72 is not allowed',
    },
    noGoto: {
        it: () => 'Uso di GOTO non consentito. Usare PERFORM e IF.',
        en: () => 'GOTO is not allowed. Use PERFORM and IF instead.',
    },
    noAtEnd: {
        it: () => 'Uso di AT END / NOT AT END non consentito. Usare il file status con EVALUATE.',
        en: () => 'AT END / NOT AT END is not allowed. Use FILE STATUS with EVALUATE instead.',
    },
    noLevel7778: {
        it: (level) => `Livello ${level} non consentito in WORKING-STORAGE. Usare 01, 05, 10, 15...`,
        en: (level) => `Level ${level} is not allowed in WORKING-STORAGE. Use 01, 05, 10, 15...`,
    },
    uppercase: {
        it: () => 'Il codice COBOL deve essere in MAIUSCOLO',
        en: () => 'COBOL code must be in UPPERCASE',
    },
    divisionSeparator: {
        it: (code) => `Manca la riga separatrice (*---) prima di: ${code}`,
        en: (code) => `Missing separator line (*---) before: ${code}`,
    },
    picAlignment: {
        it: (col, exp) => `PIC alla colonna ${col}, attesa colonna ${exp}`,
        en: (col, exp) => `PIC at column ${col}, expected column ${exp}`,
    },
    selectCol12: {
        it: (col, exp) => `SELECT alla colonna ${col}, attesa colonna ${exp}`,
        en: (col, exp) => `SELECT at column ${col}, expected column ${exp}`,
    },
    assignCol29: {
        it: (kw, col, exp) => `${kw} alla colonna ${col}, attesa colonna ${exp}`,
        en: (kw, col, exp) => `${kw} at column ${col}, expected column ${exp}`,
    },
    wsLevels: {
        it: (level) => `Livello ${level} non standard. Usare: 01, 05, 10, 15, 20... (incremento di 5) oppure 66, 88`,
        en: (level) => `Level ${level} is not standard. Use: 01, 05, 10, 15, 20... (increments of 5) or 66, 88`,
    },
    noElseIf: {
        it: () => 'Non usare ELSE IF. Indentare le IF dentro un blocco ELSE.',
        en: () => 'Do not use ELSE IF. Nest IF inside ELSE instead.',
    },
    moveToAlignment: {
        it: (col, exp) => `TO alla colonna ${col}, attesa colonna ${exp}`,
        en: (col, exp) => `TO at column ${col}, expected column ${exp}`,
    },
    wsLevelSpacing: {
        it: (n) => `Tra il livello e il nome devono esserci esattamente 1 spazio (trovati ${n})`,
        en: (n) => `Exactly 1 space required between level number and name (found ${n})`,
    },
    orphanScope: {
        it: (endKw, openKw) => `${endKw} senza una corrispondente istruzione ${openKw} di apertura`,
        en: (endKw, openKw) => `${endKw} without a matching opening ${openKw} statement`,
    },
    endStructurePoint: {
        it: (type, line) => `Struttura ${type} aperta alla riga ${line} chiusa da un punto anziche' da END-${type}`,
        en: (type, line) => `${type} structure opened at line ${line} closed by a period instead of END-${type}`,
    },
    endStructureUnclosed: {
        it: (type, line) => `Struttura ${type} aperta alla riga ${line} senza chiusura (manca END-${type})`,
        en: (type, line) => `${type} structure opened at line ${line} is not closed (missing END-${type})`,
    },
    stringDelimited: {
        it: () => 'STRING: manca DELIMITED BY prima della clausola INTO',
        en: () => 'STRING: missing DELIMITED BY before the INTO clause',
    },
    paragraphNaming: {
        it: (name) => `Il paragrafo '${name}' non segue la convenzione (I0001-, E0001-, F0001-, V0000-, S0000-, X9999-)`,
        en: (name) => `Paragraph '${name}' does not follow the naming convention (I0001-, E0001-, F0001-, V0000-, S0000-, X9999-)`,
    },
    missingPeriod: {
        it: () => 'Manca il punto alla fine della definizione di variabile',
        en: () => 'Missing period at end of variable definition',
    },
    missingPeriodStatement: {
        it: () => 'Manca il punto alla fine della frase prima del paragrafo/sezione successivo',
        en: () => 'Missing period at end of statement before the next paragraph/section',
    },
    picMissing: {
        it: (name, lvl) => `Variabile '${name}' senza clausola PIC (livello ${lvl} elementare richiede PIC)`,
        en: (name, lvl) => `Variable '${name}' has no PIC clause (level ${lvl} elementary item requires PIC)`,
    },
    mismatchedCopy: {
        it: (name) => `COPY '${name}' non trovata nelle cartelle configurate`,
        en: (name) => `COPY '${name}' not found in the configured folders`,
    },
    sectionOrder: {
        it: (div, prev) => `'${div}' non nell'ordine corretto (deve venire dopo '${prev}')`,
        en: (div, prev) => `'${div}' is not in the correct order (must come after '${prev}')`,
    },
    performThruOrder: {
        it: (p, t) => `PERFORM ${p} THRU ${t}: '${t}' deve essere definito DOPO '${p}'`,
        en: (p, t) => `PERFORM ${p} THRU ${t}: '${t}' must be defined AFTER '${p}'`,
    },
    emptyParagraph: {
        it: (name) => `Paragrafo '${name}' vuoto o contiene solo EXIT/CONTINUE`,
        en: (name) => `Paragraph '${name}' is empty or contains only EXIT/CONTINUE`,
    },
    consecutivePerform: {
        it: () => 'Manca una riga vuota prima di questa PERFORM (le PERFORM consecutive devono essere separate da una riga vuota)',
        en: () => 'Missing blank line before this PERFORM (consecutive PERFORMs must be separated by a blank line)',
    },
    missingFileStatus: {
        it: (name) => `SELECT '${name}' senza clausola STATUS (usare FILE STATUS per gestire errori I/O)`,
        en: (name) => `SELECT '${name}' has no STATUS clause (use FILE STATUS to handle I/O errors)`,
    },
    missingStopRun: {
        it: () => 'Il programma non contiene STOP RUN, GOBACK o EXEC CICS RETURN',
        en: () => 'Program does not contain STOP RUN, GOBACK or EXEC CICS RETURN',
    },
    andOrIf: {
        it: () => 'IF non necessario dopo AND/OR in una condizione composta. Rimuovere IF.',
        en: () => 'Unnecessary IF after AND/OR in a compound condition. Remove IF.',
    },
    redefinesSize: {
        it: (orig, origSize, redefSize) => `REDEFINES: '${orig}' occupa ${origSize} byte, la ridefinizione occupa ${redefSize} byte (devono coincidere)`,
        en: (orig, origSize, redefSize) => `REDEFINES: '${orig}' is ${origSize} bytes, the redefinition is ${redefSize} bytes (they must match)`,
    },
    invalidColumn7: {
        it: (ch) => `Carattere '${ch}' non valido in colonna 7 (ammessi: spazio, *, /, D, -, $)`,
        en: (ch) => `Character '${ch}' is not valid in column 7 (allowed: space, *, /, D, -, $)`,
    },
    unsubscriptedOccurs: {
        it: (name) => `Variabile '${name}' ha clausola OCCURS e richiede un indice o subscript`,
        en: (name) => `Variable '${name}' has an OCCURS clause and requires a subscript or index`,
    },
    undefinedVariable: {
        it: (name) => `Variabile '${name}' non definita nel programma ne' nelle copy utilizzate`,
        en: (name) => `Variable '${name}' is not defined in the program or the included copybooks`,
    },
    undefinedParagraph: {
        it: (name) => `PERFORM verso paragrafo '${name}' non definito nel programma`,
        en: (name) => `PERFORM targets paragraph '${name}' which is not defined in the program`,
    },
    unusedParagraph: {
        it: (name) => `Paragrafo '${name}' definito ma mai richiamato da una PERFORM`,
        en: (name) => `Paragraph '${name}' is defined but never called by a PERFORM`,
    },
    unusedVariable: {
        it: (name) => `Variabile '${name}' definita in WORKING-STORAGE ma mai utilizzata nella PROCEDURE DIVISION`,
        en: (name) => `Variable '${name}' is defined in WORKING-STORAGE but never used in the PROCEDURE DIVISION`,
    },
    duplicateVarProgram: {
        it: (name, line) => `Variabile '${name}' definita piu' volte nel programma (prima definizione a riga ${line})`,
        en: (name, line) => `Variable '${name}' is defined multiple times in the program (first definition at line ${line})`,
    },
    duplicateVarProgramAndCopy: {
        it: (name, line, copies) => `Variabile '${name}' definita piu' volte nel programma (prima definizione a riga ${line}) e anche in ${copies}`,
        en: (name, line, copies) => `Variable '${name}' is defined multiple times in the program (first definition at line ${line}) and also in ${copies}`,
    },
    duplicateVarProgAndCopy: {
        it: (name, line, copies) => `Variabile '${name}' definita nel programma a riga ${line} e anche in ${copies}`,
        en: (name, line, copies) => `Variable '${name}' is defined in the program at line ${line} and also in ${copies}`,
    },
    duplicateVarCopies: {
        it: (name, copies) => `Variabile '${name}' definita in piu' copy: ${copies}`,
        en: (name, copies) => `Variable '${name}' is defined in multiple copybooks: ${copies}`,
    },
    variableNameLength: {
        it: (name, len, max) => `Nome variabile '${name}' troppo lungo (${len} caratteri, massimo consentito: ${max})`,
        en: (name, len, max) => `Variable name '${name}' is too long (${len} characters, maximum allowed: ${max})`,
    },
    missingLevel: {
        it: (name) => `Definizione variabile '${name}' senza numero di livello (01-49, 66, 77, 88)`,
        en: (name) => `Variable definition '${name}' has no level number (01-49, 66, 77, 88)`,
    },
    charsAfterPeriod: {
        it: () => 'Contenuto non valido dopo il punto terminatore della riga COBOL',
        en: () => 'Invalid content after the COBOL statement period',
    },
    charsAfterPeriodSeq: {
        it: () => 'Possibile numero di sequenza non valido in coda alla riga (formato fixed usato in sourceformat variable/free)',
        en: () => 'Possible invalid sequence number at end of line (fixed format used in sourceformat variable/free)',
    },
    computeAsterisk: {
        it: () => `COMPUTE su piu' righe: la riga termina con '*' (operatore moltiplicazione). Il precompilatore CICS potrebbe generare errori. Spostare l'operatore '*' all'inizio della riga successiva.`,
        en: () => `Multi-line COMPUTE: line ends with '*' (multiplication operator). The CICS precompiler may generate errors. Move '*' to the beginning of the next line.`,
    },
    alphanumericInCompute: {
        it: (name, verb) => `Variabile alfanumerica '${name}' utilizzata in istruzione ${verb}. Le operazioni matematiche richiedono variabili numeriche.`,
        en: (name, verb) => `Alphanumeric variable '${name}' used in ${verb} statement. Arithmetic operations require numeric variables.`,
    },
    moveAlphaToNumeric: {
        it: (src, dest) => `Valore alfanumerico ${src} spostato (MOVE) nella variabile numerica '${dest}'. Possibile errore di tipo a runtime (usare FUNCTION NUMVAL per la conversione).`,
        en: (src, dest) => `Alphanumeric value ${src} moved (MOVE) into numeric variable '${dest}'. Possible runtime type error (use FUNCTION NUMVAL to convert).`,
    },
};

/**
 * Returns the localized message for the given key.
 * @param {string} key
 * @param {...any} args
 * @returns {string}
 */
function msg(key, ...args) {
    const entry = MESSAGES[key];
    if (!entry) return key;
    const fn = entry[_lang] || entry['en'];
    return typeof fn === 'function' ? fn(...args) : String(fn);
}

module.exports = { msg, getLang, setLang };
