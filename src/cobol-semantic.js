// @ts-check
'use strict';

const vscode = require('vscode');
const { isComment } = require('./cobol-parser');

/**
 * Legenda dei semantic token usati da COBOL Lens.
 * I tipi sono tipi standard riconosciuti dalla maggior parte dei temi,
 * cosi' la colorazione semantica si integra con il tema attivo.
 */
const TOKEN_TYPES = ['variable', 'namespace'];
const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, []);

const TYPE_VARIABLE = TOKEN_TYPES.indexOf('variable');
const TYPE_NAMESPACE = TOKEN_TYPES.indexOf('namespace');

/** Identificatore COBOL: lettere/cifre/trattini, deve iniziare con una lettera. */
const IDENTIFIER_REGEX = /[A-Za-z][A-Za-z0-9-]*/g;

/**
 * Tronca la riga rimuovendo la porzione di commento inline introdotta da '*>'.
 * Non considera '*>' all'interno di stringhe (gestite a parte).
 * @param {string} line
 * @returns {string}
 */
function stripInlineComment(line) {
    const idx = line.indexOf('*>');
    return idx >= 0 ? line.substring(0, idx) : line;
}

/**
 * Marca con spazi gli intervalli racchiusi tra apici (stringhe) cosi'
 * gli identificatori al loro interno non vengano colorati.
 * @param {string} line
 * @returns {string}
 */
function maskStrings(line) {
    let result = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line.charAt(i);
        if (quote) {
            result += ' ';
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
            result += ' ';
        } else {
            result += ch;
        }
    }
    return result;
}

/**
 * Marca con spazi la stringa di PICTURE (dopo PIC/PICTURE) cosi' i suoi
 * caratteri (X, A, N, 9, S, V, ...) non vengano colorati come variabili quando
 * coincidono con il nome di un simbolo del programma (es. una variabile chiamata
 * `X`). La lunghezza della riga e' preservata per non alterare le colonne.
 * @param {string} line
 * @returns {string}
 */
function maskPicture(line) {
    return line.replace(
        /(\bPIC(?:TURE)?\b(?:\s+IS)?\s+)([-+*/$,.()SVXAZ9BPGNEUWCRD0-9]+)/gi,
        (m, p1, p2) => p1 + ' '.repeat(p2.length));
}

/**
 * Provider di semantic tokens "consapevole dei simboli": colora le occorrenze
 * di variabili, paragrafi/section e copybook usando l'indice dei simboli gia'
 * costruito dall'estensione. Si sovrappone alla grammatica TextMate di base.
 */
class CobolSemanticTokensProvider {
    /**
     * @param {import('./symbol-index').SymbolIndex} symbolIndex
     */
    constructor(symbolIndex) {
        this._symbolIndex = symbolIndex;
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.SemanticTokens}
     */
    provideDocumentSemanticTokens(document) {
        const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);

        // Mappa nome (maiuscolo) -> tipo di token, dai simboli del documento.
        const symbols = this._symbolIndex.getSymbols(document);
        /** @type {Map<string, number>} */
        const nameToType = new Map();
        for (const sym of symbols) {
            let tokenType;
            switch (sym.type) {
                case 'variable': tokenType = TYPE_VARIABLE; break;
                case 'copy': tokenType = TYPE_NAMESPACE; break;
                default: continue;
            }
            // Non sovrascrivere: la prima definizione vince (es. variabile vs paragrafo).
            if (!nameToType.has(sym.name)) {
                nameToType.set(sym.name, tokenType);
            }
        }

        if (nameToType.size === 0) {
            return builder.build();
        }

        const lines = document.getText().split(/\r?\n/);
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
            const raw = lines[lineNo];
            if (isComment(raw)) continue;

            const text = maskPicture(maskStrings(stripInlineComment(raw)));
            IDENTIFIER_REGEX.lastIndex = 0;
            let match;
            while ((match = IDENTIFIER_REGEX.exec(text)) !== null) {
                const word = match[0].toUpperCase();
                const tokenType = nameToType.get(word);
                if (tokenType === undefined) continue;
                builder.push(lineNo, match.index, match[0].length, tokenType, 0);
            }
        }

        return builder.build();
    }
}

module.exports = {
    CobolSemanticTokensProvider,
    SEMANTIC_LEGEND,
    maskPicture
};
