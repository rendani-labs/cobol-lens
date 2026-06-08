'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(__dirname, 'fixtures');
const workDir = path.join(__dirname, 'work');

const desktopFixed = 'C:\\Users\\SD456202\\OneDrive - SD Worx\\Desktop\\COPYTABN_all_fixed.CBL';
const desktopVariable = 'C:\\Users\\SD456202\\OneDrive - SD Worx\\Desktop\\COPYTABN_all.CBL';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function mockVscode() {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  class Range {
    constructor(startLine, startChar, endLine, endChar) {
      this.start = { line: startLine, character: startChar };
      this.end = { line: endLine, character: endChar };
    }
  }

  class Diagnostic {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
      this.source = undefined;
      this.code = undefined;
      this.tags = undefined;
      this._symbolName = undefined;
    }
  }

  const configMap = {
    'cobolLens.linter': {
      enabled: true,
      onType: false,
      delay: 0
    },
    'cobolLens.linter.rules': {
    },
    'cobolLens': {
      copyFolders: ['Copy', 'Copy_DR', 'Copy_Prod'],
      copyExtensions: ['', '.cpy', '.CPY', '.COPY', '.copy'],
      ignoredCopybooks: ['DFHBMSCA', 'DFHAID']
    }
  };

  require.cache.vscode = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: {
      workspace: {
        getConfiguration: (section) => ({
          get: (key, def) => {
            const bag = configMap[section] || {};
            return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : def;
          }
        })
      },
      Range,
      Diagnostic,
      DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3
      },
      DiagnosticTag: {
        Unnecessary: 1
      }
    }
  };
}

function chooseInputPath(desktopPath, fixturePath) {
  if (fs.existsSync(desktopPath)) return desktopPath;
  return fixturePath;
}

function createWorkingCopy(inputPath, outName) {
  ensureDir(workDir);
  const outPath = path.join(workDir, outName);
  fs.copyFileSync(inputPath, outPath);
  return outPath;
}

function findDiagOnLine(diags, lines, code, textSnippet) {
  return diags.find(d => String(d.code) === code && lines[d.range.start.line] && lines[d.range.start.line].includes(textSnippet));
}

function run() {
  mockVscode();
  const { runLinter } = require('../src/cobol-linter');

  const fixedSource = chooseInputPath(desktopFixed, path.join(fixturesDir, 'COPYTABN_all_fixed.CBL'));
  const variableSource = chooseInputPath(desktopVariable, path.join(fixturesDir, 'COPYTABN_all.CBL'));

  const fixedWork = createWorkingCopy(fixedSource, 'COPYTABN_all_fixed.work.CBL');
  const variableWork = createWorkingCopy(variableSource, 'COPYTABN_all.work.CBL');

  // Base run: fixed
  const fixedText = fs.readFileSync(fixedWork, 'utf8');
  const fixedLines = fixedText.split(/\r?\n/);
  const fixedDiags = runLinter(fixedText, repoRoot);

  assert(
    !!findDiagOnLine(fixedDiags, fixedLines, 'col72', '01 STS-TABN'),
    'Atteso errore col72 su STS-TABN nel file fixed'
  );

  assert(
    !!findDiagOnLine(fixedDiags, fixedLines, 'col72', "DISPLAY '************ F I N E"),
    'Atteso errore col72 sulla DISPLAY FINE nel file fixed'
  );

  // Base run: variable
  const variableText = fs.readFileSync(variableWork, 'utf8');
  const variableLines = variableText.split(/\r?\n/);
  const variableDiags = runLinter(variableText, repoRoot);

  assert(
    !!findDiagOnLine(variableDiags, variableLines, 'chars-after-period', '01 STS-TABN'),
    'Atteso errore chars-after-period su STS-TABN nel file variable'
  );

  assert(
    !!findDiagOnLine(variableDiags, variableLines, 'chars-after-period', "DISPLAY '************ F I N E"),
    'Atteso errore chars-after-period sulla DISPLAY FINE nel file variable'
  );

  assert(
    !findDiagOnLine(variableDiags, variableLines, 'chars-after-period', 'PROGRAM-ID.'),
    'Non atteso errore chars-after-period su PROGRAM-ID. in Identification Division'
  );

  // Mutazione su copia di lavoro (non tocca i file originali)
  // Rimuove la coda numerica dalla riga STS-TABN per test non regressione.
  const mutatedVariable = variableText.replace(
    "01 STS-TABN                  PIC   X(02) VALUE ZERO              00330000 .",
    "01 STS-TABN                  PIC   X(02) VALUE ZERO."
  );
  fs.writeFileSync(variableWork, mutatedVariable, 'utf8');

  const mutatedLines = mutatedVariable.split(/\r?\n/);
  const mutatedDiags = runLinter(mutatedVariable, repoRoot);

  assert(
    !findDiagOnLine(mutatedDiags, mutatedLines, 'chars-after-period', '01 STS-TABN                  PIC   X(02) VALUE ZERO.'),
    'Non atteso errore chars-after-period sulla riga STS-TABN dopo rimozione della coda numerica'
  );

  console.log('OK - test regressione linter superati');
  console.log(`Origine fixed: ${fixedSource}`);
  console.log(`Origine variable: ${variableSource}`);
  console.log(`Copie di lavoro: ${workDir}`);
}

try {
  run();
} catch (err) {
  console.error('KO - test regressione linter falliti');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
