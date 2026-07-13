// @ts-check
'use strict';

/**
 * Logica pura (senza dipendenze da vscode) per la Signature Help delle
 * funzioni intrinseche COBOL. Isolata qui cosi' da essere testabile senza
 * caricare l'intera estensione.
 */

/**
 * Tabella statica delle funzioni intrinseche COBOL piu' comuni del dialetto
 * Micro Focus / Rocket. Per ciascuna: elenco dei parametri e una breve
 * descrizione. Le funzioni variadiche usano un secondo parametro "aperto".
 * @type {Record<string, { params: string[], doc: string }>}
 */
const COBOL_INTRINSICS = {
    'ABS': { params: ['argument'], doc: 'Absolute value of a numeric argument.' },
    'ACOS': { params: ['argument'], doc: 'Arc cosine (in radians) of the argument.' },
    'ASIN': { params: ['argument'], doc: 'Arc sine (in radians) of the argument.' },
    'ATAN': { params: ['argument'], doc: 'Arc tangent (in radians) of the argument.' },
    'CHAR': { params: ['integer'], doc: 'Character at the given ordinal position in the program collating sequence.' },
    'COS': { params: ['argument'], doc: 'Cosine of the argument (in radians).' },
    'CURRENT-DATE': { params: [], doc: 'Current date and time as a 21-character string (YYYYMMDDhhmmssnn+hhmm).' },
    'DATE-OF-INTEGER': { params: ['integer-date'], doc: 'Standard date (YYYYMMDD) for an integer date.' },
    'DATE-TO-YYYYMMDD': { params: ['argument', 'window'], doc: 'Converts a YYMMDD date to YYYYMMDD using a sliding window.' },
    'DAY-OF-INTEGER': { params: ['integer-date'], doc: 'Julian date (YYYYDDD) for an integer date.' },
    'DAY-TO-YYYYDDD': { params: ['argument', 'window'], doc: 'Converts a YYDDD date to YYYYDDD using a sliding window.' },
    'EXP': { params: ['argument'], doc: 'e raised to the power of the argument.' },
    'EXP10': { params: ['argument'], doc: '10 raised to the power of the argument.' },
    'FACTORIAL': { params: ['integer'], doc: 'Factorial of a non-negative integer.' },
    'INTEGER': { params: ['argument'], doc: 'Greatest integer not greater than the argument.' },
    'INTEGER-OF-DATE': { params: ['standard-date'], doc: 'Integer date for a standard date (YYYYMMDD).' },
    'INTEGER-OF-DAY': { params: ['julian-date'], doc: 'Integer date for a Julian date (YYYYDDD).' },
    'INTEGER-PART': { params: ['argument'], doc: 'Integer part of the argument (truncated toward zero).' },
    'LENGTH': { params: ['item'], doc: 'Length in bytes of the argument.' },
    'LOG': { params: ['argument'], doc: 'Natural logarithm (base e) of the argument.' },
    'LOG10': { params: ['argument'], doc: 'Logarithm (base 10) of the argument.' },
    'LOWER-CASE': { params: ['string'], doc: 'The argument with all letters in lower case.' },
    'MAX': { params: ['argument-1', 'argument-2 ...'], doc: 'Largest of the arguments.' },
    'MEAN': { params: ['argument-1', 'argument-2 ...'], doc: 'Arithmetic mean of the arguments.' },
    'MEDIAN': { params: ['argument-1', 'argument-2 ...'], doc: 'Median value of the arguments.' },
    'MIDRANGE': { params: ['argument-1', 'argument-2 ...'], doc: 'Mean of the largest and smallest arguments.' },
    'MIN': { params: ['argument-1', 'argument-2 ...'], doc: 'Smallest of the arguments.' },
    'MOD': { params: ['argument-1', 'argument-2'], doc: 'argument-1 modulo argument-2.' },
    'NUMVAL': { params: ['string'], doc: 'Numeric value of a string of numeric characters.' },
    'NUMVAL-C': { params: ['string', 'currency-sign'], doc: 'Numeric value of a string that may contain a currency sign and separators.' },
    'ORD': { params: ['character'], doc: 'Ordinal position of the character in the collating sequence.' },
    'ORD-MAX': { params: ['argument-1', 'argument-2 ...'], doc: 'Ordinal position of the largest argument.' },
    'ORD-MIN': { params: ['argument-1', 'argument-2 ...'], doc: 'Ordinal position of the smallest argument.' },
    'RANDOM': { params: ['seed'], doc: 'Pseudo-random number (the optional seed initializes the sequence).' },
    'RANGE': { params: ['argument-1', 'argument-2 ...'], doc: 'Difference between the largest and smallest argument.' },
    'REM': { params: ['argument-1', 'argument-2'], doc: 'Remainder of argument-1 divided by argument-2.' },
    'REVERSE': { params: ['string'], doc: 'The argument with its characters in reverse order.' },
    'SIN': { params: ['argument'], doc: 'Sine of the argument (in radians).' },
    'SQRT': { params: ['argument'], doc: 'Square root of the argument.' },
    'STANDARD-DEVIATION': { params: ['argument-1', 'argument-2 ...'], doc: 'Standard deviation of the arguments.' },
    'SUM': { params: ['argument-1', 'argument-2 ...'], doc: 'Sum of the arguments.' },
    'TAN': { params: ['argument'], doc: 'Tangent of the argument (in radians).' },
    'TRIM': { params: ['string', 'LEADING | TRAILING'], doc: 'The argument with leading and/or trailing spaces removed.' },
    'UPPER-CASE': { params: ['string'], doc: 'The argument with all letters in upper case.' },
    'VARIANCE': { params: ['argument-1', 'argument-2 ...'], doc: 'Variance of the arguments.' },
    'WHEN-COMPILED': { params: [], doc: 'Date and time the program was compiled.' },
    'YEAR-TO-YYYY': { params: ['argument', 'window'], doc: 'Converts a YY year to YYYY using a sliding window.' }
};

