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
    'ANNUITY': { params: ['argument-1', 'argument-2'], doc: 'Ratio of an annuity for interest rate argument-1 over argument-2 periods.' },
    'ASIN': { params: ['argument'], doc: 'Arc sine (in radians) of the argument.' },
    'ATAN': { params: ['argument'], doc: 'Arc tangent (in radians) of the argument.' },
    'BOOLEAN-OF-INTEGER': { params: ['argument-1', 'argument-2'], doc: 'Boolean value corresponding to an integer, in argument-2 bits.' },
    'BYTE-LENGTH': { params: ['item'], doc: 'Length in bytes of the argument, regardless of its usage.' },
    'CHAR': { params: ['integer'], doc: 'Character at the given ordinal position in the program collating sequence.' },
    'CHAR-NATIONAL': { params: ['integer'], doc: 'National character at the given ordinal position in the national collating sequence.' },
    'COMBINED-DATETIME': { params: ['date', 'time'], doc: 'Combines an integer date and a numeric time into a single numeric value.' },
    'CONCATENATE': { params: ['argument-1', 'argument-2 ...'], doc: 'Concatenation of the string arguments.' },
    'COS': { params: ['argument'], doc: 'Cosine of the argument (in radians).' },
    'CURRENT-DATE': { params: [], doc: 'Current date and time as a 21-character string (YYYYMMDDhhmmssnn+hhmm).' },
    'DATE-OF-INTEGER': { params: ['integer-date'], doc: 'Standard date (YYYYMMDD) for an integer date.' },
    'DATE-TO-YYYYMMDD': { params: ['argument', 'window'], doc: 'Converts a YYMMDD date to YYYYMMDD using a sliding window.' },
    'DAY-OF-INTEGER': { params: ['integer-date'], doc: 'Julian date (YYYYDDD) for an integer date.' },
    'DAY-TO-YYYYDDD': { params: ['argument', 'window'], doc: 'Converts a YYDDD date to YYYYDDD using a sliding window.' },
    'DISPLAY-OF': { params: ['national', 'replacement'], doc: 'Alphanumeric (display) representation of a national (Unicode) item.' },
    'E': { params: [], doc: 'The mathematical constant e (2.71828...).' },
    'EXCEPTION-FILE': { params: [], doc: 'File name associated with the most recent exception condition.' },
    'EXCEPTION-FILE-N': { params: [], doc: 'National version of EXCEPTION-FILE.' },
    'EXCEPTION-LOCATION': { params: [], doc: 'Location where the most recent exception condition occurred.' },
    'EXCEPTION-LOCATION-N': { params: [], doc: 'National version of EXCEPTION-LOCATION.' },
    'EXCEPTION-STATEMENT': { params: [], doc: 'Statement that raised the most recent exception condition.' },
    'EXCEPTION-STATUS': { params: [], doc: 'Exception-name of the most recent exception condition.' },
    'EXP': { params: ['argument'], doc: 'e raised to the power of the argument.' },
    'EXP10': { params: ['argument'], doc: '10 raised to the power of the argument.' },
    'FACTORIAL': { params: ['integer'], doc: 'Factorial of a non-negative integer.' },
    'FORMATTED-CURRENT-DATE': { params: ['format'], doc: 'Current date and time formatted according to the given format string.' },
    'FORMATTED-DATE': { params: ['format', 'integer-date'], doc: 'Integer date formatted according to the given format string.' },
    'FORMATTED-DATETIME': { params: ['format', 'integer-date', 'numeric-time', 'offset'], doc: 'Integer date and numeric time formatted per the given format string.' },
    'FORMATTED-TIME': { params: ['format', 'numeric-time', 'offset'], doc: 'Numeric time formatted according to the given format string.' },
    'FRACTION-PART': { params: ['argument'], doc: 'Fractional part of the argument.' },
    'HIGHEST-ALGEBRAIC': { params: ['argument'], doc: 'Largest value the argument data item can hold.' },
    'INTEGER': { params: ['argument'], doc: 'Greatest integer not greater than the argument.' },
    'INTEGER-OF-BOOLEAN': { params: ['argument'], doc: 'Integer corresponding to a boolean value.' },
    'INTEGER-OF-DATE': { params: ['standard-date'], doc: 'Integer date for a standard date (YYYYMMDD).' },
    'INTEGER-OF-DAY': { params: ['julian-date'], doc: 'Integer date for a Julian date (YYYYDDD).' },
    'INTEGER-OF-FORMATTED-DATE': { params: ['format', 'date'], doc: 'Integer date for a formatted date string.' },
    'INTEGER-PART': { params: ['argument'], doc: 'Integer part of the argument (truncated toward zero).' },
    'LENGTH': { params: ['item'], doc: 'Length of the argument in character positions (bytes for usage DISPLAY).' },
    'LENGTH-AN': { params: ['item'], doc: 'Length in alphanumeric character positions (bytes) of the argument.' },
    'LOCALE-COMPARE': { params: ['argument-1', 'argument-2', 'locale'], doc: 'Compares two operands using the cultural ordering of a locale.' },
    'LOCALE-DATE': { params: ['date', 'locale'], doc: 'Date formatted according to the rules of a locale.' },
    'LOCALE-TIME': { params: ['time', 'locale'], doc: 'Time formatted according to the rules of a locale.' },
    'LOCALE-TIME-FROM-SECONDS': { params: ['seconds', 'locale'], doc: 'Time (from seconds past midnight) formatted according to a locale.' },
    'LOG': { params: ['argument'], doc: 'Natural logarithm (base e) of the argument.' },
    'LOG10': { params: ['argument'], doc: 'Logarithm (base 10) of the argument.' },
    'LOWER-CASE': { params: ['string'], doc: 'The argument with all letters in lower case.' },
    'LOWEST-ALGEBRAIC': { params: ['argument'], doc: 'Smallest value the argument data item can hold.' },
    'MAX': { params: ['argument-1', 'argument-2 ...'], doc: 'Largest of the arguments.' },
    'MEAN': { params: ['argument-1', 'argument-2 ...'], doc: 'Arithmetic mean of the arguments.' },
    'MEDIAN': { params: ['argument-1', 'argument-2 ...'], doc: 'Median value of the arguments.' },
    'MIDRANGE': { params: ['argument-1', 'argument-2 ...'], doc: 'Mean of the largest and smallest arguments.' },
    'MIN': { params: ['argument-1', 'argument-2 ...'], doc: 'Smallest of the arguments.' },
    'MOD': { params: ['argument-1', 'argument-2'], doc: 'argument-1 modulo argument-2.' },
    'NATIONAL-OF': { params: ['string', 'replacement'], doc: 'National (Unicode) representation of an alphanumeric item.' },
    'NUMVAL': { params: ['string'], doc: 'Numeric value of a string of numeric characters.' },
    'NUMVAL-C': { params: ['string', 'currency-sign'], doc: 'Numeric value of a string that may contain a currency sign and separators.' },
    'NUMVAL-F': { params: ['string'], doc: 'Floating-point numeric value of a string.' },
    'ORD': { params: ['character'], doc: 'Ordinal position of the character in the collating sequence.' },
    'ORD-MAX': { params: ['argument-1', 'argument-2 ...'], doc: 'Ordinal position of the largest argument.' },
    'ORD-MIN': { params: ['argument-1', 'argument-2 ...'], doc: 'Ordinal position of the smallest argument.' },
    'PI': { params: [], doc: 'The mathematical constant pi (3.14159...).' },
    'PRESENT-VALUE': { params: ['argument-1', 'argument-2 ...'], doc: 'Present value of future amounts discounted at rate argument-1.' },
    'RANDOM': { params: ['seed'], doc: 'Pseudo-random number (the optional seed initializes the sequence).' },
    'RANGE': { params: ['argument-1', 'argument-2 ...'], doc: 'Difference between the largest and smallest argument.' },
    'REM': { params: ['argument-1', 'argument-2'], doc: 'Remainder of argument-1 divided by argument-2.' },
    'REVERSE': { params: ['string'], doc: 'The argument with its characters in reverse order.' },
    'SECONDS-FROM-FORMATTED-TIME': { params: ['format', 'time'], doc: 'Seconds past midnight for a formatted time value.' },
    'SECONDS-PAST-MIDNIGHT': { params: [], doc: 'Current number of seconds past midnight.' },
    'SIGN': { params: ['argument'], doc: 'Sign of the argument: -1, 0 or +1.' },
    'SIN': { params: ['argument'], doc: 'Sine of the argument (in radians).' },
    'SQRT': { params: ['argument'], doc: 'Square root of the argument.' },
    'STANDARD-COMPARE': { params: ['argument-1', 'argument-2'], doc: 'Compares two operands using the ISO/IEC 10646 coded character set.' },
    'STANDARD-DEVIATION': { params: ['argument-1', 'argument-2 ...'], doc: 'Standard deviation of the arguments.' },
    'STORED-CHAR-LENGTH': { params: ['item'], doc: 'Length of the argument excluding trailing spaces.' },
    'SUBSTITUTE': { params: ['subject', 'match-1', 'replacement-1 ...'], doc: 'The subject string with occurrences of each match replaced.' },
    'SUM': { params: ['argument-1', 'argument-2 ...'], doc: 'Sum of the arguments.' },
    'TAN': { params: ['argument'], doc: 'Tangent of the argument (in radians).' },
    'TEST-DATE-YYYYMMDD': { params: ['argument'], doc: 'Validates a YYYYMMDD date (returns 0 if valid).' },
    'TEST-DAY-YYYYDDD': { params: ['argument'], doc: 'Validates a YYYYDDD Julian date (returns 0 if valid).' },
    'TEST-FORMATTED-DATETIME': { params: ['format', 'value'], doc: 'Validates a formatted date/time string (returns 0 if valid).' },
    'TEST-NUMVAL': { params: ['string'], doc: 'Validates a string for NUMVAL (returns 0 if valid).' },
    'TEST-NUMVAL-C': { params: ['string', 'currency-sign'], doc: 'Validates a string for NUMVAL-C (returns 0 if valid).' },
    'TEST-NUMVAL-F': { params: ['string'], doc: 'Validates a string for NUMVAL-F (returns 0 if valid).' },
    'TRIM': { params: ['string', 'LEADING | TRAILING'], doc: 'The argument with leading and/or trailing spaces removed.' },
    'ULENGTH': { params: ['item'], doc: 'Number of characters (not bytes) in a Unicode item.' },
    'UPOS': { params: ['item', 'position'], doc: 'Byte position of the character at the given position in a Unicode item.' },
    'UPPER-CASE': { params: ['string'], doc: 'The argument with all letters in upper case.' },
    'USUBSTR': { params: ['item', 'start', 'length'], doc: 'Substring of a Unicode item by character position.' },
    'USUPPLEMENTARY': { params: ['item'], doc: 'Position of the first supplementary character in a Unicode item.' },
    'UVALID': { params: ['item'], doc: 'Validates the encoding of a Unicode item.' },
    'UWIDTH': { params: ['item', 'position'], doc: 'Number of bytes of the character at the given position in a Unicode item.' },
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
