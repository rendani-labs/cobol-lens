// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { resolveCopybookPath, COPY_REGEX, isComment, COBOL_RESERVED, parseCallStatement, resolveProgramPath, parseValueClause, findConditionNames, findConditionParent } = require('./cobol-parser');
const { SymbolIndex } = require('./symbol-index');
const { runLinter } = require('./cobol-linter');
const { computeFieldSize, collectLayout, computeFieldInfoAt } = require('./cobol-layout');
const { msg, getLang, setLang } = require('./messages');
const { CobolSemanticTokensProvider, SEMANTIC_LEGEND } = require('./cobol-semantic');
const { CobolCodeActionProvider } = require('./cobol-code-actions');
const { CobolFormattingProvider } = require('./cobol-formatter');
const { getSignatureAt } = require('./cobol-signatures');
/** Indice simboli condiviso tra tutti i provider */
const symbolIndex = new SymbolIndex();

// ============================================================================
// Utility
// ============================================================================

/**
 * Ottiene il workspace root per un documento.
 * Per file fuori dal workspace (es. aperti da ftp-simple) fa fallback
 * al primo workspace folder disponibile.
 * @param {vscode.TextDocument} document
 * @returns {{ folder: vscode.WorkspaceFolder | undefined, fsPath: string | undefined }}
 */
function getWorkspaceRoot(document) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) return { folder, fsPath: folder.uri.fsPath };

    // Fallback: primo workspace folder (utile per file remoti copiati in temp)
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return { folder: folders[0], fsPath: folders[0].uri.fsPath };
    }
    return { folder: undefined, fsPath: undefined };
}

/**
 * Estrae la parola (identificatore COBOL) sotto il cursore.
 * Identificatori COBOL: lettere, cifre, trattini.
 * Non usa getWordRangeAtPosition che dipende da editor.wordSeparators
 * e tratta '-' come separatore, spezzando nomi come WS-NOME.
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{ word: string, range: vscode.Range } | undefined}
 */
function getWordAtPosition(document, position) {
    const line = document.lineAt(position.line).text;
    let col = position.character;

    // Se il cursore è alla fine della selezione o dopo l'ultimo carattere
    // dell'identificatore, prova il carattere precedente
    if (col >= line.length || !/[A-Za-z0-9-]/.test(line.charAt(col))) {
        if (col > 0 && /[A-Za-z0-9-]/.test(line.charAt(col - 1))) {
            col = col - 1;
        } else {
            return undefined;
        }
    }

    // Verifica che il carattere sotto il cursore sia parte di un identificatore COBOL
    const ch = line.charAt(col);
    if (!/[A-Za-z0-9-]/.test(ch)) return undefined;

    // Cerca l'inizio dell'identificatore (espandendo a sinistra)
    let start = col;
    while (start > 0 && /[A-Za-z0-9-]/.test(line.charAt(start - 1))) {
        start--;
    }

    // Cerca la fine dell'identificatore (espandendo a destra)
    let end = col;
    while (end < line.length - 1 && /[A-Za-z0-9-]/.test(line.charAt(end + 1))) {
        end++;
    }
    end++; // end esclusivo

    const word = line.substring(start, end);

    // L'identificatore deve iniziare con una lettera
    if (!/^[A-Za-z]/.test(word)) return undefined;

    const range = new vscode.Range(position.line, start, position.line, end);
    return { word, range };
}

/**
 * Ottiene le righe del file dove e' definito un simbolo.
 * Usa il documento aperto se coincide, altrimenti legge da disco (copybook).
 * @param {vscode.TextDocument} document
 * @param {string} filePath
 * @returns {string[] | undefined}
 */
function getFileLines(document, filePath) {
    if (document.uri.fsPath === filePath) {
        return document.getText().split(/\r?\n/);
    }
    try {
        return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    } catch (e) {
        return undefined;
    }
}

/**
 * Verifica se la riga contiene un'istruzione COPY e restituisce info.
 * @param {string} line
 * @returns {{ copyName: string, nameStart: number } | undefined}
 */
function parseCopyFromLine(line) {
    const match = COPY_REGEX.exec(line);
    if (!match) return undefined;
    const copyName = match[1];
    const nameStart = line.toUpperCase().indexOf(copyName.toUpperCase(),
        line.toUpperCase().indexOf('COPY') + 4);
    if (nameStart < 0) return undefined;
    return { copyName, nameStart };
}

/**
 * Se il nome e' un identificatore (variabile), risolve la sua clausola VALUE a
 * un letterale stringa (es. 01 WS-PROG PIC X(8) VALUE 'PGMXYZ'), utile per i
 * CALL indiretti. Restituisce il testo del letterale o undefined.
 * @param {vscode.TextDocument} document
 * @param {string} name
 * @returns {string | undefined}
 */
function resolveIdentifierValueLiteral(document, name) {
    const symbol = symbolIndex.findSymbol(document, name);
    if (!symbol) return undefined;
    const lines = getFileLines(document, symbol.filePath);
    if (!lines || symbol.line >= lines.length) return undefined;
    const defText = lines[symbol.line];
    const vm = /VALUE\s+(?:IS\s+)?(['"])([^'"]+)\1/i.exec(defText);
    return vm ? vm[2] : undefined;
}

/**
 * Risolve il file sorgente del programma bersaglio di una CALL. Per i CALL
 * letterali usa direttamente il nome; per i CALL a variabile prova a risolvere
 * la VALUE della variabile a un letterale.
 * @param {vscode.TextDocument} document
 * @param {{ name: string, isLiteral: boolean }} callInfo
 * @returns {string | undefined}
 */
function resolveCallProgramPath(document, callInfo) {
    const { fsPath: wsRoot } = getWorkspaceRoot(document);
    if (!wsRoot) return undefined;
    let programName = callInfo.name;
    if (!callInfo.isLiteral) {
        const literal = resolveIdentifierValueLiteral(document, callInfo.name);
        if (!literal) return undefined;
        programName = literal;
    }
    return resolveProgramPath(programName, wsRoot);
}

/**
 * Trova le occorrenze "whole word" di un nome (case-insensitive) in un array
 * di righe, saltando i commenti e il contenuto dei letterali stringa.
 * Usato dal rename per non toccare keyword/sottostringhe o testo tra apici.
 * @param {string[]} lines
 * @param {string} searchUpper - nome del simbolo in MAIUSCOLO
 * @returns {{ line: number, start: number }[]}
 */
function findWordOccurrences(lines, searchUpper) {
    /** @type {{ line: number, start: number }[]} */
    const results = [];
    for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        if (isComment(lineText)) continue;
        const upper = lineText.toUpperCase();

        // Maschera delle posizioni dentro letterali stringa ('...' o "...")
        const litMask = new Array(lineText.length).fill(false);
        let quote = null;
        for (let k = 0; k < lineText.length; k++) {
            const ch = lineText[k];
            if (quote) { litMask[k] = true; if (ch === quote) quote = null; }
            else if (ch === '"' || ch === "'") { quote = ch; litMask[k] = true; }
        }

        let from = 0;
        while (true) {
            const idx = upper.indexOf(searchUpper, from);
            if (idx < 0) break;
            const end = idx + searchUpper.length;
            const before = idx > 0 ? upper.charAt(idx - 1) : ' ';
            const after = end < upper.length ? upper.charAt(end) : ' ';
            const boundary = !/[A-Z0-9-]/.test(before) && !/[A-Z0-9-]/.test(after);
            if (boundary && !litMask[idx]) results.push({ line: i, start: idx });
            from = end;
        }
    }
    return results;
}

// ============================================================================
// DefinitionProvider ? COPY + variabili/paragrafi/sezioni
// ============================================================================

class CobolDefinitionProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.Definition | undefined}
     */
    provideDefinition(document, position) {
        const line = document.lineAt(position.line).text;

        // Salta commenti
        if (isComment(line)) return undefined;

        // 1. Prova COPY statement
        const copyInfo = parseCopyFromLine(line);
        if (copyInfo) {
            const copyKeywordStart = line.toUpperCase().indexOf('COPY');
            const nameEnd = copyInfo.nameStart + copyInfo.copyName.length;
            if (position.character >= copyKeywordStart && position.character <= nameEnd) {
                const { fsPath: wsRoot } = getWorkspaceRoot(document);
                if (!wsRoot) return undefined;
                const resolved = resolveCopybookPath(copyInfo.copyName, wsRoot);
                if (resolved) {
                    return new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
                }
                return undefined;
            }
        }

        // 1b. Prova CALL 'programma' / CALL variabile
        const callInfo = parseCallStatement(line);
        if (callInfo && position.character >= callInfo.nameStart && position.character <= callInfo.nameEnd) {
            const resolvedProgram = resolveCallProgramPath(document, callInfo);
            if (resolvedProgram) {
                return new vscode.Location(vscode.Uri.file(resolvedProgram), new vscode.Position(0, 0));
            }
            // Letterale non risolto: nessuna definizione. Per una variabile,
            // prosegue verso la definizione della variabile stessa.
            if (callInfo.isLiteral) return undefined;
        }

        // 2. Prova simbolo (variabile, paragrafo, sezione)
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return undefined;

        const symbol = symbolIndex.findSymbol(document, wordInfo.word);
        if (!symbol) return undefined;

        return new vscode.Location(
            vscode.Uri.file(symbol.filePath),
            new vscode.Position(symbol.line, symbol.column)
        );
    }
}

// ============================================================================
// HoverProvider ? COPY + variabili/paragrafi/sezioni
// ============================================================================

class CobolHoverProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.Hover | undefined}
     */
    provideHover(document, position) {
        const line = document.lineAt(position.line).text;
        if (isComment(line)) return undefined;

        // Allinea la lingua dei messaggi hover al setting cobolLens.language
        setLang(getLang());

        const { folder: workspaceFolder, fsPath: wsRoot } = getWorkspaceRoot(document);

        // 1. COPY hover
        const copyInfo = parseCopyFromLine(line);
        if (copyInfo) {
            const copyKeywordStart = line.toUpperCase().indexOf('COPY');
            const nameEnd = copyInfo.nameStart + copyInfo.copyName.length;
            if (position.character >= copyKeywordStart && position.character <= nameEnd) {
                const range = new vscode.Range(
                    position.line, copyInfo.nameStart,
                    position.line, nameEnd
                );
                if (wsRoot) {
                    const resolved = resolveCopybookPath(copyInfo.copyName, wsRoot);
                    const content = new vscode.MarkdownString();
                    if (resolved) {
                        const relPath = path.relative(wsRoot, resolved);
                        content.appendMarkdown(`**Copybook:** \`${copyInfo.copyName}\`\n\n`);
                        content.appendMarkdown(`**Path:** \`${relPath}\`\n\n`);
                        content.appendMarkdown(`[${msg('hoverOpenCopybook')}](${vscode.Uri.file(resolved)})`);
                        content.isTrusted = true;
                        // Mostra anteprima contenuto (max 30 righe)
                        try {
                            const fileContent = fs.readFileSync(resolved, 'utf-8');
                            const previewLines = fileContent.split(/\r?\n/).slice(0, 30);
                            let preview = previewLines.join('\n');
                            if (fileContent.split(/\r?\n/).length > 30) {
                                preview += `\n      * ${msg('hoverContinued')}`;
                            }
                            content.appendMarkdown('\n\n---\n\n');
                            content.appendCodeblock(preview, 'cobol');
                        } catch (e) { /* ignore */ }
                    } else {
                        content.appendMarkdown(`**Copybook:** \`${copyInfo.copyName}\`\n\n`);
                        content.appendMarkdown(`**Warning:** *${msg('hoverCopybookNotFound')}*`);
                    }
                    return new vscode.Hover(content, range);
                }
            }
        }

        // 2. Hover su simbolo
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return undefined;

        const symbols = symbolIndex.findAllSymbols(document, wordInfo.word);
        if (symbols.length === 0) return undefined;

        const content = new vscode.MarkdownString();
        for (const sym of symbols) {
            const typeLabel = sym.type === 'variable' ? msg('hoverVariable', sym.level)
                : sym.type === 'paragraph' ? msg('hoverParagraph')
                : sym.type === 'section' ? msg('hoverSection') : sym.type;

            const relPath = wsRoot
                ? path.relative(wsRoot, sym.filePath)
                : path.basename(sym.filePath);

            content.appendMarkdown(`**${typeLabel}:** \`${sym.originalName}\`\n\n`);
            content.appendMarkdown(`File: \`${relPath}\` ${msg('hoverLineWord')} ${sym.line + 1}\n\n`);

            // Dimensione in byte del campo/gruppo (solo per le variabili)
            if (sym.type === 'variable') {
                const fileLines = getFileLines(document, sym.filePath);
                if (fileLines) {
                    const sizeInfo = computeFieldSize(fileLines, sym.line, wsRoot);
                    if (sizeInfo) {
                        const label = sizeInfo.isGroup ? msg('hoverAreaSize') : msg('hoverSize');
                        content.appendMarkdown(`**${label}:** ${sizeInfo.size} byte\n\n`);
                    }
                    // Posizione in byte (solo se gli inlay hint sono in modalita' 'hover')
                    const cfg = vscode.workspace.getConfiguration('cobolLens');
                    if (cfg.get('inlayHints.enabled', true)
                        && cfg.get('inlayHints.display', 'inline') === 'hover') {
                        const info = computeFieldInfoAt(fileLines, sym.line, wsRoot);
                        if (info) {
                            content.appendMarkdown(`**${msg('hoverPosition')}:** ${info.offset + 1}\n\n`);
                        }
                    }

                    // Condition-name (88): mostra il campo padre e il/i VALUE.
                    if (sym.level === 88) {
                        const parent = findConditionParent(fileLines, sym.line);
                        if (parent) {
                            content.appendMarkdown(`**${msg('hoverConditionOf')}:** \`${parent.name}\`\n\n`);
                        }
                        const val = parseValueClause(sym.lineText || fileLines[sym.line] || '');
                        if (val) {
                            content.appendMarkdown(`**VALUE:** \`${val}\`\n\n`);
                        }
                    } else {
                        // Campo con condition-name subordinati: elencali con i valori.
                        const conds = findConditionNames(fileLines, sym.line);
                        if (conds.length) {
                            content.appendMarkdown(`**${msg('hoverConditions')}:**\n\n`);
                            for (const c of conds) {
                                content.appendMarkdown(
                                    `- \`${c.name}\`${c.value ? ` = \`${c.value}\`` : ''}\n`);
                            }
                            content.appendMarkdown('\n');
                        }
                    }
                }
            }

            if (sym.lineText) {
                // Allinea il codice alla colonna 8 (Area A): le prime 7 colonne
                // restano vuote (area margine) cosi' nel codeblock la grammatica
                // non colora di verde il livello/nome come fosse l'area sequenza.
                content.appendCodeblock('       ' + sym.lineText.trim(), 'cobol');
            }
            if (symbols.length > 1) {
                content.appendMarkdown('---\n\n');
            }
        }

        return new vscode.Hover(content, wordInfo.range);
    }
}

// ============================================================================
// DocumentLinkProvider ? COPY statements cliccabili
// ============================================================================

class CobolCopyLinkProvider {
    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.DocumentLink[]}
     */
    provideDocumentLinks(document) {
        const links = [];
        const { fsPath: wsRoot } = getWorkspaceRoot(document);
        if (!wsRoot) return links;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (isComment(line)) continue;

            const copyInfo = parseCopyFromLine(line);
            if (copyInfo) {
                const resolved = resolveCopybookPath(copyInfo.copyName, wsRoot);
                if (resolved) {
                    const range = new vscode.Range(
                        i, copyInfo.nameStart,
                        i, copyInfo.nameStart + copyInfo.copyName.length
                    );
                    const link = new vscode.DocumentLink(range, vscode.Uri.file(resolved));
                    link.tooltip = `Apri copybook: ${path.basename(resolved)}`;
                    links.push(link);
                }
                continue;
            }

            // Link ai CALL verso un programma risolvibile nel workspace.
            const callInfo = parseCallStatement(line);
            if (callInfo) {
                const resolvedProgram = resolveCallProgramPath(document, callInfo);
                if (resolvedProgram) {
                    const range = new vscode.Range(
                        i, callInfo.nameStart, i, callInfo.nameEnd);
                    const link = new vscode.DocumentLink(range, vscode.Uri.file(resolvedProgram));
                    link.tooltip = `Apri programma: ${path.basename(resolvedProgram)}`;
                    links.push(link);
                }
            }
        }

        return links;
    }
}

// ============================================================================
// DocumentSymbolProvider ? Outline nel pannello laterale
// ============================================================================

class CobolDocumentSymbolProvider {
    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.DocumentSymbol[]}
     */
    provideDocumentSymbols(document) {
        const symbols = symbolIndex.getSymbols(document);
        /** @type {vscode.DocumentSymbol[]} */
        const result = [];

        for (const sym of symbols) {
            // Mostra solo i simboli definiti nel file corrente
            if (sym.filePath !== document.uri.fsPath) continue;

            const kind = sym.type === 'variable' ? vscode.SymbolKind.Variable
                : sym.type === 'paragraph' ? vscode.SymbolKind.Function
                : sym.type === 'section' ? vscode.SymbolKind.Module
                : sym.type === 'copy' ? vscode.SymbolKind.File
                : vscode.SymbolKind.Null;

            const range = new vscode.Range(sym.line, 0, sym.line, (sym.lineText || '').length);
            const selRange = new vscode.Range(sym.line, sym.column, sym.line, sym.column + sym.originalName.length);

            const detail = sym.type === 'variable' ? `Level ${sym.level}` : sym.type;
            const docSym = new vscode.DocumentSymbol(sym.originalName, detail, kind, range, selRange);
            result.push(docSym);
        }

        return result;
    }
}

// ============================================================================
// WorkspaceSymbolProvider ? Go to Symbol in Workspace (Ctrl+T)
// ============================================================================

/**
 * Esegue un match fuzzy (sottosequenza) case-insensitive tra query e testo.
 * Tutti i caratteri della query devono comparire, nell'ordine, dentro il testo.
 * @param {string} query - gia' in maiuscolo
 * @param {string} text - gia' in maiuscolo
 * @returns {boolean}
 */
function fuzzyMatch(query, text) {
    if (!query) return true;
    let q = 0;
    for (let t = 0; t < text.length && q < query.length; t++) {
        if (text[t] === query[q]) q++;
    }
    return q === query.length;
}

class CobolWorkspaceSymbolProvider {
    /**
     * @param {string} query
     * @param {vscode.CancellationToken} token
     * @returns {Promise<vscode.SymbolInformation[]>}
     */
    async provideWorkspaceSymbols(query, token) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('workspaceSymbols.enabled', true)) return [];

        const files = await vscode.workspace.findFiles(
            '**/*.{CBL,cbl,clt,CLT}', '**/node_modules/**', 5000);
        if (token.isCancellationRequested) return [];

        const upperQuery = (query || '').toUpperCase();
        /** @type {vscode.SymbolInformation[]} */
        const result = [];
        const MAX_RESULTS = 2000;

        for (const uri of files) {
            if (token.isCancellationRequested) break;
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            const wsRoot = folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
            const symbols = symbolIndex.getSymbolsFromFile(uri.fsPath, wsRoot);

            for (const sym of symbols) {
                // Solo simboli definiti nel file stesso (no espansioni copybook,
                // no riferimenti COPY) per evitare duplicati tra file.
                if (sym.type === 'copy') continue;
                if (sym.filePath !== uri.fsPath) continue;
                if (!fuzzyMatch(upperQuery, sym.name)) continue;

                const kind = sym.type === 'variable' ? vscode.SymbolKind.Variable
                    : sym.type === 'paragraph' ? vscode.SymbolKind.Function
                    : sym.type === 'section' ? vscode.SymbolKind.Module
                    : vscode.SymbolKind.Null;

                const selRange = new vscode.Range(
                    sym.line, sym.column,
                    sym.line, sym.column + sym.originalName.length);
                const containerName = path.basename(uri.fsPath);
                result.push(new vscode.SymbolInformation(
                    sym.originalName, kind, containerName,
                    new vscode.Location(uri, selRange)));

                if (result.length >= MAX_RESULTS) return result;
            }
        }

        return result;
    }
}

// ============================================================================
// ReferenceProvider ? Find All References (Shift+F12)
// ============================================================================

class CobolReferenceProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @param {vscode.ReferenceContext} context
     * @returns {vscode.Location[]}
     */
    provideReferences(document, position, context) {
        const line = document.lineAt(position.line).text;
        if (isComment(line)) return [];

        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return [];

        const searchName = wordInfo.word.toUpperCase();
        const locations = [];

        // Cerca nel documento corrente
        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            if (isComment(lineText)) continue;

            const upper = lineText.toUpperCase();
            let searchFrom = 0;
            while (true) {
                const idx = upper.indexOf(searchName, searchFrom);
                if (idx < 0) break;

                // Verifica che sia un identificatore intero (non parte di un nome più lungo)
                const before = idx > 0 ? upper.charAt(idx - 1) : ' ';
                const after = idx + searchName.length < upper.length ? upper.charAt(idx + searchName.length) : ' ';
                const isWordBoundary = !/[A-Z0-9-]/.test(before) && !/[A-Z0-9-]/.test(after);

                if (isWordBoundary) {
                    locations.push(new vscode.Location(
                        document.uri,
                        new vscode.Range(i, idx, i, idx + searchName.length)
                    ));
                }
                searchFrom = idx + searchName.length;
            }
        }

        // Cerca anche nelle copybook incluse (definizioni)
        const symbols = symbolIndex.getSymbols(document);
        for (const sym of symbols) {
            if (sym.name === searchName && sym.filePath !== document.uri.fsPath) {
                locations.push(new vscode.Location(
                    vscode.Uri.file(sym.filePath),
                    new vscode.Range(sym.line, sym.column, sym.line, sym.column + sym.originalName.length)
                ));
            }
        }

        // Se non include la definizione, rimuovi duplicati
        if (!context.includeDeclaration) {
            const defSymbol = symbolIndex.findSymbol(document, wordInfo.word);
            if (defSymbol) {
                return locations.filter(loc =>
                    !(loc.uri.fsPath === defSymbol.filePath && loc.range.start.line === defSymbol.line)
                );
            }
        }

        return locations;
    }
}

// ============================================================================
// DocumentHighlightProvider ? Evidenzia le occorrenze del simbolo sotto il cursore
// ============================================================================

class CobolDocumentHighlightProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.DocumentHighlight[]}
     */
    provideDocumentHighlights(document, position) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('documentHighlight.enabled', true)) return [];

        const line = document.lineAt(position.line).text;
        if (isComment(line)) return [];

        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return [];

        const lines = document.getText().split(/\r?\n/);
        const occurrences = findWordOccurrences(lines, wordInfo.word.toUpperCase());
        if (occurrences.length === 0) return [];

        // Riga di definizione (solo se il simbolo e' definito nel documento
        // corrente): la sua occorrenza viene evidenziata come "Write".
        const defSymbol = symbolIndex.findSymbol(document, wordInfo.word);
        const defLine = (defSymbol && defSymbol.filePath === document.uri.fsPath)
            ? defSymbol.line : -1;

        const width = wordInfo.word.length;
        return occurrences.map(o => new vscode.DocumentHighlight(
            new vscode.Range(o.line, o.start, o.line, o.start + width),
            o.line === defLine
                ? vscode.DocumentHighlightKind.Write
                : vscode.DocumentHighlightKind.Read));
    }
}

// ============================================================================
// SignatureHelpProvider ? Firme delle funzioni intrinseche COBOL
// ============================================================================

class CobolSignatureHelpProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.SignatureHelp | null}
     */
    provideSignatureHelp(document, position) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('signatureHelp.enabled', true)) return null;

        const line = document.lineAt(position.line).text;
        if (isComment(line)) return null;

        const sig = getSignatureAt(line, position.character);
        if (!sig) return null;

        const label = sig.params.length
            ? `FUNCTION ${sig.name}(${sig.params.join(', ')})`
            : `FUNCTION ${sig.name}`;
        const info = new vscode.SignatureInformation(label, new vscode.MarkdownString(sig.doc));
        info.parameters = sig.params.map(p => new vscode.ParameterInformation(p));

        const help = new vscode.SignatureHelp();
        help.signatures = [info];
        help.activeSignature = 0;
        help.activeParameter = sig.activeParameter;
        return help;
    }
}

// ============================================================================
// CodeLensProvider ? Conteggio reference sopra paragrafi e sezioni
// ============================================================================

class CobolCodeLensProvider {
    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.CodeLens[]}
     */
    provideCodeLenses(document) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('codeLens.enabled', false)) return [];

        setLang(getLang());
        const symbols = symbolIndex.getSymbols(document);
        const lines = document.getText().split(/\r?\n/);

        /** @type {vscode.CodeLens[]} */
        const lenses = [];
        for (const sym of symbols) {
            if (sym.type !== 'paragraph' && sym.type !== 'section') continue;
            // Solo simboli definiti nel file corrente
            if (sym.filePath !== document.uri.fsPath) continue;

            const occurrences = findWordOccurrences(lines, sym.name);
            // Le reference sono le occorrenze diverse dalla riga di definizione
            const refs = occurrences.filter(o => o.line !== sym.line);
            const locations = refs.map(o => new vscode.Location(
                document.uri,
                new vscode.Range(o.line, o.start, o.line, o.start + sym.originalName.length)));

            const count = locations.length;
            const range = new vscode.Range(sym.line, 0, sym.line, 0);
            const title = count === 1 ? msg('codeLensReference', count) : msg('codeLensReferences', count);
            const position = new vscode.Position(sym.line, sym.column);
            lenses.push(new vscode.CodeLens(range, {
                title,
                command: count > 0 ? 'editor.action.showReferences' : '',
                arguments: count > 0 ? [document.uri, position, locations] : undefined,
            }));
        }
        return lenses;
    }
}

// ============================================================================
// CallHierarchyProvider ? Gerarchia delle chiamate PERFORM tra paragrafi
// ============================================================================

/**
 * Restituisce i simboli di tipo paragrafo/sezione definiti nel documento,
 * ordinati per riga, con il range del corpo (dalla definizione fino alla
 * successiva definizione di paragrafo/sezione).
 * @param {vscode.TextDocument} document
 * @returns {{ sym: import('./cobol-parser').CobolSymbol, bodyStart: number, bodyEnd: number }[]}
 */
function getProcedureRanges(document) {
    const symbols = symbolIndex.getSymbols(document)
        .filter(s => (s.type === 'paragraph' || s.type === 'section')
            && s.filePath === document.uri.fsPath)
        .sort((a, b) => a.line - b.line);

    const result = [];
    for (let k = 0; k < symbols.length; k++) {
        const bodyStart = symbols[k].line;
        const bodyEnd = (k + 1 < symbols.length)
            ? symbols[k + 1].line - 1
            : document.lineCount - 1;
        result.push({ sym: symbols[k], bodyStart, bodyEnd });
    }
    return result;
}

/**
 * Estrae i nomi paragrafo/sezione invocati da una riga via PERFORM / GO TO,
 * inclusi gli estremi di un eventuale THRU/THROUGH.
 * @param {string} lineText
 * @returns {string[]} nomi in MAIUSCOLO
 */
function extractPerformTargets(lineText) {
    if (isComment(lineText)) return [];
    const upper = lineText.toUpperCase();
    /** @type {string[]} */
    const targets = [];
    const perfRe = /\bPERFORM\s+([A-Z0-9][\w-]*)(?:\s+(?:THRU|THROUGH)\s+([A-Z0-9][\w-]*))?/g;
    let m;
    while ((m = perfRe.exec(upper)) !== null) {
        targets.push(m[1]);
        if (m[2]) targets.push(m[2]);
    }
    const gotoRe = /\bGO\s+TO\s+([A-Z0-9][\w-]*)/g;
    while ((m = gotoRe.exec(upper)) !== null) {
        targets.push(m[1]);
    }
    return targets;
}

/**
 * Crea un CallHierarchyItem da un simbolo procedura.
 * @param {import('./cobol-parser').CobolSymbol} sym
 * @param {vscode.Uri} uri
 * @returns {vscode.CallHierarchyItem}
 */
function makeHierarchyItem(sym, uri) {
    const kind = sym.type === 'section'
        ? vscode.SymbolKind.Module
        : vscode.SymbolKind.Function;
    const selRange = new vscode.Range(
        sym.line, sym.column, sym.line, sym.column + sym.originalName.length);
    const range = new vscode.Range(sym.line, 0, sym.line, (sym.lineText || '').length);
    const detail = sym.type === 'section' ? 'Section' : 'Paragraph';
    return new vscode.CallHierarchyItem(kind, sym.originalName, detail, uri, range, selRange);
}

class CobolCallHierarchyProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.CallHierarchyItem | undefined}
     */
    prepareCallHierarchy(document, position) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('callHierarchy.enabled', true)) return undefined;

        const line = document.lineAt(position.line).text;
        if (isComment(line)) return undefined;
        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return undefined;

        const upperName = wordInfo.word.toUpperCase();
        const proc = getProcedureRanges(document)
            .find(p => p.sym.name === upperName);
        if (!proc) return undefined;
        return makeHierarchyItem(proc.sym, document.uri);
    }

    /**
     * Chiamate entranti: i paragrafi che eseguono un PERFORM verso questo.
     * @param {vscode.CallHierarchyItem} item
     * @returns {Promise<vscode.CallHierarchyIncomingCall[]>}
     */
    async provideCallHierarchyIncomingCalls(item) {
        const document = await vscode.workspace.openTextDocument(item.uri);
        const procs = getProcedureRanges(document);
        const targetName = (item.name || '').toUpperCase();

        /** @type {Map<string, { item: vscode.CallHierarchyItem, ranges: vscode.Range[] }>} */
        const callers = new Map();

        for (const proc of procs) {
            for (let i = proc.bodyStart; i <= proc.bodyEnd; i++) {
                const text = document.lineAt(i).text;
                const targets = extractPerformTargets(text);
                if (!targets.includes(targetName)) continue;

                // Posizione del nome chiamato sulla riga
                const idx = text.toUpperCase().indexOf(targetName);
                const range = new vscode.Range(i, idx >= 0 ? idx : 0,
                    i, idx >= 0 ? idx + targetName.length : 0);
                const key = proc.sym.name;
                if (!callers.has(key)) {
                    callers.set(key, { item: makeHierarchyItem(proc.sym, item.uri), ranges: [] });
                }
                callers.get(key).ranges.push(range);
            }
        }

        return [...callers.values()].map(c =>
            new vscode.CallHierarchyIncomingCall(c.item, c.ranges));
    }

    /**
     * Chiamate uscenti: i paragrafi eseguiti via PERFORM da questo.
     * @param {vscode.CallHierarchyItem} item
     * @returns {Promise<vscode.CallHierarchyOutgoingCall[]>}
     */
    async provideCallHierarchyOutgoingCalls(item) {
        const document = await vscode.workspace.openTextDocument(item.uri);
        const procs = getProcedureRanges(document);
        const self = procs.find(p => p.sym.name === (item.name || '').toUpperCase());
        if (!self) return [];

        const byName = new Map(procs.map(p => [p.sym.name, p]));

        /** @type {Map<string, { item: vscode.CallHierarchyItem, ranges: vscode.Range[] }>} */
        const callees = new Map();

        for (let i = self.bodyStart; i <= self.bodyEnd; i++) {
            const text = document.lineAt(i).text;
            const targets = extractPerformTargets(text);
            for (const name of targets) {
                const targetProc = byName.get(name);
                if (!targetProc) continue; // nome non definito nel file
                const idx = text.toUpperCase().indexOf(name);
                const range = new vscode.Range(i, idx >= 0 ? idx : 0,
                    i, idx >= 0 ? idx + name.length : 0);
                if (!callees.has(name)) {
                    callees.set(name, { item: makeHierarchyItem(targetProc.sym, item.uri), ranges: [] });
                }
                callees.get(name).ranges.push(range);
            }
        }

        return [...callees.values()].map(c =>
            new vscode.CallHierarchyOutgoingCall(c.item, c.ranges));
    }
}

// ============================================================================
// RenameProvider ? Rinomina simbolo (F2) su programma + copybook
// ============================================================================

class CobolRenameProvider {
    /**
     * Valida la posizione e restituisce il range del simbolo rinominabile.
     * Lancia un errore (mostrato da VS Code) se l'elemento non e' rinominabile.
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.Range}
     */
    prepareRename(document, position) {
        setLang(getLang());
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('rename.enabled', true)) {
            throw new Error(msg('renameNotRenamable'));
        }
        const line = document.lineAt(position.line).text;
        if (isComment(line)) throw new Error(msg('renameNotRenamable'));

        // Non rinominare il nome di una copybook in un'istruzione COPY
        const copyInfo = parseCopyFromLine(line);
        if (copyInfo) {
            const nameEnd = copyInfo.nameStart + copyInfo.copyName.length;
            if (position.character >= copyInfo.nameStart && position.character <= nameEnd) {
                throw new Error(msg('renameNotRenamable'));
            }
        }

        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) throw new Error(msg('renameNotRenamable'));

        const symbol = symbolIndex.findSymbol(document, wordInfo.word);
        if (!symbol) throw new Error(msg('renameNotRenamable'));

        // Simbolo definito in copybook: serve l'opt-in per modificarla
        if (symbol.filePath !== document.uri.fsPath &&
            !cfg.get('rename.includeCopybooks', false)) {
            throw new Error(msg('renameCopybookDisabled'));
        }

        return wordInfo.range;
    }

    /**
     * Costruisce le modifiche di rinomina.
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @param {string} newName
     * @returns {vscode.WorkspaceEdit | undefined}
     */
    provideRenameEdits(document, position, newName) {
        setLang(getLang());
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('rename.enabled', true)) return undefined;

        const wordInfo = getWordAtPosition(document, position);
        if (!wordInfo) return undefined;

        const symbol = symbolIndex.findSymbol(document, wordInfo.word);
        if (!symbol) return undefined;

        // Valida il nuovo nome (identificatore COBOL valido)
        const trimmed = newName.trim();
        if (!/^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/.test(trimmed)) {
            throw new Error(msg('renameInvalidName', newName));
        }
        if (trimmed.length > 30) {
            throw new Error(msg('renameTooLong'));
        }
        if (COBOL_RESERVED.has(trimmed.toUpperCase())) {
            throw new Error(msg('renameReserved', trimmed));
        }

        const searchUpper = wordInfo.word.toUpperCase();
        const edit = new vscode.WorkspaceEdit();

        // 1. Occorrenze nel documento corrente
        const docLines = document.getText().split(/\r?\n/);
        for (const occ of findWordOccurrences(docLines, searchUpper)) {
            edit.replace(document.uri,
                new vscode.Range(occ.line, occ.start, occ.line, occ.start + searchUpper.length),
                trimmed);
        }

        // 2. Se definito in copybook (e opt-in attivo), rinomina anche li'
        if (symbol.filePath !== document.uri.fsPath) {
            if (!cfg.get('rename.includeCopybooks', false)) {
                throw new Error(msg('renameCopybookDisabled'));
            }
            const copyLines = getFileLines(document, symbol.filePath);
            if (copyLines) {
                const copyUri = vscode.Uri.file(symbol.filePath);
                for (const occ of findWordOccurrences(copyLines, searchUpper)) {
                    edit.replace(copyUri,
                        new vscode.Range(occ.line, occ.start, occ.line, occ.start + searchUpper.length),
                        trimmed);
                }
            }
        }

        return edit;
    }
}

// ============================================================================
// CompletionProvider ? Completamento nomi copybook
// ============================================================================

class CobolCopyCompletionProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.CompletionItem[] | undefined}
     */
    provideCompletionItems(document, position) {
        const line = document.lineAt(position.line).text;
        const textBefore = line.substring(0, position.character).toUpperCase();

        // Attiva solo dopo "COPY " 
        if (!textBefore.match(/\bCOPY\s+\S*$/)) return undefined;

        const { fsPath: wsRoot } = getWorkspaceRoot(document);
        if (!wsRoot) return undefined;

        const config = vscode.workspace.getConfiguration('cobolLens');
        const folders = config.get('copyFolders', ['Copy', 'Copy_DR', 'Copy_Prod']);

        /** @type {Set<string>} */
        const seen = new Set();
        /** @type {vscode.CompletionItem[]} */
        const items = [];

        for (const folder of folders) {
            const folderPath = path.join(wsRoot, folder);
            if (!fs.existsSync(folderPath)) continue;

            try {
                const files = fs.readdirSync(folderPath);
                for (const file of files) {
                    // Rimuovi estensione per ottenere il nome copybook
                    const parsed = path.parse(file);
                    const copyName = parsed.name || file;

                    if (seen.has(copyName.toUpperCase())) continue;
                    seen.add(copyName.toUpperCase());

                    const item = new vscode.CompletionItem(copyName, vscode.CompletionItemKind.File);
                    item.detail = `Copybook in ${folder}/`;
                    item.insertText = copyName;
                    items.push(item);
                }
            } catch (e) {
                // Ignora errori di lettura cartella
            }
        }

        return items;
    }
}

// ============================================================================
// CompletionProvider ? Completamento simboli (variabili, paragrafi) e keyword
// ============================================================================

/**
 * Verbi e parole chiave COBOL piu' comuni, suggeriti dal completamento.
 * @type {string[]}
 */
const COBOL_KEYWORDS = [
    'ACCEPT', 'ADD', 'CALL', 'CANCEL', 'CLOSE', 'COMPUTE', 'CONTINUE',
    'DELETE', 'DISPLAY', 'DIVIDE', 'ELSE', 'END-CALL', 'END-EVALUATE',
    'END-IF', 'END-PERFORM', 'END-READ', 'END-SEARCH', 'END-STRING',
    'END-UNSTRING', 'EVALUATE', 'EXIT', 'GIVING', 'GOBACK', 'GO TO', 'IF',
    'INITIALIZE', 'INSPECT', 'MOVE', 'MULTIPLY', 'OPEN', 'PERFORM', 'READ',
    'REWRITE', 'SEARCH', 'SET', 'START', 'STOP RUN', 'STRING', 'SUBTRACT',
    'UNSTRING', 'WRITE', 'WHEN', 'UNTIL', 'VARYING', 'THRU', 'THROUGH',
    'FROM', 'TO', 'USING', 'GREATER', 'LESS', 'EQUAL', 'NOT', 'AND', 'OR',
    'PIC', 'PICTURE', 'VALUE', 'OCCURS', 'REDEFINES', 'USAGE', 'COMP',
    'COMP-3', 'BINARY', 'PACKED-DECIMAL', 'FILLER', 'COPY', 'REPLACING'
];

/**
 * Calcola il prefisso (identificatore COBOL) immediatamente prima del cursore
 * e il range da sostituire.
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{ prefix: string, range: vscode.Range }}
 */
function getCompletionPrefix(document, position) {
    const line = document.lineAt(position.line).text;
    let start = position.character;
    while (start > 0 && /[A-Za-z0-9-]/.test(line.charAt(start - 1))) start--;
    const prefix = line.substring(start, position.character);
    const range = new vscode.Range(position.line, start, position.line, position.character);
    return { prefix, range };
}

class CobolCompletionProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.CompletionItem[] | undefined}
     */
    provideCompletionItems(document, position) {
        const config = vscode.workspace.getConfiguration('cobolLens');
        if (!config.get('completion.enabled', true)) return undefined;

        const line = document.lineAt(position.line).text;
        if (isComment(line)) return undefined;

        const textBefore = line.substring(0, position.character);
        const upperBefore = textBefore.toUpperCase();

        // Non interferire con il completamento COPY (gestito dall'altro provider)
        if (/\bCOPY\s+\S*$/.test(upperBefore)) return undefined;

        const { range } = getCompletionPrefix(document, position);

        const wantVars = config.get('completion.variables', true);
        const wantParas = config.get('completion.paragraphs', true);
        const wantKw = config.get('completion.keywords', true);

        // Contesto: dopo PERFORM / GO TO / THRU si suggeriscono paragrafi e sezioni
        const afterPerform =
            /\b(PERFORM|THRU|THROUGH)\s+[A-Za-z0-9-]*$/.test(upperBefore) ||
            /\bGO\s+TO\s+[A-Za-z0-9-]*$/.test(upperBefore);

        /** @type {vscode.CompletionItem[]} */
        const items = [];
        const seen = new Set();
        const symbols = symbolIndex.getSymbols(document);

        // Paragrafi e sezioni
        if (wantParas) {
            for (const sym of symbols) {
                if (sym.type !== 'paragraph' && sym.type !== 'section') continue;
                const key = 'P:' + sym.name;
                if (seen.has(key)) continue;
                seen.add(key);
                const kind = sym.type === 'section'
                    ? vscode.CompletionItemKind.Module
                    : vscode.CompletionItemKind.Function;
                const item = new vscode.CompletionItem(sym.originalName, kind);
                item.detail = sym.type === 'section' ? 'Section' : 'Paragraph';
                item.range = range;
                if (afterPerform) item.sortText = '0_' + sym.originalName;
                items.push(item);
            }
        }

        // Variabili e keyword: non pertinenti subito dopo PERFORM/GO TO
        if (!afterPerform) {
            if (wantVars) {
                for (const sym of symbols) {
                    if (sym.type !== 'variable') continue;
                    if (sym.originalName.toUpperCase() === 'FILLER') continue;
                    const key = 'V:' + sym.name;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const item = new vscode.CompletionItem(sym.originalName, vscode.CompletionItemKind.Variable);
                    item.detail = (sym.level != null)
                        ? `Level ${String(sym.level).padStart(2, '0')}`
                        : 'Variable';
                    item.range = range;
                    item.sortText = '1_' + sym.originalName;
                    items.push(item);
                }
            }

            if (wantKw) {
                for (const kw of COBOL_KEYWORDS) {
                    const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
                    item.range = range;
                    item.sortText = 'z_' + kw; // keyword dopo i simboli
                    items.push(item);
                }
            }
        }

        return items;
    }
}

// ============================================================================
// Snippet COBOL ? completamenti a template (gated da cobolLens.snippets.enabled)
// ============================================================================

/**
 * Definizioni degli snippet COBOL (dialetto Micro Focus, formato fixed).
 * Il corpo usa la sintassi degli snippet di VS Code: ${1:placeholder}, $0 = cursore finale.
 * Le righe successive alla prima ereditano l'indentazione della riga di inserimento,
 * quindi il corpo usa indentazione RELATIVA (3 spazi per livello di annidamento).
 * @type {{ prefix: string, description: string, body: string[] }[]}
 */
const COBOL_SNIPPETS = [
    // --- Blocchi PROCEDURE DIVISION ---
    {
        prefix: 'if',
        description: 'IF ... END-IF',
        body: ['IF ${1:condition}', '   ${0}', 'END-IF']
    },
    {
        prefix: 'ifelse',
        description: 'IF ... ELSE ... END-IF',
        body: ['IF ${1:condition}', '   ${2}', 'ELSE', '   ${0}', 'END-IF']
    },
    {
        prefix: 'evaluate',
        description: 'EVALUATE ... WHEN ... END-EVALUATE',
        body: [
            'EVALUATE ${1:subject}',
            'WHEN ${2:value}',
            '   ${3}',
            'WHEN OTHER',
            '   ${0}',
            'END-EVALUATE'
        ]
    },
    {
        prefix: 'performuntil',
        description: 'PERFORM UNTIL ... END-PERFORM',
        body: ['PERFORM UNTIL ${1:condition}', '   ${0}', 'END-PERFORM']
    },
    {
        prefix: 'performvarying',
        description: 'PERFORM VARYING ... UNTIL ... END-PERFORM',
        body: [
            'PERFORM VARYING ${1:WS-I} FROM ${2:1} BY ${3:1}',
            '        UNTIL ${1:WS-I} > ${4:WS-MAX}',
            '   ${0}',
            'END-PERFORM'
        ]
    },
    {
        prefix: 'performtimes',
        description: 'PERFORM n TIMES ... END-PERFORM',
        body: ['PERFORM ${1:WS-N} TIMES', '   ${0}', 'END-PERFORM']
    },
    {
        prefix: 'performthru',
        description: 'PERFORM paragraph THRU paragraph',
        body: ['PERFORM ${1:FIRST-PARA} THRU ${2:LAST-PARA}${0}']
    },
    {
        prefix: 'call',
        description: 'CALL "program" USING ... END-CALL',
        body: ['CALL "${1:PROGRAM}" USING ${2:WS-PARM}', 'END-CALL${0}']
    },
    {
        prefix: 'read',
        description: 'READ file ... END-READ',
        body: [
            'READ ${1:FILE-NAME}',
            '   AT END',
            '      ${2}',
            '   NOT AT END',
            '      ${0}',
            'END-READ'
        ]
    },
    {
        prefix: 'string',
        description: 'STRING ... END-STRING',
        body: [
            'STRING ${1:WS-A} DELIMITED BY ${2:SPACE}',
            '   INTO ${3:WS-RESULT}',
            'END-STRING${0}'
        ]
    },
    {
        prefix: 'unstring',
        description: 'UNSTRING ... END-UNSTRING',
        body: [
            'UNSTRING ${1:WS-SOURCE} DELIMITED BY ${2:SPACE}',
            '   INTO ${3:WS-A} ${4:WS-B}',
            'END-UNSTRING${0}'
        ]
    },
    // --- Voci DATA DIVISION e PICTURE parametriche ---
    {
        prefix: 'group',
        description: 'Group item: 01 name.',
        body: ['01  ${1:WS-GROUP}.', '    05  ${0}']
    },
    {
        prefix: 'picx',
        description: 'PIC X(n) alphanumeric',
        body: ['${1:05}  ${2:WS-FIELD}            PIC X(${3:10}).${0}']
    },
    {
        prefix: 'pic9',
        description: 'PIC 9(n) numeric',
        body: ['${1:05}  ${2:WS-FIELD}            PIC 9(${3:5}).${0}']
    },
    {
        prefix: 'pics9',
        description: 'PIC S9(n) signed numeric',
        body: ['${1:05}  ${2:WS-FIELD}            PIC S9(${3:5}).${0}']
    },
    {
        prefix: 'comp3',
        description: 'PIC S9(n) COMP-3 (packed-decimal)',
        body: ['${1:05}  ${2:WS-FIELD}            PIC S9(${3:7})V9(${4:2}) COMP-3.${0}']
    },
    {
        prefix: 'comp',
        description: 'PIC S9(n) COMP (binary)',
        body: ['${1:05}  ${2:WS-FIELD}            PIC S9(${3:4}) COMP.${0}']
    },
    {
        prefix: 'value',
        description: 'Item with VALUE clause',
        body: ['${1:05}  ${2:WS-FIELD}            PIC ${3:X(10)} VALUE ${4:SPACES}.${0}']
    },
    {
        prefix: 'level88',
        description: '88 condition-name VALUE',
        body: ['88  ${1:CN-NAME}             VALUE ${2:"Y"}.${0}']
    },
    {
        prefix: 'occurs',
        description: 'Table item with OCCURS',
        body: ['${1:05}  ${2:WS-ITEM}             PIC ${3:X(10)} OCCURS ${4:10} TIMES.${0}']
    },
    // --- Strutture e scheletro programma ---
    {
        prefix: 'select',
        description: 'SELECT ... ASSIGN ... (FILE-CONTROL)',
        body: [
            'SELECT ${1:FILE-NAME} ASSIGN TO ${2:EXTERNAL-NAME}',
            '   ORGANIZATION IS ${3:SEQUENTIAL}',
            '   FILE STATUS IS ${4:FS-FILE}.${0}'
        ]
    },
    {
        prefix: 'fd',
        description: 'FD file description',
        body: ['FD  ${1:FILE-NAME}.', '01  ${2:FILE-REC}.', '    05  ${0}']
    },
    {
        prefix: 'paragraph',
        description: 'Paragraph with EXIT',
        body: ['${1:PARA-NAME}.', '    ${0}', '    .']
    },
    {
        prefix: 'program',
        description: 'Full program skeleton (invoke at column 1)',
        body: [
            'IDENTIFICATION DIVISION.',
            'PROGRAM-ID. ${1:PROGNAME}.',
            'ENVIRONMENT DIVISION.',
            'DATA DIVISION.',
            'WORKING-STORAGE SECTION.',
            '01  WS-VARS.',
            '    05  ${2:WS-FIELD}            PIC X(10).',
            'PROCEDURE DIVISION.',
            'MAIN-PARA.',
            '    ${0}',
            '    GOBACK.'
        ]
    }
];

class CobolSnippetCompletionProvider {
    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @returns {vscode.CompletionItem[] | undefined}
     */
    provideCompletionItems(document, position) {
        const config = vscode.workspace.getConfiguration('cobolLens');
        if (!config.get('snippets.enabled', true)) return undefined;

        const line = document.lineAt(position.line).text;
        if (isComment(line)) return undefined;

        const textBefore = line.substring(0, position.character);
        // Non interferire con il completamento COPY
        if (/\bCOPY\s+\S*$/i.test(textBefore)) return undefined;

        const { range } = getCompletionPrefix(document, position);

        /** @type {vscode.CompletionItem[]} */
        const items = [];
        for (const sn of COBOL_SNIPPETS) {
            const item = new vscode.CompletionItem(sn.prefix, vscode.CompletionItemKind.Snippet);
            item.detail = sn.description;
            item.documentation = new vscode.MarkdownString(
                '```cobol\n' + sn.body.join('\n').replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$0/g, '') + '\n```'
            );
            item.insertText = new vscode.SnippetString(sn.body.join('\n'));
            item.range = range;
            item.filterText = sn.prefix;
            item.sortText = 's_' + sn.prefix;
            items.push(item);
        }
        return items;
    }
}

// ============================================================================
// FoldingRangeProvider ? Code Folding per DIVISION, SECTION, paragrafi
// ============================================================================

class CobolFoldingProvider {
    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.FoldingRange[]}
     */
    provideFoldingRanges(document) {
        /** @type {vscode.FoldingRange[]} */
        const ranges = [];
        /** @type {{ line: number, type: string }[]} */
        const stack = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (isComment(line) || !line.trim()) continue;

            const upper = line.toUpperCase();

            // DIVISION
            if (upper.match(/\b(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION/)) {
                if (stack.length > 0) {
                    const prev = stack.pop();
                    if (prev && i - 1 > prev.line) {
                        ranges.push(new vscode.FoldingRange(prev.line, i - 1, vscode.FoldingRangeKind.Region));
                    }
                }
                // Chiudi anche sezioni/paragrafi precedenti
                while (stack.length > 0) {
                    const s = stack.pop();
                    if (s && i - 1 > s.line) {
                        ranges.push(new vscode.FoldingRange(s.line, i - 1, vscode.FoldingRangeKind.Region));
                    }
                }
                stack.push({ line: i, type: 'division' });
                continue;
            }

            // SECTION nella PROCEDURE DIVISION
            if (upper.match(/^\s{0,10}[A-Za-z][A-Za-z0-9-]+\s+SECTION\s*\./)) {
                // Chiudi paragrafo o sezione precedente
                while (stack.length > 0 && stack[stack.length - 1].type !== 'division') {
                    const prev = stack.pop();
                    if (prev && i - 1 > prev.line) {
                        ranges.push(new vscode.FoldingRange(prev.line, i - 1, vscode.FoldingRangeKind.Region));
                    }
                }
                stack.push({ line: i, type: 'section' });
                continue;
            }

            // Paragrafo (nome seguito da punto solo, in area A)
            if (upper.match(/^[\s\d]{0,6}\s{1,4}[A-Z][A-Z0-9-]+\s*\.\s*$/) && !upper.includes('SECTION')) {
                // Chiudi paragrafo precedente
                if (stack.length > 0 && stack[stack.length - 1].type === 'paragraph') {
                    const prev = stack.pop();
                    if (prev && i - 1 > prev.line) {
                        ranges.push(new vscode.FoldingRange(prev.line, i - 1, vscode.FoldingRangeKind.Region));
                    }
                }
                stack.push({ line: i, type: 'paragraph' });
                continue;
            }
        }

        // Chiudi tutti i blocchi rimasti
        const lastLine = document.lineCount - 1;
        while (stack.length > 0) {
            const s = stack.pop();
            if (s && lastLine > s.line) {
                ranges.push(new vscode.FoldingRange(s.line, lastLine, vscode.FoldingRangeKind.Region));
            }
        }

        return ranges;
    }
}

// ============================================================================
// InlayHintsProvider - offset e dimensione dei campi della DATA DIVISION
// ============================================================================

class CobolInlayHintsProvider {
    constructor() {
        /** @type {vscode.EventEmitter<void>} */
        this._onDidChangeInlayHints = new vscode.EventEmitter();
        /** Evento per richiedere a VS Code di rigenerare gli inlay hint. */
        this.onDidChangeInlayHints = this._onDidChangeInlayHints.event;
    }

    /** Notifica VS Code che gli inlay hint vanno ricalcolati (es. cambio setting). */
    refresh() {
        this._onDidChangeInlayHints.fire();
    }

    /**
     * Posizione 0-based del carattere dove agganciare l'inlay hint: subito dopo
     * il codice (entro la colonna 72), prima dell'eventuale area sequenza (73+).
     * @param {vscode.TextDocument} document
     * @param {number} line
     * @returns {vscode.Position}
     */
    _anchor(document, line) {
        const text = document.lineAt(line).text;
        const codeArea = text.length > 72 ? text.substring(0, 72) : text;
        const ch = codeArea.replace(/\s+$/, '').length;
        return new vscode.Position(line, ch);
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Range} range
     * @returns {vscode.InlayHint[]}
     */
    provideInlayHints(document, range) {
        const cfg = vscode.workspace.getConfiguration('cobolLens');
        if (!cfg.get('inlayHints.enabled', true)) return [];
        if (cfg.get('inlayHints.display', 'inline') !== 'inline') return [];

        setLang(getLang());
        const lines = document.getText().split(/\r?\n/);
        const { fsPath: wsRoot } = getWorkspaceRoot(document);

        /** @type {vscode.InlayHint[]} */
        const hints = [];
        const layout = collectLayout(lines, wsRoot);
        for (const item of layout) {
            if (item.fromCopy) continue;          // solo il file principale
            if (item.size <= 0) continue;         // salta 88/66 e dimensioni ignote
            if (item.startLine < range.start.line || item.startLine > range.end.line) continue;

            const label = msg('inlayPosSize', item.offset + 1, item.size);
            const hint = new vscode.InlayHint(this._anchor(document, item.startLine), label);
            hint.paddingLeft = true;
            hints.push(hint);
        }
        return hints;
    }
}

// ============================================================================
// Record Layout view (tabella offset/dimensione dei record della DATA DIVISION)
// ============================================================================

/** @type {vscode.WebviewPanel | undefined} Pannello singleton riutilizzato. */
let recordLayoutPanel;

/**
 * Esegue l'escape dei caratteri speciali HTML.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Costruisce il corpo HTML della tabella di layout a partire dagli item.
 * Raggruppa per record radice (depth 0: livelli 01/77).
 * @param {import('./cobol-layout').LayoutItem[]} layout
 * @returns {string}
 */
function buildRecordLayoutHtml(layout) {
    // Considera solo gli item del file principale (no copybook espanse a parte:
    // gli item fromCopy hanno comunque offset/size validi, quindi li includiamo
    // per dare il quadro completo del record).
    const items = layout;
    if (items.length === 0) {
        return `<p class="empty">${escapeHtml(msg('recordLayoutEmpty'))}</p>`;
    }

    let html = '';
    let i = 0;
    while (i < items.length) {
        const root = items[i];
        // Un record inizia a depth 0; raccoglie tutti gli item fino al prossimo depth 0.
        let j = i + 1;
        while (j < items.length && items[j].depth > 0) j++;
        const group = items.slice(i, j);
        i = j;

        const totalSize = root.size;
        html += `<h2>${escapeHtml(root.name)} `
            + `<span class="recsize">(${escapeHtml(String(root.level).padStart(2, '0'))}, `
            + `${totalSize} ${escapeHtml(msg('recordLayoutByteUnit'))})</span></h2>`;
        html += '<table>'
            + '<thead><tr>'
            + `<th>${escapeHtml(msg('recordLayoutColLevel'))}</th>`
            + `<th>${escapeHtml(msg('recordLayoutColName'))}</th>`
            + `<th class="num">${escapeHtml(msg('recordLayoutColStart'))}</th>`
            + `<th class="num">${escapeHtml(msg('recordLayoutColEnd'))}</th>`
            + `<th class="num">${escapeHtml(msg('recordLayoutColSize'))}</th>`
            + `<th>${escapeHtml(msg('recordLayoutColNotes'))}</th>`
            + '</tr></thead><tbody>';

        for (const it of group) {
            const indent = '&nbsp;'.repeat(it.depth * 4);
            const start = it.offset + 1;
            const end = it.size > 0 ? it.offset + it.size : start;
            const notes = [];
            if (it.isGroup) notes.push(msg('recordLayoutNoteGroup'));
            if (it.redefines) notes.push(msg('recordLayoutNoteRedefines'));
            if (it.occurs > 1) notes.push(`OCCURS ${it.occurs}`);
            if (it.fromCopy) notes.push(msg('recordLayoutNoteCopy'));
            if (it.size <= 0) notes.push(msg('recordLayoutNoteNoStorage'));

            const rowClass = it.isGroup ? ' class="group"' : '';
            html += `<tr${rowClass}>`
                + `<td>${escapeHtml(String(it.level).padStart(2, '0'))}</td>`
                + `<td>${indent}${escapeHtml(it.name)}</td>`
                + `<td class="num">${it.size > 0 ? start : ''}</td>`
                + `<td class="num">${it.size > 0 ? end : ''}</td>`
                + `<td class="num">${it.size > 0 ? it.size : ''}</td>`
                + `<td class="notes">${escapeHtml(notes.join(', '))}</td>`
                + '</tr>';
        }
        html += '</tbody></table>';
    }
    return html;
}

/**
 * Genera l'HTML completo della webview del record layout.
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function recordLayoutWebviewHtml(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px; }
    h1 { font-size: 1.2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
    h2 { font-size: 1.05em; margin-top: 20px; }
    .recsize { font-weight: normal; color: var(--vscode-descriptionForeground); }
    table { border-collapse: collapse; width: 100%; margin-top: 6px; }
    th, td { text-align: left; padding: 3px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.notes { color: var(--vscode-descriptionForeground); }
    tr.group td { font-weight: 600; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
    code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}

/**
 * Comando: mostra la tabella di layout (offset/dimensione) dei record della
 * DATA DIVISION del documento COBOL attivo in una webview.
 */
function showRecordLayout() {
    setLang(getLang());
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isCobolDocument(editor.document)) {
        vscode.window.showInformationMessage(msg('recordLayoutNoCobol'));
        return;
    }

    const document = editor.document;
    const lines = document.getText().split(/\r?\n/);
    const { fsPath: wsRoot } = getWorkspaceRoot(document);
    const layout = collectLayout(lines, wsRoot);

    const title = `${msg('recordLayoutTitle')} - ${path.basename(document.fileName)}`;
    const body = buildRecordLayoutHtml(layout);

    if (recordLayoutPanel) {
        recordLayoutPanel.title = msg('recordLayoutTitle');
        recordLayoutPanel.webview.html = recordLayoutWebviewHtml(title, body);
        recordLayoutPanel.reveal(vscode.ViewColumn.Beside, true);
        return;
    }

    recordLayoutPanel = vscode.window.createWebviewPanel(
        'cobolLensRecordLayout',
        msg('recordLayoutTitle'),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false }
    );
    recordLayoutPanel.webview.html = recordLayoutWebviewHtml(title, body);
    recordLayoutPanel.onDidDispose(() => { recordLayoutPanel = undefined; });
}

// ============================================================================
// IF/ELSE/END-IF Block Highlighting
// ============================================================================

/**
 * Colori per i livelli di nesting IF (ciclici).
 * Stile simile a bracket pair colorization.
 */
const IF_BLOCK_COLORS = [
    { color: '#FFD700', border: 'rgba(255, 215, 0, 0.60)' },   // gold
    { color: '#DA70D6', border: 'rgba(218, 112, 214, 0.60)' }, // orchid
    { color: '#87CEEB', border: 'rgba(135, 206, 235, 0.60)' }, // skyblue
    { color: '#98FB98', border: 'rgba(152, 251, 152, 0.60)' }, // palegreen
    { color: '#FFA07A', border: 'rgba(255, 160, 122, 0.60)' }, // lightsalmon
    { color: '#00CED1', border: 'rgba(0, 206, 209, 0.60)' },   // darkturquoise
    { color: '#9370DB', border: 'rgba(147, 112, 219, 0.60)' }, // mediumpurple
    { color: '#FF6B6B', border: 'rgba(255, 107, 107, 0.60)' }, // coral
    { color: '#00FA9A', border: 'rgba(0, 250, 154, 0.60)' },   // mediumspringgreen
];

/**
 * Decoration types per il bordo delle keyword IF/ELSE/END-IF per ogni livello.
 * Non modifica il colore del font ? usa solo un bordo attorno alla keyword.
 */
const ifKeywordDecoTypes = IF_BLOCK_COLORS.map(c =>
    vscode.window.createTextEditorDecorationType({
        border: `1px solid ${c.color}`,
        borderRadius: '2px'
    })
);

/** Decoration types per la barra di scope per livello.
 *  La barra e' una linea verticale ancorata alla colonna della keyword IF
 *  del blocco (come una guida di indentazione "a parentesi"), cosi' ogni
 *  livello di nesting ha la propria linea sfalsata verso destra.
 *  E' disegnata come elemento ::before posizionato in modo assoluto (non come
 *  semplice bordo della cella) cosi' resta SEMPRE sopra le guide di
 *  indentazione native, compresa la guida attiva evidenziata in bianco: un
 *  border-left verrebbe invece coperto quando cade sulla stessa colonna. */
const ifScopeBarDecoTypes = IF_BLOCK_COLORS.map(c =>
    vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '\u00a0',
            // CSS iniettato via `textDecoration`: posiziona la barra in assoluto
            // e la porta in primo piano con z-index.
            textDecoration: `none; position: absolute; z-index: 1; height: 100%; border-left: 1px solid ${c.color}; pointer-events: none;`
        }
    })
);

/**
 * @typedef {Object} IfBlock
 * @property {number} ifLine - Riga della keyword IF
 * @property {number} ifCol - Colonna iniziale della keyword IF
 * @property {number} ifLen - Lunghezza della keyword IF
 * @property {number} [elseLine] - Riga della keyword ELSE (se presente)
 * @property {number} [elseCol] - Colonna iniziale della keyword ELSE
 * @property {number} [elseLen] - Lunghezza della keyword ELSE
 * @property {number} endLine - Riga della keyword END-IF o del punto terminatore
 * @property {number} endCol - Colonna iniziale della keyword END-IF (-1 se chiuso da punto/EOF)
 * @property {number} endLen - Lunghezza della keyword END-IF
 * @property {number} level - Livello di nesting (0-based)
 * @property {'end-if'|'period'|'eof'|'implicit'} [closedBy] - Come il blocco e' stato chiuso
 */

/**
 * Parsa il documento per trovare tutti i blocchi IF/ELSE/END-IF con livello di nesting.
 * @param {vscode.TextDocument} document
 * @returns {IfBlock[]}
 */
function parseIfBlocks(document) {
    /** @type {IfBlock[]} */
    const blocks = [];
    /** @type {{ line: number, col: number, len: number, level: number }[]} */
    const stack = [];

    for (let i = 0; i < document.lineCount; i++) {
        const lineText = document.lineAt(i).text;
        if (isComment(lineText)) continue;

        const upper = lineText.toUpperCase();
        // Maschera i letterali stringa sostituendoli con spazi della stessa lunghezza,
        // così le keyword dentro virgolette non vengono riconosciute ma le posizioni restano corrette.
        const masked = upper.replace(/'[^']*'/g, m => ' '.repeat(m.length))
                            .replace(/"[^"]*"/g, m => ' '.repeat(m.length));

        // Cerca END-IF prima di IF per evitare match su "END-IF" come "IF"
        const endIfRegex = /\bEND-IF\b/g;
        let endIfMatch;
        /** @type {Set<number>} */
        const endIfPositions = new Set();
        while ((endIfMatch = endIfRegex.exec(masked)) !== null) {
            endIfPositions.add(endIfMatch.index);
            // Chiudi il blocco IF piu' recente sullo stack
            if (stack.length > 0) {
                const opened = stack.pop();
                // Cerca la entry nel blocks per questo IF
                const block = blocks.find(b => b.ifLine === opened.line && b.ifCol === opened.col);
                if (block) {
                    block.endLine = i;
                    block.endCol = endIfMatch.index;
                    block.endLen = 6; // "END-IF"
                    block.closedBy = 'end-if';
                }
            }
        }

        // Cerca ELSE (non END-IF, non parte di un nome)
        const elseRegex = /\bELSE\b/g;
        let elseMatch;
        while ((elseMatch = elseRegex.exec(masked)) !== null) {
            // Ignora se fa parte di un END-xxx
            if (masked.substring(Math.max(0, elseMatch.index - 4), elseMatch.index) === 'END-') continue;
            // In COBOL un ELSE si appaia con l'IF piu' interno che non ha ancora un ELSE.
            // Se il blocco in cima allo stack ha gia' un ELSE significa che e' completo
            // (manca un END-IF esplicito): lo chiudiamo implicitamente alla riga precedente
            // e risaliamo verso il blocco esterno.
            while (stack.length > 0) {
                const top = stack[stack.length - 1];
                const topBlock = blocks.find(b => b.ifLine === top.line && b.ifCol === top.col);
                if (topBlock && topBlock.elseLine !== undefined) {
                    stack.pop();
                    topBlock.endLine = Math.max(topBlock.elseLine, i - 1);
                    topBlock.endCol = -1;
                    topBlock.endLen = 0;
                    topBlock.closedBy = 'implicit';
                } else {
                    break;
                }
            }
            // Associa al blocco IF corrente sullo stack
            if (stack.length > 0) {
                const current = stack[stack.length - 1];
                const block = blocks.find(b => b.ifLine === current.line && b.ifCol === current.col);
                if (block && block.elseLine === undefined) {
                    block.elseLine = i;
                    block.elseCol = elseMatch.index;
                    block.elseLen = 4; // "ELSE"
                }
            }
        }

        // Cerca IF (escludendo le posizioni che sono "END-IF")
        const ifRegex = /\bIF\b/g;
        let ifMatch;
        while ((ifMatch = ifRegex.exec(masked)) !== null) {
            // Verifica che non sia parte di END-IF
            if (ifMatch.index >= 4 && masked.substring(ifMatch.index - 4, ifMatch.index) === 'END-') continue;
            // Verifica che non sia parte di un nome piu' lungo (es: IF-CONDITION)
            const afterEnd = ifMatch.index + 2;
            if (afterEnd < masked.length && /[A-Z0-9-]/.test(masked.charAt(afterEnd))) continue;
            const beforeStart = ifMatch.index - 1;
            if (beforeStart >= 0 && /[A-Z0-9-]/.test(masked.charAt(beforeStart))) continue;

            const level = stack.length;
            stack.push({ line: i, col: ifMatch.index, len: 2, level });
            blocks.push({
                ifLine: i,
                ifCol: ifMatch.index,
                ifLen: 2,
                endLine: -1,
                endCol: 0,
                endLen: 6,
                level
            });
        }

        // Un punto chiude tutti gli scope aperti (come nel linter)
        if (masked.includes('.')) {
            // Chiudi tutti i blocchi rimasti aperti
            while (stack.length > 0) {
                const opened = stack.pop();
                const block = blocks.find(b => b.ifLine === opened.line && b.ifCol === opened.col);
                if (block) {
                    block.endLine = i;
                    block.endCol = -1; // chiuso da punto, non da END-IF
                    block.endLen = 0;
                    block.closedBy = 'period';
                }
            }
        }
    }

    // Chiudi eventuali blocchi rimasti aperti (fine file)
    while (stack.length > 0) {
        const opened = stack.pop();
        const block = blocks.find(b => b.ifLine === opened.line && b.ifCol === opened.col);
        if (block) {
            block.endLine = document.lineCount - 1;
            block.endCol = -1;
            block.endLen = 0;
            block.closedBy = 'eof';
        }
    }

    // Includi blocchi chiusi da END-IF, da punto e implicitamente (escludi solo EOF)
    return blocks.filter(b => b.closedBy === 'end-if' || b.closedBy === 'period' || b.closedBy === 'implicit');
}

/**
 * Applica le decorazioni colorate per keyword IF/ELSE/END-IF e barre di scope.
 * @param {vscode.TextEditor} editor
 */
function applyIfBlockDecorations(editor) {
    if (!editor || !isCobolDocument(editor.document)) {
        for (const dt of ifKeywordDecoTypes) editor?.setDecorations(dt, []);
        for (const dt of ifScopeBarDecoTypes) editor?.setDecorations(dt, []);
        return;
    }

    const config = vscode.workspace.getConfiguration('cobolLens');
    if (!config.get('ifBlockHighlight.enabled', true)) {
        for (const dt of ifKeywordDecoTypes) editor.setDecorations(dt, []);
        for (const dt of ifScopeBarDecoTypes) editor.setDecorations(dt, []);
        return;
    }

    const blocks = parseIfBlocks(editor.document);
    const numColors = IF_BLOCK_COLORS.length;
    const cursorLine = editor.selection.active.line;
    const showScopeBars = config.get('ifBlockHighlight.scopeBars', true);

    // Scope bars: linea verticale ancorata alla colonna della keyword IF,
    // visibile SOLO per i blocchi che contengono la riga del cursore (cosi'
    // come i riquadri delle keyword). Se il cursore e' annidato in profondita',
    // vengono mostrate le barre di tutti i blocchi che lo contengono.
    /** @type {vscode.DecorationOptions[][]} */
    const scopeBarsByLevel = Array.from({ length: numColors }, () => []);
    if (showScopeBars) {
        for (const block of blocks) {
            if (cursorLine < block.ifLine || cursorLine > block.endLine) continue;
            const colorIdx = block.level % numColors;
            const col = block.ifCol;
            for (let line = block.ifLine; line <= block.endLine; line++) {
                // La barra si appoggia alla colonna `col`: se la riga e' piu'
                // corta la salto per evitare disallineamenti.
                if (editor.document.lineAt(line).text.length < col) continue;
                scopeBarsByLevel[colorIdx].push({
                    range: new vscode.Range(line, col, line, col)
                });
            }
        }
    }
    for (let i = 0; i < numColors; i++) {
        editor.setDecorations(ifScopeBarDecoTypes[i], scopeBarsByLevel[i]);
    }

    // Keyword borders ? solo per il blocco il cui IF/ELSE/END-IF e' sulla riga del cursore
    /** @type {vscode.DecorationOptions[][]} */
    const keywordsByLevel = Array.from({ length: numColors }, () => []);
    for (const block of blocks) {
        const isOnIf    = cursorLine === block.ifLine;
        const isOnElse  = block.elseLine !== undefined && cursorLine === block.elseLine;
        const isOnEnd   = cursorLine === block.endLine;
        if (!isOnIf && !isOnElse && !isOnEnd) continue;

        const colorIdx = block.level % numColors;
        keywordsByLevel[colorIdx].push({
            range: new vscode.Range(block.ifLine, block.ifCol, block.ifLine, block.ifCol + block.ifLen)
        });
        if (block.elseLine !== undefined) {
            keywordsByLevel[colorIdx].push({
                range: new vscode.Range(block.elseLine, block.elseCol, block.elseLine, block.elseCol + block.elseLen)
            });
        }
        // Evidenzia END-IF solo se il blocco e' chiuso da END-IF esplicito
        if (block.closedBy === 'end-if') {
            keywordsByLevel[colorIdx].push({
                range: new vscode.Range(block.endLine, block.endCol, block.endLine, block.endCol + block.endLen)
            });
        }
        break; // un solo blocco attivo alla volta
    }
    for (let i = 0; i < numColors; i++) {
        editor.setDecorations(ifKeywordDecoTypes[i], keywordsByLevel[i]);
    }
}

/** Timer per debounce decorazioni IF */
let ifDecoTimer;

/**
 * Schedula l'aggiornamento delle decorazioni IF con debounce.
 */
function scheduleIfBlockUpdate() {
    if (ifDecoTimer) clearTimeout(ifDecoTimer);
    ifDecoTimer = setTimeout(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) applyIfBlockDecorations(editor);
    }, 100);
}

// ============================================================================
// Diagnostica ? Linter integrato + warning copybook mancanti
// ============================================================================

/** @type {vscode.DiagnosticCollection} */
let diagnosticCollection;

/** @type {Map<string, NodeJS.Timeout>} Timer per debounce per-documento */
const lintTimers = new Map();

/**
 * Verifica se un documento e' un file COBOL.
 * @param {vscode.TextDocument} document
 * @returns {boolean}
 */
function isCobolDocument(document) {
    const ext = path.extname(document.fileName).toUpperCase();
    if (['.CBL', '.CLT'].includes(ext)) return true;
    if (document.languageId === 'cobol' || document.languageId === 'COBOL') return true;
    return false;
}

/**
 * Aggiorna la diagnostica completa per un documento (linter + copy mancanti).
 * @param {vscode.TextDocument} document
 */
function updateDiagnostics(document) {
    if (!diagnosticCollection) return;
    if (!isCobolDocument(document)) return;

    const { fsPath: workspaceRoot } = getWorkspaceRoot(document);

    // Esegue il linter integrato (include gia' il check mismatched-copy)
    const diagnostics = runLinter(document.getText(), workspaceRoot);

    diagnosticCollection.set(document.uri, diagnostics);
}

/**
 * Aggiorna la diagnostica con debounce (per onDidChangeTextDocument).
 * @param {vscode.TextDocument} document
 */
function scheduleLint(document) {
    if (!isCobolDocument(document)) return;

    const config = vscode.workspace.getConfiguration('cobolLens.linter');
    if (!config.get('enabled', true)) return;
    if (!config.get('onType', true)) return;

    const key = document.uri.toString();
    const existing = lintTimers.get(key);
    if (existing) clearTimeout(existing);

    const delay = config.get('delay', 500);
    const timer = setTimeout(() => {
        lintTimers.delete(key);
        updateDiagnostics(document);
    }, delay);
    lintTimers.set(key, timer);
}

// ============================================================================
// Attivazione
// ============================================================================

const COBOL_SELECTOR = [
    { language: 'cobol' },
    { language: 'COBOL' },
    { scheme: 'file', pattern: '**/*.CBL' },
    { scheme: 'file', pattern: '**/*.cbl' },
    { scheme: 'file', pattern: '**/*.clt' },
    { scheme: 'file', pattern: '**/*.CLT' }
];

/**
 * Registrazione corrente del provider di semantic token (se attivo).
 * @type {vscode.Disposable | undefined}
 */
let semanticTokensRegistration;

/**
 * Registra o rimuove il provider di colorazione semantica in base al setting
 * 'cobolLens.syntaxHighlighting.enabled'. La grammatica TextMate di base resta
 * sempre attiva; questo controlla solo il layer semantico aggiuntivo.
 */
function updateSemanticTokensRegistration() {
    const enabled = vscode.workspace
        .getConfiguration('cobolLens')
        .get('syntaxHighlighting.enabled', true);

    if (enabled && !semanticTokensRegistration) {
        semanticTokensRegistration = vscode.languages.registerDocumentSemanticTokensProvider(
            COBOL_SELECTOR,
            new CobolSemanticTokensProvider(symbolIndex),
            SEMANTIC_LEGEND
        );
    } else if (!enabled && semanticTokensRegistration) {
        semanticTokensRegistration.dispose();
        semanticTokensRegistration = undefined;
    }
}

/**
 * Aggiorna i righelli di colonna per il linguaggio COBOL in base al setting
 * 'cobolLens.sourceFormat'. I righelli a colonna 6 e 7 sono forniti dai
 * configurationDefaults (sempre attivi); qui aggiungiamo il righello a colonna
 * 72/73 solo quando il formato sorgente e' 'fixed' (dove la colonna 72 e' il
 * confine dell'area codice), altrimenti rimuoviamo l'override e torniamo al
 * default [6, 7].
 */
function updateSourceFormatRulers() {
    const fmt = vscode.workspace
        .getConfiguration('cobolLens')
        .get('sourceFormat', 'fixed');
    const editorCfg = vscode.workspace.getConfiguration('editor', { languageId: 'cobol' });
    const target = vscode.ConfigurationTarget.Global;
    if (fmt === 'fixed') {
        editorCfg.update('rulers', [6, 7, 72], target, true);
    } else {
        // Variable / free: rimuovi l'override e torna ai righelli di default [6, 7].
        editorCfg.update('rulers', undefined, target, true);
    }
}

/**
 * Applica una lista di TextEdit all'editor in un'unica operazione.
 * @param {vscode.TextEditor} editor
 * @param {vscode.TextEdit[]} edits
 */
async function applyTextEdits(editor, edits) {
    if (!edits || edits.length === 0) return;
    await editor.edit(builder => {
        for (const e of edits) builder.replace(e.range, e.newText);
    });
}

/**
 * Determina il formato sorgente del documento: il setting cobolLens.sourceFormat,
 * eventualmente sovrascritto da una direttiva $SET SOURCEFORMAT(VARIABLE|FREE)
 * nelle prime 20 righe.
 * @param {vscode.TextDocument} document
 * @returns {'fixed'|'variable'|'free'}
 */
function getDocumentSourceFormat(document) {
    const limit = Math.min(document.lineCount, 20);
    for (let i = 0; i < limit; i++) {
        const m = document.lineAt(i).text.match(/\$SET\s+SOURCEFORMAT\s*\(\s*(VARIABLE|FREE)\s*\)/i);
        if (m) return m[1].toUpperCase() === 'FREE' ? 'free' : 'variable';
    }
    const fmt = vscode.workspace.getConfiguration('cobolLens').get('sourceFormat', 'fixed');
    return (fmt === 'variable' || fmt === 'free') ? fmt : 'fixed';
}

/**
 * Commenta/scommenta le righe coperte dalle selezioni dell'editor (o la riga
 * del cursore se la selezione e' vuota). In formato fixed il commento e'
 * l'asterisco in colonna 7; in variable/free e' l'inline comment *>.
 * Se tutte le righe non vuote sono gia' commentate, le scommenta; altrimenti
 * le commenta.
 * @param {vscode.TextEditor} editor
 */
async function toggleCobolComment(editor) {
    const document = editor.document;
    const fixed = getDocumentSourceFormat(document) === 'fixed';

    // Raccoglie i numeri di riga unici coperti dalle selezioni.
    /** @type {Set<number>} */
    const lineSet = new Set();
    for (const sel of editor.selections) {
        let end = sel.end.line;
        // Se la selezione termina all'inizio di una riga (carattere 0) e copre
        // piu' righe, non includere l'ultima riga (convenzione VS Code).
        if (end > sel.start.line && sel.end.character === 0) end--;
        for (let ln = sel.start.line; ln <= end; ln++) lineSet.add(ln);
    }
    const lines = [...lineSet].sort((a, b) => a - b);

    const isCommented = fixed
        ? (text) => text.length >= 7 && text[6] === '*'
        : (text) => /^\s*\*>/.test(text);

    const nonBlank = lines.filter(ln => document.lineAt(ln).text.trim() !== '');
    if (nonBlank.length === 0) return;
    const doUncomment = nonBlank.every(ln => isCommented(document.lineAt(ln).text));

    await editor.edit(builder => {
        for (const ln of nonBlank) {
            const lineObj = document.lineAt(ln);
            const text = lineObj.text;
            let newText;
            if (fixed) {
                if (doUncomment) {
                    if (text.length >= 7 && text[6] === '*') {
                        newText = text.substring(0, 6) + ' ' + text.substring(7);
                    } else {
                        continue;
                    }
                } else {
                    newText = text.length >= 7
                        ? text.substring(0, 6) + '*' + text.substring(7)
                        : text.padEnd(6, ' ') + '*';
                }
            } else {
                if (doUncomment) {
                    newText = text.replace(/^(\s*)\*>\s?/, '$1');
                } else {
                    const m = text.match(/^(\s*)([\s\S]*)$/);
                    newText = (m ? m[1] : '') + '*> ' + (m ? m[2] : text);
                }
            }
            if (newText !== text) {
                builder.replace(lineObj.range, newText);
            }
        }
    });
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('COBOL Lens attivato');

    // Diagnostica (linter + copybook mancanti)
    diagnosticCollection = vscode.languages.createDiagnosticCollection('cobol-lens');
    context.subscriptions.push(diagnosticCollection);

    // Registra tutti i provider
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(COBOL_SELECTOR, new CobolDefinitionProvider()),
        vscode.languages.registerReferenceProvider(COBOL_SELECTOR, new CobolReferenceProvider()),
        vscode.languages.registerDocumentHighlightProvider(COBOL_SELECTOR, new CobolDocumentHighlightProvider()),
        vscode.languages.registerSignatureHelpProvider(COBOL_SELECTOR, new CobolSignatureHelpProvider(), '(', ','),
        vscode.languages.registerCodeLensProvider(COBOL_SELECTOR, new CobolCodeLensProvider()),
        vscode.languages.registerCallHierarchyProvider(COBOL_SELECTOR, new CobolCallHierarchyProvider()),
        vscode.languages.registerRenameProvider(COBOL_SELECTOR, new CobolRenameProvider()),
        vscode.languages.registerHoverProvider(COBOL_SELECTOR, new CobolHoverProvider()),
        vscode.languages.registerDocumentLinkProvider(COBOL_SELECTOR, new CobolCopyLinkProvider()),
        vscode.languages.registerDocumentSymbolProvider(COBOL_SELECTOR, new CobolDocumentSymbolProvider()),
        vscode.languages.registerWorkspaceSymbolProvider(new CobolWorkspaceSymbolProvider()),
        vscode.languages.registerCompletionItemProvider(COBOL_SELECTOR, new CobolCopyCompletionProvider(), ' '),
        vscode.languages.registerCompletionItemProvider(COBOL_SELECTOR, new CobolCompletionProvider(), ' ', '-'),
        vscode.languages.registerCompletionItemProvider(COBOL_SELECTOR, new CobolSnippetCompletionProvider()),
        vscode.languages.registerFoldingRangeProvider(COBOL_SELECTOR, new CobolFoldingProvider()),
        vscode.languages.registerCodeActionsProvider(COBOL_SELECTOR, new CobolCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        })
    );

    // Formattatore (formato fixed) - documento intero e selezione
    const formattingProvider = new CobolFormattingProvider(symbolIndex);
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(COBOL_SELECTOR, formattingProvider),
        vscode.languages.registerDocumentRangeFormattingEditProvider(COBOL_SELECTOR, formattingProvider)
    );

    // Comandi espliciti di formattazione (voci di menu dedicate COBOL Lens).
    context.subscriptions.push(
        vscode.commands.registerCommand('cobolLens.formatDocument', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isCobolDocument(editor.document)) return;
            const edits = formattingProvider.computeDocumentEdits(editor.document);
            await applyTextEdits(editor, edits);
        }),
        vscode.commands.registerCommand('cobolLens.formatSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isCobolDocument(editor.document)) return;
            const sel = editor.selection;
            const range = sel.isEmpty
                ? editor.document.lineAt(sel.active.line).range
                : new vscode.Range(sel.start, sel.end);
            const edits = formattingProvider.computeRangeEdits(editor.document, range);
            await applyTextEdits(editor, edits);
        }),
        // Toggle del commento COBOL sulle righe selezionate (o sulla riga del
        // cursore). In formato fixed usa l'asterisco in colonna 7; in
        // variable/free usa l'inline comment *>.
        vscode.commands.registerCommand('cobolLens.toggleComment', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isCobolDocument(editor.document)) return;
            await toggleCobolComment(editor);
        })
    );

    // Inlay hints: offset e dimensione dei campi della DATA DIVISION
    const inlayHintsProvider = new CobolInlayHintsProvider();
    context.subscriptions.push(
        vscode.languages.registerInlayHintsProvider(COBOL_SELECTOR, inlayHintsProvider)
    );

    // Comando: vista layout record (offset/dimensione) della DATA DIVISION
    context.subscriptions.push(
        vscode.commands.registerCommand('cobolLens.showRecordLayout', () => {
            const cfg = vscode.workspace.getConfiguration('cobolLens');
            if (!cfg.get('recordLayout.enabled', false)) {
                vscode.window.showInformationMessage(msg('recordLayoutDisabled'));
                return;
            }
            showRecordLayout();
        })
    );

    // Colorazione semantica (layer opzionale, attivabile dal setting)
    updateSemanticTokensRegistration();

    // Righelli di colonna in base al formato sorgente
    updateSourceFormatRulers();

    // Linter in tempo reale (debounced) durante la modifica
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            symbolIndex.invalidate(e.document.uri.toString());
            scheduleLint(e.document);
        })
    );

    // Linter completo al salvataggio
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            updateDiagnostics(doc);
        })
    );

    // Linter all'apertura del file
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            updateDiagnostics(doc);
        })
    );

    // Pulizia alla chiusura del file
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            symbolIndex.invalidate(doc.uri.toString());
            diagnosticCollection.delete(doc.uri);
            const key = doc.uri.toString();
            const timer = lintTimers.get(key);
            if (timer) { clearTimeout(timer); lintTimers.delete(key); }
        })
    );

    // Reagisci ai cambiamenti delle impostazioni
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cobolLens.linter')) {
                // Riesegui il linter su tutti i file aperti
                vscode.workspace.textDocuments.forEach(doc => {
                    if (isCobolDocument(doc)) updateDiagnostics(doc);
                });
            }
            if (e.affectsConfiguration('cobolLens.ifBlockHighlight')) {
                const editor = vscode.window.activeTextEditor;
                if (editor) applyIfBlockDecorations(editor);
            }
            if (e.affectsConfiguration('cobolLens.syntaxHighlighting')) {
                updateSemanticTokensRegistration();
            }
            if (e.affectsConfiguration('cobolLens.sourceFormat')) {
                updateSourceFormatRulers();
            }
            if (e.affectsConfiguration('cobolLens.inlayHints')) {
                inlayHintsProvider.refresh();
            }
        })
    );

    // Diagnostica su tutti i file COBOL gia' aperti
    vscode.workspace.textDocuments.forEach(doc => updateDiagnostics(doc));

    // IF/ELSE/END-IF block highlighting
    context.subscriptions.push(
        ...ifKeywordDecoTypes,
        ...ifScopeBarDecoTypes
    );

    // Aggiorna decorazioni IF all'apertura, cambio editor, cambio cursore, modifica
    if (vscode.window.activeTextEditor) {
        applyIfBlockDecorations(vscode.window.activeTextEditor);
    }
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) applyIfBlockDecorations(editor);
        }),
        vscode.window.onDidChangeTextEditorSelection(() => {
            scheduleIfBlockUpdate();
        }),
        vscode.workspace.onDidChangeTextDocument(() => {
            scheduleIfBlockUpdate();
        })
    );

    // Apri la guida introduttiva (walkthrough) solo alla primissima installazione
    maybeShowWelcomeWalkthrough(context);
}

function maybeShowWelcomeWalkthrough(context) {
    const KEY = 'cobolLens.welcomeShown';
    if (context.globalState.get(KEY)) return;
    // Segna subito come mostrato, cosi' non si ripropone mai piu' (anche se l'utente chiude)
    context.globalState.update(KEY, true);
    const cfg = vscode.workspace.getConfiguration('cobolLens');
    if (!cfg.get('showWelcomeOnStartup', true)) return;
    vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'rendani-labs.cobol-lens#cobolLens.gettingStarted',
        true // toSide: apre di fianco senza rubare il focus all'editor
    );
}

function deactivate() {
    symbolIndex.clear();
    if (semanticTokensRegistration) {
        semanticTokensRegistration.dispose();
        semanticTokensRegistration = undefined;
    }
}

module.exports = { activate, deactivate };
