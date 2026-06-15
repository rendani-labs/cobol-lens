// @ts-check
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { resolveCopybookPath, COPY_REGEX, isComment } = require('./cobol-parser');
const { SymbolIndex } = require('./symbol-index');
const { runLinter } = require('./cobol-linter');
const { computeFieldSize } = require('./cobol-layout');
const { msg, getLang, setLang } = require('./messages');

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
                }
            }

            if (sym.lineText) {
                content.appendCodeblock(sym.lineText.trimStart(), 'cobol');
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
            if (!copyInfo) continue;

            const resolved = resolveCopybookPath(copyInfo.copyName, wsRoot);
            if (!resolved) continue;

            const range = new vscode.Range(
                i, copyInfo.nameStart,
                i, copyInfo.nameStart + copyInfo.copyName.length
            );
            const link = new vscode.DocumentLink(range, vscode.Uri.file(resolved));
            link.tooltip = `Apri copybook: ${path.basename(resolved)}`;
            links.push(link);
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

/** Decoration types per la barra laterale di scope per livello */
const ifScopeBarDecoTypes = IF_BLOCK_COLORS.map(c =>
    vscode.window.createTextEditorDecorationType({
        borderLeft: `2px solid ${c.border}`,
        isWholeLine: true
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
 * @property {'end-if'|'period'|'eof'} [closedBy] - Come il blocco e' stato chiuso
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
    let nestLevel = 0;

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
                nestLevel--;
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

            const level = nestLevel;
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
            nestLevel++;
        }

        // Un punto chiude tutti gli scope aperti (come nel linter)
        if (masked.includes('.')) {
            // Chiudi tutti i blocchi rimasti aperti
            while (stack.length > 0) {
                const opened = stack.pop();
                nestLevel--;
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

    // Includi blocchi chiusi da END-IF e da punto (escludi solo quelli non chiusi / EOF)
    return blocks.filter(b => b.closedBy === 'end-if' || b.closedBy === 'period');
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

    // Scope bars ? sempre visibili, raggruppate per livello
    /** @type {vscode.DecorationOptions[][]} */
    const scopeBarsByLevel = Array.from({ length: numColors }, () => []);
    for (const block of blocks) {
        if (!showScopeBars) break;
        const colorIdx = block.level % numColors;
        // Per blocchi chiusi da punto, includi anche endLine (la riga col punto e' parte del body)
        const endBound = block.closedBy === 'period' ? block.endLine + 1 : block.endLine;
        for (let line = block.ifLine + 1; line < endBound; line++) {
            if (block.elseLine !== undefined && line === block.elseLine) continue;
            scopeBarsByLevel[colorIdx].push({
                range: new vscode.Range(line, 0, line, 0)
            });
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
        vscode.languages.registerHoverProvider(COBOL_SELECTOR, new CobolHoverProvider()),
        vscode.languages.registerDocumentLinkProvider(COBOL_SELECTOR, new CobolCopyLinkProvider()),
        vscode.languages.registerDocumentSymbolProvider(COBOL_SELECTOR, new CobolDocumentSymbolProvider()),
        vscode.languages.registerCompletionItemProvider(COBOL_SELECTOR, new CobolCopyCompletionProvider(), ' '),
        vscode.languages.registerFoldingRangeProvider(COBOL_SELECTOR, new CobolFoldingProvider())
    );

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
}

function deactivate() {
    symbolIndex.clear();
}

module.exports = { activate, deactivate };
