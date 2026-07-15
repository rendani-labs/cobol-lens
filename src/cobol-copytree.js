// @ts-check
'use strict';

/**
 * Costruzione dell'albero delle dipendenze copybook (istruzioni COPY, anche
 * annidate) di un sorgente COBOL. Usato dalla TreeView "Dipendenze copybook".
 *
 * L'albero e' puramente strutturale: ogni nodo rappresenta una COPY trovata in
 * un file. Le COPY non risolvibili (copybook mancante) e le ricorsioni vengono
 * marcate, senza interrompere la costruzione del resto dell'albero.
 */

const fs = require('fs');
const { COPY_REGEX, isComment, resolveCopybookPath } = require('./cobol-parser');

/**
 * @typedef {Object} CopyNode
 * @property {string} name - Nome della copybook (come scritto nella COPY)
 * @property {string|null} filePath - Percorso risolto sul disco (null se mancante)
 * @property {boolean} resolved - true se la copybook e' stata trovata
 * @property {boolean} cyclic - true se la COPY genererebbe una ricorsione
 * @property {number} line - Riga 0-based della COPY nel file padre
 * @property {CopyNode[]} children - Copybook incluse a loro volta (COPY annidate)
 */

/**
 * Estrae i nomi delle copybook incluse via COPY da un elenco di righe.
 * @param {string[]} lines
 * @returns {{ name: string, line: number }[]}
 */
function findCopyStatements(lines) {
    /** @type {{ name: string, line: number }[]} */
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || isComment(line)) continue;
        const m = COPY_REGEX.exec(line);
        if (m) result.push({ name: m[1], line: i });
    }
    return result;
}

/**
 * Costruisce ricorsivamente i figli COPY di un file gia' letto in righe.
 * @param {string[]} lines
 * @param {string} workspaceRoot
 * @param {object} opts
 * @param {(name: string, root: string) => (string|undefined)} opts.resolve
 * @param {(filePath: string) => string} opts.read
 * @param {Set<string>} chain - copybook in corso di espansione (anti-ricorsione)
 * @returns {CopyNode[]}
 */
function buildChildren(lines, workspaceRoot, opts, chain) {
    /** @type {CopyNode[]} */
    const children = [];
    for (const stmt of findCopyStatements(lines)) {
        const key = stmt.name.toUpperCase();
        const resolvedPath = opts.resolve(stmt.name, workspaceRoot);

        /** @type {CopyNode} */
        const node = {
            name: stmt.name,
            filePath: resolvedPath || null,
            resolved: !!resolvedPath,
            cyclic: chain.has(key),
            line: stmt.line,
            children: []
        };

        // Espandi solo se risolvibile e non gia' nella catena (anti-ricorsione).
        if (resolvedPath && !chain.has(key)) {
            let content;
            try {
                content = opts.read(resolvedPath);
            } catch (e) {
                content = null;
            }
            if (content !== null) {
                const childChain = new Set(chain);
                childChain.add(key);
                node.children = buildChildren(
                    content.split(/\r?\n/), workspaceRoot, opts, childChain);
            }
        }

        children.push(node);
    }
    return children;
}

/**
 * Costruisce l'albero delle dipendenze copybook a partire da un file sorgente.
 * @param {string} rootFilePath - Percorso del file COBOL principale
 * @param {string} workspaceRoot - Root per risolvere le COPY
 * @param {object} [opts]
 * @param {(name: string, root: string) => (string|undefined)} [opts.resolve]
 * @param {(filePath: string) => string} [opts.read]
 * @returns {CopyNode[]} elenco delle COPY di primo livello (con sotto-alberi)
 */
function buildCopyTree(rootFilePath, workspaceRoot, opts) {
    opts = opts || {};
    const resolve = opts.resolve || resolveCopybookPath;
    const read = opts.read || ((p) => fs.readFileSync(p, 'utf-8'));

    let content;
    try {
        content = read(rootFilePath);
    } catch (e) {
        return [];
    }

    const chain = new Set();
    if (rootFilePath) chain.add(rootFilePath.toUpperCase());
    return buildChildren(content.split(/\r?\n/), workspaceRoot, { resolve, read }, chain);
}

module.exports = {
    buildCopyTree,
    findCopyStatements
};
