// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const { parseCobolSymbols } = require('./cobol-parser');

/**
 * Cache dei simboli per documento.
 * Chiave: URI del documento, Valore: { version, symbols }
 */
class SymbolIndex {
    constructor() {
        /** @type {Map<string, { version: number, symbols: import('./cobol-parser').CobolSymbol[] }>} */
        this._cache = new Map();
    }

    /**
     * Ottiene i simboli per un documento, con cache basata su version.
     * @param {vscode.TextDocument} document
     * @returns {import('./cobol-parser').CobolSymbol[]}
     */
    getSymbols(document) {
        const key = document.uri.toString();
        const cached = this._cache.get(key);

        if (cached && cached.version === document.version) {
            return cached.symbols;
        }

        // Cerca workspace folder; se non trovato (file remoto/temp),
        // usa il primo workspace folder come fallback
        let workspaceRoot;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (workspaceFolder) {
            workspaceRoot = workspaceFolder.uri.fsPath;
        } else {
            const folders = vscode.workspace.workspaceFolders;
            if (folders && folders.length > 0) {
                workspaceRoot = folders[0].uri.fsPath;
            } else {
                return [];
            }
        }

        const symbols = parseCobolSymbols(
            document.uri.fsPath,
            document.getText(),
            workspaceRoot
        );

        this._cache.set(key, { version: document.version, symbols });
        return symbols;
    }

    /**
     * Ottiene i simboli da un file su disco (per copybook non aperte).
     * @param {string} filePath
     * @param {string} workspaceRoot
     * @returns {import('./cobol-parser').CobolSymbol[]}
     */
    getSymbolsFromFile(filePath, workspaceRoot) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return parseCobolSymbols(filePath, content, workspaceRoot);
        } catch (e) {
            return [];
        }
    }

    /**
     * Cerca un simbolo per nome nei simboli del documento.
     * @param {vscode.TextDocument} document
     * @param {string} name - Nome del simbolo (case-insensitive)
     * @returns {import('./cobol-parser').CobolSymbol | undefined}
     */
    findSymbol(document, name) {
        const symbols = this.getSymbols(document);
        const upperName = name.toUpperCase();
        return symbols.find(s => s.name === upperName && s.type !== 'copy');
    }

    /**
     * Cerca tutti i simboli con un dato nome.
     * @param {vscode.TextDocument} document
     * @param {string} name
     * @returns {import('./cobol-parser').CobolSymbol[]}
     */
    findAllSymbols(document, name) {
        const symbols = this.getSymbols(document);
        const upperName = name.toUpperCase();
        return symbols.filter(s => s.name === upperName && s.type !== 'copy');
    }

    /**
     * Invalida la cache per un documento.
     * @param {string} uri
     */
    invalidate(uri) {
        this._cache.delete(uri);
    }

    /**
     * Pulisce tutta la cache.
     */
    clear() {
        this._cache.clear();
    }
}

module.exports = { SymbolIndex };