/**
 * Sostituisce con spazi il contenuto dei letterali stringa ('...' o "..."),
 * mantenendo i delimitatori. Serve a ignorare parentesi e virgole tra apici.
 * @param {string} s
 * @returns {string}
 */
function maskStringLiterals(s) {
    const arr = s.split('');
    let quote = null;
    for (let i = 0; i < arr.length; i++) {
        const ch = arr[i];
        if (quote) {
            if (ch === quote) quote = null;
            else arr[i] = ' ';
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        }
    }
    return arr.join('');
}

/**
 * Data la porzione di riga che precede il cursore, individua la funzione
 * intrinseca (FUNCTION nome) che racchiude la posizione corrente e l'indice
 * dell'argomento in cui si trova il cursore. Gestisce annidamenti.
 * @param {string} prefix - testo della riga da colonna 0 fino al cursore
 * @returns {{ name: string, argIndex: number } | null}
 */
function findEnclosingFunction(prefix) {
    const masked = maskStringLiterals(prefix);
    /** @type {{ name: string | null, argIndex: number }[]} */
    const stack = [];
    for (let i = 0; i < masked.length; i++) {
        const ch = masked[i];
        if (ch === '(') {
            const m = /FUNCTION\s+([A-Za-z][\w-]*)\s*$/i.exec(masked.substring(0, i));
            stack.push({ name: m ? m[1].toUpperCase() : null, argIndex: 0 });
        } else if (ch === ')') {
            stack.pop();
        } else if (ch === ',') {
            if (stack.length) stack[stack.length - 1].argIndex++;
        }
    }
    // Contesto aperto piu' interno che sia una funzione con nome noto.
    for (let k = stack.length - 1; k >= 0; k--) {
        const ctx = stack[k];
        if (ctx.name) return { name: ctx.name, argIndex: ctx.argIndex };
    }
    return null;
}

/**
 * Calcola la Signature Help (in forma neutra, senza tipi vscode) per la
 * posizione data all'interno di una riga di codice COBOL.
 * @param {string} lineText - testo completo della riga
 * @param {number} character - colonna del cursore (0-based)
 * @returns {{ name: string, params: string[], doc: string, activeParameter: number } | null}
 */
function getSignatureAt(lineText, character) {
    const prefix = lineText.substring(0, character);
    const ctx = findEnclosingFunction(prefix);
    if (!ctx) return null;
    const info = COBOL_INTRINSICS[ctx.name];
    if (!info) return null;
    const activeParameter = info.params.length
        ? Math.min(ctx.argIndex, info.params.length - 1)
        : 0;
    return {
        name: ctx.name,
        params: info.params.slice(),
        doc: info.doc,
        activeParameter
    };
}

module.exports = {
    COBOL_INTRINSICS,
    maskStringLiterals,
    findEnclosingFunction,
    getSignatureAt
};
