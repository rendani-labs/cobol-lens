// @ts-check
'use strict';

/**
 * Quick Fix (Code Actions) per le diagnostiche del linter di COBOL Lens.
 *
 * Le correzioni sono volutamente NON distruttive: aggiungono testo (END-xxx,
 * punto finale, GOBACK, livello) oppure normalizzano il maiuscolo senza
 * riscrivere l'allineamento delle colonne.
 *
 * Nota architetturale: VS Code NON conserva le proprieta' custom sugli oggetti
 * Diagnostic quando li passa a un CodeActionProvider (sopravvivono solo range,
 * message, severity, code, source). Per questo ogni fix viene ri-derivato dal
 * contenuto del documento e, dove serve, dal testo del messaggio.
 */

const vscode = require('vscode');
const { msg } = require('./messages');

/** Codici diagnostica gestiti da un Quick Fix. */
const HANDLED_CODES = new Set([
    'uppercase',
    'missing-period',
    'missing-stop-run',
    'missing-level',
    'end-structure',
    'missing-file-status',
    'pic-alignment',
    'move-to-alignment',
    'select-col12',
    'assign-col29',
]);

/**
 * Converte in maiuscolo solo il testo fuori dai letterali stringa.
 * In COBOL il codice e' case-insensitive fuori dai letterali, quindi il
 * contenuto tra apici (singoli o doppi) va preservato.
 * @param {string} text
 * @returns {string}
 */
function toUpperPreservingLiterals(text) {
    let out = '';
    let quote = null; // "'" oppure '"'
    for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (quote) {
            out += ch;
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            out += ch;
        } else {
            out += ch.toUpperCase();
        }
    }
    return out;
}

/**
 * Trova l'indice del punto che chiude una frase (statement terminator) nel
 * testo, ignorando i punti dentro i letterali e i punti decimali dei numeri.
 * Un punto e' considerato terminatore se e' seguito da spazio o fine riga.
 * @param {string} text
 * @returns {number} indice 0-based del punto, oppure -1
 */
function findClosingPeriod(text) {
    let quote = null;
    for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '.') {
            const next = k + 1 < text.length ? text[k + 1] : '';
            // Terminatore solo se seguito da spazio o fine riga (esclude 1.5)
            if (next === '' || /\s/.test(next)) return k;
        }
    }
    return -1;
}

/**
 * Crea una CodeAction di tipo QuickFix collegata alla diagnostica.
 * @param {string} title
 * @param {vscode.Diagnostic} diagnostic
 * @param {vscode.Uri} uri
 * @param {(edit: vscode.WorkspaceEdit) => void} build
 * @returns {vscode.CodeAction}
 */
function makeFix(title, diagnostic, uri, build) {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    const edit = new vscode.WorkspaceEdit();
    build(edit);
    action.edit = edit;
    action.diagnostics = [diagnostic];
    return action;
}

/**
 * Provider di Quick Fix per le diagnostiche del linter.
 */
class CobolCodeActionProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Range} range
     * @param {vscode.CodeActionContext} context
     * @returns {vscode.CodeAction[]}
     */
    provideCodeActions(document, range, context) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('codeActions.enabled', true)) return [];

        const actions = [];
        for (const diag of context.diagnostics) {
            if (diag.source !== 'COBOL Lens') continue;
            const code = typeof diag.code === 'object' && diag.code !== null
                ? diag.code.value : diag.code;

            // Quick Fix di soppressione (validi per qualunque regola COBOL Lens)
            if (cfg.get('linter.suppressions.enabled', true)) {
                const suppressLine = this._suppressLine(document, diag, String(code));
                if (suppressLine) actions.push(suppressLine);
                const suppressFile = this._suppressFile(document, diag, String(code));
                if (suppressFile) actions.push(suppressFile);
            }

            if (!HANDLED_CODES.has(String(code))) continue;

            let action = null;
            switch (String(code)) {
                case 'uppercase': action = this._fixUppercase(document, diag); break;
                case 'missing-period': action = this._fixMissingPeriod(document, diag); break;
                case 'missing-stop-run': action = this._fixMissingStopRun(document, diag); break;
                case 'missing-level': action = this._fixMissingLevel(document, diag); break;
                case 'end-structure': action = this._fixEndStructure(document, diag); break;
                case 'missing-file-status': action = this._fixMissingFileStatus(document, diag); break;
                case 'pic-alignment': action = this._fixPicAlignment(document, diag); break;
                case 'move-to-alignment': action = this._fixMoveToAlignment(document, diag); break;
                case 'select-col12': action = this._fixSelectCol12(document, diag); break;
                case 'assign-col29': action = this._fixAssignCol29(document, diag); break;
            }
            if (action) actions.push(action);
        }
        return actions;
    }

    /**
     * uppercase -> converte la porzione di codice (col 8+) in maiuscolo,
     * preservando i letterali stringa.
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixUppercase(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        // Porzione di codice: per fixed/variable da col 8 (indice 7); per sicurezza
        // se la riga e' piu' corta lasciamo invariata l'area sequenza.
        const seqEnd = Math.min(7, text.length);
        const head = text.substring(0, seqEnd);
        const body = text.substring(seqEnd);
        const upper = toUpperPreservingLiterals(body);
        if (upper === body) return null;
        return makeFix(msg('fixUppercase'), diag, document.uri, edit => {
            edit.replace(document.uri,
                new vscode.Range(lineNum, seqEnd, lineNum, text.length),
                upper);
        });
    }

    /**
     * missing-period -> aggiunge il punto dopo l'ultimo carattere non spazio.
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixMissingPeriod(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        const trimmedEnd = text.replace(/\s+$/, '');
        if (trimmedEnd.endsWith('.')) return null;
        const col = trimmedEnd.length;
        return makeFix(msg('fixMissingPeriod'), diag, document.uri, edit => {
            edit.insert(document.uri, new vscode.Position(lineNum, col), '.');
        });
    }

    /**
     * missing-stop-run -> inserisce una riga "GOBACK." in Area B dopo l'ultima
     * riga della PROCEDURE DIVISION segnalata.
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixMissingStopRun(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        // 11 spazi -> il codice inizia a colonna 12 (Area B)
        const newLine = eol + '           GOBACK.';
        return makeFix(msg('fixMissingStopRun'), diag, document.uri, edit => {
            edit.insert(document.uri, new vscode.Position(lineNum, text.length), newLine);
        });
    }

    /**
     * missing-level -> inserisce un numero di livello prima del nome.
     * Il livello viene dedotto dalla definizione dati precedente (sibling);
     * in mancanza si usa 05.
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixMissingLevel(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        // Colonna del primo carattere non spazio nell'area codice (da col 8)
        const start = Math.min(7, text.length);
        let nameCol = start;
        while (nameCol < text.length && /\s/.test(text[nameCol])) nameCol++;
        if (nameCol >= text.length) return null;

        // Deduce il livello dalla precedente definizione dati
        let level = '05';
        for (let j = lineNum - 1; j >= 0; j--) {
            const prev = document.lineAt(j).text;
            if (prev.length < 8) continue;
            const codePart = prev.substring(7);
            const m = codePart.match(/^\s*(\d{1,2})\s+/);
            if (m) { level = m[1]; break; }
        }
        return makeFix(msg('fixMissingLevel', level), diag, document.uri, edit => {
            edit.insert(document.uri, new vscode.Position(lineNum, nameCol), level + ' ');
        });
    }

    /**
     * end-structure -> inserisce END-xxx su una riga propria, allineato alla
     * colonna dello statement di apertura, spostando il punto di chiusura dopo
     * END-xxx. Il tipo viene estratto dal messaggio (END-<TYPE>, identico in
     * italiano e inglese); il punto di chiusura e' il primo terminatore di
     * frase a partire dalla riga di apertura.
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixEndStructure(document, diag) {
        // Gestisce solo il caso "chiusa da un punto" (endStructurePoint),
        // che contiene il token END-<TYPE> nel messaggio.
        const m = /END-([A-Z]+)/.exec(diag.message);
        if (!m) return null;
        const type = m[1];

        const openLine = diag.range.start.line;
        if (openLine >= document.lineCount) return null;

        // Indentazione dello statement di apertura: numero di spazi iniziali.
        const openText = document.lineAt(openLine).text;
        const openIndent = openText.length - openText.replace(/^\s+/, '').length;
        const indentStr = ' '.repeat(openIndent);
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        // Trova la riga e la colonna del punto di chiusura
        for (let i = openLine; i < document.lineCount; i++) {
            const raw = document.lineAt(i).text;
            // Salta righe di commento (col 7 = * o /) e righe troppo corte
            if (raw.length > 6 && (raw[6] === '*' || raw[6] === '/')) continue;
            const period = findClosingPeriod(raw);
            if (period < 0) continue;

            // Sostituisce gli spazi residui prima del punto e il punto stesso con
            // una nuova riga "<indent>END-TYPE." mantenendo l'eventuale coda.
            const cutStart = raw.substring(0, period).replace(/\s+$/, '').length;
            const replacement = eol + indentStr + 'END-' + type + '.';
            return makeFix(msg('fixEndStructure', type), diag, document.uri, edit => {
                edit.replace(document.uri,
                    new vscode.Range(i, cutStart, i, period + 1),
                    replacement);
            });
        }
        return null;
    }

    /**
     * missing-file-status -> aggiunge la clausola "STATUS FS-<file>" alla frase
     * SELECT, su una riga propria allineata allo statement, prima del punto di
     * chiusura. Il nome della variabile di stato e' derivato dal nome del file
     * (FS-<file>), troncato a 30 caratteri (limite identificatori COBOL).
     * La variabile va poi definita in WORKING-STORAGE dall'utente.
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixMissingFileStatus(document, diag) {
        const openLine = diag.range.start.line;
        if (openLine >= document.lineCount) return null;

        const openText = document.lineAt(openLine).text;
        const selMatch = /\bSELECT\s+([A-Za-z0-9][\w-]*)/i.exec(openText);
        if (!selMatch) return null;
        // Nome variabile di stato: FS-<file>, max 30 caratteri.
        const statusName = ('FS-' + selMatch[1]).substring(0, 30).toUpperCase();

        const openIndent = openText.length - openText.replace(/^\s+/, '').length;
        const indentStr = ' '.repeat(openIndent);
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        // Trova la riga/colonna del punto che chiude la frase SELECT.
        for (let i = openLine; i < document.lineCount; i++) {
            const raw = document.lineAt(i).text;
            if (raw.length > 6 && (raw[6] === '*' || raw[6] === '/')) continue;
            const period = findClosingPeriod(raw);
            if (period < 0) continue;

            // Inserisce "STATUS FS-..." su riga propria prima del punto, che resta.
            const cutStart = raw.substring(0, period).replace(/\s+$/, '').length;
            const replacement = eol + indentStr + 'STATUS ' + statusName;
            return makeFix(msg('fixMissingFileStatus', statusName), diag, document.uri, edit => {
                edit.replace(document.uri,
                    new vscode.Range(i, cutStart, i, period),
                    replacement);
            });
        }
        return null;
    }

    /**
     * pic-alignment -> sposta la keyword PIC alla colonna 45 modificando solo
     * gli spazi tra il nome del campo e PIC (non distruttivo).
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixPicAlignment(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        return this._alignKeyword(document, diag, lineNum, /\bPIC\b/, 45,
            () => msg('fixPicAlignment', 45));
    }

    /**
     * move-to-alignment -> sposta il TO di un MOVE alla colonna 45 modificando
     * solo gli spazi che lo precedono (non distruttivo).
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixMoveToAlignment(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        const upper = text.toUpperCase();
        const moveM = /\bMOVE\b/.exec(upper);
        if (!moveM) return null;
        const afterMove = moveM.index + moveM[0].length;
        const toM = /\bTO\b/.exec(upper.substring(afterMove));
        if (!toM) return null;
        const toIndex = afterMove + toM.index; // 0-based
        return this._alignAt(document, diag, lineNum, toIndex, 45,
            () => msg('fixMoveToAlignment', 45));
    }

    /**
     * select-col12 -> riallinea l'indentazione iniziale del SELECT a colonna 12.
     * Agisce solo se prima di SELECT ci sono solo spazi (non distruttivo).
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixSelectCol12(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        const m = /\bSELECT\b/.exec(text.toUpperCase());
        if (!m) return null;
        const idx = m.index; // 0-based
        if (/\S/.test(text.substring(0, idx))) return null; // solo spazi prima
        const target = 11; // colonna 12, 0-based
        if (idx === target) return null;
        return makeFix(msg('fixSelectCol12', 12), diag, document.uri, edit => {
            edit.replace(document.uri,
                new vscode.Range(lineNum, 0, lineNum, idx),
                ' '.repeat(target));
        });
    }

    /**
     * assign-col29 -> riallinea la clausola (ASSIGN/ORGANIZATION/ACCESS/STATUS/
     * RECORD KEY) a colonna 29. La clausola e' il primo token della riga; agisce
     * solo modificando l'indentazione iniziale (non distruttivo).
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @returns {vscode.CodeAction|null}
     */
    _fixAssignCol29(document, diag) {
        const lineNum = diag.range.start.line;
        if (lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        const stripped = text.toUpperCase().trim();
        const keywords = ['ASSIGN', 'ORGANIZATION', 'RECORD KEY', 'ACCESS', 'STATUS'];
        const kw = keywords.find(k => stripped.startsWith(k));
        if (!kw) return null;
        const idx = text.length - text.replace(/^\s+/, '').length; // colonna del 1o token
        const target = 28; // colonna 29, 0-based
        if (idx === target) return null;
        return makeFix(msg('fixAssignCol29', kw, 29), diag, document.uri, edit => {
            edit.replace(document.uri,
                new vscode.Range(lineNum, 0, lineNum, idx),
                ' '.repeat(target));
        });
    }

    /**
     * Allinea la prima occorrenza di una keyword (es. PIC) alla colonna indicata,
     * modificando solo gli spazi che la precedono entro la stessa riga.
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @param {number} lineNum
     * @param {RegExp} kwRegex - regex per individuare la keyword (su testo MAIUSCOLO)
     * @param {number} targetColumn - colonna 1-based desiderata
     * @param {() => string} title
     * @returns {vscode.CodeAction|null}
     */
    _alignKeyword(document, diag, lineNum, kwRegex, targetColumn, title) {
        const text = document.lineAt(lineNum).text;
        const m = kwRegex.exec(text.toUpperCase());
        if (!m) return null;
        return this._alignAt(document, diag, lineNum, m.index, targetColumn, title);
    }

    /**
     * Sopprime una diagnostica sulla riga segnalata inserendo, subito sopra, un
     * commento a riga intera "cobol-lens-disable-next-line <regola>" (indicatore
     * '*' in colonna 7, cosi' viene ignorato da tutte le regole).
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @param {string} code
     * @returns {vscode.CodeAction|null}
     */
    _suppressLine(document, diag, code) {
        const lineNum = diag.range.start.line;
        if (lineNum < 0 || lineNum >= document.lineCount) return null;
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const commentLine = '      * cobol-lens-disable-next-line ' + code;
        const action = new vscode.CodeAction(
            msg('fixSuppressLine', code), vscode.CodeActionKind.QuickFix);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(lineNum, 0), commentLine + eol);
        action.edit = edit;
        action.diagnostics = [diag];
        return action;
    }

    /**
     * Sopprime una diagnostica in tutto il file inserendo, in cima al documento,
     * un commento a riga intera "cobol-lens-disable <regola>".
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @param {string} code
     * @returns {vscode.CodeAction|null}
     */
    _suppressFile(document, diag, code) {
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const commentLine = '      * cobol-lens-disable ' + code;
        const action = new vscode.CodeAction(
            msg('fixSuppressFile', code), vscode.CodeActionKind.QuickFix);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), commentLine + eol);
        action.edit = edit;
        action.diagnostics = [diag];
        return action;
    }

    /**
     * Riallinea il token che inizia all'indice indicato alla colonna desiderata,
     * regolando solo gli spazi che lo precedono (mai meno di 1).
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diag
     * @param {number} lineNum
     * @param {number} tokenIndex - indice 0-based di inizio del token
     * @param {number} targetColumn - colonna 1-based desiderata
     * @param {() => string} title
     * @returns {vscode.CodeAction|null}
     */
    _alignAt(document, diag, lineNum, tokenIndex, targetColumn, title) {
        const text = document.lineAt(lineNum).text;
        const before = text.substring(0, tokenIndex).replace(/\s+$/, '');
        const target = targetColumn - 1; // 0-based
        // Serve almeno uno spazio tra il contenuto precedente e il token.
        if (before.length >= target) return null;
        const spaces = ' '.repeat(target - before.length);
        // Gia' allineato?
        if (text.substring(0, tokenIndex) === before + spaces) return null;
        return makeFix(title(), diag, document.uri, edit => {
            edit.replace(document.uri,
                new vscode.Range(lineNum, before.length, lineNum, tokenIndex),
                spaces);
        });
    }
}

module.exports = { CobolCodeActionProvider };
