'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(__dirname, 'fixtures');
const workDir = path.join(__dirname, 'work');

// 'cobolLens.linter.rules' vuoto = tutte le regole accese, a prescindere dai
// default di package.json; runRealDefaultsTests lo sostituisce temporaneamente.
const mockConfig = {
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

  const configMap = mockConfig;

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
      env: {
        language: 'en'
      },
      Range,
      Diagnostic,
      SemanticTokensLegend: class {
        constructor(tokenTypes, tokenModifiers) {
          this.tokenTypes = tokenTypes;
          this.tokenModifiers = tokenModifiers;
        }
      },
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

  const fixedSource = path.join(fixturesDir, 'SAMPLE01_all_fixed.CBL');
  const variableSource = path.join(fixturesDir, 'SAMPLE01_all.CBL');

  const fixedWork = createWorkingCopy(fixedSource, 'SAMPLE01_all_fixed.work.CBL');
  const variableWork = createWorkingCopy(variableSource, 'SAMPLE01_all.work.CBL');

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

  // ---------------------------------------------------------------------------
  // move-alphanumeric-to-numeric con variabili definite in COPY
  // (le variabili numeriche/alfanumeriche dichiarate in copybook devono essere
  //  classificate correttamente espandendo la COPY)
  // ---------------------------------------------------------------------------
  const copyDir = path.join(workDir, 'Copy');
  ensureDir(copyDir);
  fs.writeFileSync(path.join(copyDir, 'COPYTYPES01'),
    [
      '      *-----------------------------------------------------------------',
      '       01 WS-ALFA                          PIC X(010).',
      '       01 WS-NUM                           PIC 9(010).',
      ''
    ].join('\n'), 'utf8');

  const copyProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-COPYMOVE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       COPY COPYTYPES01.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    "           MOVE 'CIAO'                      TO WS-NUM.",
    '           MOVE 123456                      TO WS-NUM.',
    '           GOBACK.',
    ''
  ].join('\n');

  const copyProgramLines = copyProgram.split(/\r?\n/);
  const copyDiags = runLinter(copyProgram, workDir);

  assert(
    !!findDiagOnLine(copyDiags, copyProgramLines, 'move-alphanumeric-to-numeric', "MOVE 'CIAO'"),
    "Atteso errore move-alphanumeric-to-numeric su MOVE 'CIAO' verso WS-NUM (numerico definito in COPY)"
  );

  assert(
    !findDiagOnLine(copyDiags, copyProgramLines, 'move-alphanumeric-to-numeric', 'MOVE 123456'),
    'Non atteso errore move-alphanumeric-to-numeric su MOVE di literal numerica verso WS-NUM'
  );

  // and-or-if: "OR '04'" termina con un letterale, NON con OR -> IF lecito.
  const andOrIfProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-ANDORIF.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-CODICE                  PIC X(002).',
    '       01 RAPPOR                     PIC X(001).',
    '       01 W-X                        PIC 9(005).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           EVALUATE TRUE',
    "              WHEN WS-CODICE EQUAL '02'",
    "                 OR '04'",
    '                 IF RAPPOR EQUAL',
    "                    '5' OR '9'",
    '                    MOVE 1 TO W-X',
    '                 END-IF',
    '           END-EVALUATE',
    "           IF WS-CODICE EQUAL '01' OR",
    "              IF RAPPOR EQUAL '5'",
    '              MOVE 2 TO W-X',
    '           END-IF',
    '           GOBACK.',
    ''
  ].join('\n');
  const andOrIfDiags = runLinter(andOrIfProgram, workDir);

  assert(
    !andOrIfDiags.some(d => String(d.code) === 'and-or-if' && d.range.start.line === 12),
    "Non atteso and-or-if su IF dopo \"OR '04'\""
  );
  assert(
    andOrIfDiags.some(d => String(d.code) === 'and-or-if' && d.range.start.line === 18),
    'Atteso and-or-if su IF dopo riga terminata da OR'
  );

  // ---------------------------------------------------------------------------
  // move-alphanumeric-to-numeric: l'indice di subscript (I2) NON deve essere
  // segnalato come destinazione. Solo il campo tabella e' la destinazione.
  // Regressione: "MOVE ALFA-VAR TO TABLE-FIELD (I2)" flaggava I2 anziche'
  //              ignorarlo come subscript.
  // ---------------------------------------------------------------------------
  const tableProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-TABLEMOVE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 I2                         PIC 9(005) COMP VALUE 0.',
    '       01 MAX-DIP                    PIC 9(005) COMP VALUE 0.',
    '       01 TAB-DIP.',
    '           05 TAB-DIP-LINEA          PIC X(050) OCCURS 100 TIMES.',
    '       01 ALFA-VAR                   PIC X(050).',
    '       01 NUMERIC-DEST               PIC 9(005).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM VARYING I2 FROM 1 BY 1',
    '               UNTIL I2 > MAX-DIP',
    '               MOVE ALFA-VAR         TO TAB-DIP-LINEA (I2)',
    '           END-PERFORM.',
    '           GOBACK.',
    ''
  ].join('\n');

  const tableProgramLines = tableProgram.split(/\r?\n/);
  const tableDiags = runLinter(tableProgram, workDir);

  assert(
    !findDiagOnLine(tableDiags, tableProgramLines, 'move-alphanumeric-to-numeric', 'MOVE ALFA-VAR'),
    'Non atteso errore move-alphanumeric-to-numeric: ALFA-VAR e TAB-DIP-LINEA sono entrambi alfanumerici'
  );

  // Verifica che I2 (l'indice, numerico) NON venga segnalato come destinazione
  const i2Flagged = tableDiags.some(d =>
    d.message && d.message.includes('I2') &&
    d.code === 'move-alphanumeric-to-numeric'
  );
  assert(
    !i2Flagged,
    "Non atteso errore move-alphanumeric-to-numeric su I2 (e' un subscript, non la destinazione)"
  );

  // Verifica che un MOVE alfa -> numerico diretto sia ancora segnalato
  const tableProgram2 = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-TABLEMOVE2.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 I2                         PIC 9(005) COMP VALUE 0.',
    '       01 TAB-NUM.',
    '           05 TAB-NUM-ELEM           PIC 9(005) OCCURS 100 TIMES.',
    '       01 ALFA-VAR                   PIC X(050).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE ALFA-VAR             TO TAB-NUM-ELEM (I2).',
    '           GOBACK.',
    ''
  ].join('\n');

  const tableProgram2Lines = tableProgram2.split(/\r?\n/);
  const tableDiags2 = runLinter(tableProgram2, workDir);

  assert(
    !!findDiagOnLine(tableDiags2, tableProgram2Lines, 'move-alphanumeric-to-numeric', 'MOVE ALFA-VAR'),
    'Atteso errore move-alphanumeric-to-numeric: ALFA-VAR alfanumerica spostata in TAB-NUM-ELEM numerica (con subscript I2)'
  );

  const i2Flagged2 = tableDiags2.some(d =>
    d.message && d.message.includes('I2') &&
    d.code === 'move-alphanumeric-to-numeric'
  );
  assert(
    !i2Flagged2,
    "Non atteso errore move-alphanumeric-to-numeric su I2 (e' un subscript, non la destinazione) - caso tabella numerica"
  );

  // ---------------------------------------------------------------------------
  // undefined-variable: un indice dichiarato con OCCURS ... INDEXED BY non deve
  // essere segnalato come non definito quando viene usato (es. nei SET).
  // Copre sia INDEXED BY sulla stessa riga del livello sia su riga di
  // continuazione, e il caso di piu' indici.
  // ---------------------------------------------------------------------------
  const indexProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-INDEXED.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 TAB-VALORI.',
    '          05 T2-VALORI OCCURS 41 ASCENDING KEY T3-CARATTERE',
    '                       INDEXED BY T2-IDX.',
    '             10 T3-CARATTERE          PIC X(001).',
    '             10 T3-VALORE             PIC 9(004).',
    '       01 TAB-DUE.',
    '          05 T4-ELEM OCCURS 10 INDEXED BY T4-IDX-A T4-IDX-B',
    '                                 PIC X(005).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           SET T2-IDX                TO 1.',
    '           SET T4-IDX-A              TO 1.',
    '           SET T4-IDX-B              TO 1.',
    '           GOBACK.',
    ''
  ].join('\n');

  const indexProgramLines = indexProgram.split(/\r?\n/);
  const indexDiags = runLinter(indexProgram, workDir);

  assert(
    !findDiagOnLine(indexDiags, indexProgramLines, 'undefined-variable', 'SET T2-IDX'),
    'Non atteso errore undefined-variable su T2-IDX (indice INDEXED BY su riga di continuazione)'
  );
  assert(
    !findDiagOnLine(indexDiags, indexProgramLines, 'undefined-variable', 'SET T4-IDX-A'),
    'Non atteso errore undefined-variable su T4-IDX-A (primo di piu\' indici INDEXED BY)'
  );
  assert(
    !findDiagOnLine(indexDiags, indexProgramLines, 'undefined-variable', 'SET T4-IDX-B'),
    'Non atteso errore undefined-variable su T4-IDX-B (secondo di piu\' indici INDEXED BY)'
  );

  // ---------------------------------------------------------------------------
  // chars-after-period: un header di paragrafo seguito da uno statement sulla
  // stessa riga (idioma "EX-ELABORA. EXIT.") e' valido e NON deve essere
  // segnalato. Va invece ancora segnalato il vero contenuto spurio dopo il
  // punto terminatore di una frase.
  // ---------------------------------------------------------------------------
  const periodProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-PERIOD.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM RT-ELABORA THRU EX-ELABORA.',
    '           GOBACK.',
    '       RT-ELABORA.',
    '           CONTINUE.',
    '       EX-ELABORA. EXIT.',
    '       EX-DUE.     EXIT. PIPPO.',
    ''
  ].join('\n');

  const periodProgramLines = periodProgram.split(/\r?\n/);
  const periodDiags = runLinter(periodProgram, workDir);

  assert(
    !findDiagOnLine(periodDiags, periodProgramLines, 'chars-after-period', 'EX-ELABORA. EXIT.'),
    'Non atteso errore chars-after-period su "EX-ELABORA. EXIT." (header paragrafo + statement)'
  );
  assert(
    !!findDiagOnLine(periodDiags, periodProgramLines, 'chars-after-period', 'EX-DUE.     EXIT. PIPPO.'),
    'Atteso errore chars-after-period sul contenuto spurio "PIPPO." dopo il terminatore di EXIT.'
  );

  // ---------------------------------------------------------------------------
  // empty-paragraph: i paragrafi di sola uscita con le convenzioni di nome
  // comuni (-EX, -EXIT, -FINE, -END, -X) NON devono essere segnalati anche se
  // contengono solo EXIT/CONTINUE. Un paragrafo vuoto con nome generico va
  // invece ancora segnalato.
  // ---------------------------------------------------------------------------
  const emptyParaProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-EMPTY.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM RT-A THRU RT-A-EXIT.',
    '           PERFORM VAL-CAMPO THRU EX-VAL-CAMPO-DECOD.',
    '           GOBACK.',
    '       RT-A.',
    '           MOVE 1 TO WS-X.',
    '       RT-A-EXIT.',
    '           EXIT.',
    '       RT-B-FINE.',
    '           EXIT.',
    '       VAL-CAMPO.',
    '           MOVE 2 TO WS-Y.',
    '       EX-VAL-CAMPO-DECOD.',
    '           EXIT.',
    '       RT-VUOTO.',
    '           EXIT.',
    ''
  ].join('\n');

  const emptyParaLines = emptyParaProgram.split(/\r?\n/);
  const emptyParaDiags = runLinter(emptyParaProgram, workDir);

  assert(
    !findDiagOnLine(emptyParaDiags, emptyParaLines, 'empty-paragraph', 'RT-A-EXIT.'),
    'Non atteso errore empty-paragraph su RT-A-EXIT (paragrafo di uscita -EXIT)'
  );
  assert(
    !findDiagOnLine(emptyParaDiags, emptyParaLines, 'empty-paragraph', 'RT-B-FINE.'),
    'Non atteso errore empty-paragraph su RT-B-FINE (paragrafo di uscita -FINE)'
  );
  assert(
    !findDiagOnLine(emptyParaDiags, emptyParaLines, 'empty-paragraph', 'EX-VAL-CAMPO-DECOD.'),
    'Non atteso errore empty-paragraph su EX-VAL-CAMPO-DECOD (target di PERFORM ... THRU, prefisso EX-)'
  );
  assert(
    !!findDiagOnLine(emptyParaDiags, emptyParaLines, 'empty-paragraph', 'RT-VUOTO.'),
    'Atteso errore empty-paragraph su RT-VUOTO (nome generico, solo EXIT)'
  );

  // ---------------------------------------------------------------------------
  // no-goto: ora e' un warning (non piu' error) ma deve comunque essere
  // segnalato l'uso di GO TO.
  // ---------------------------------------------------------------------------
  const gotoProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-GOTO.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GO TO FINE.',
    '       FINE.',
    '           GOBACK.',
    ''
  ].join('\n');

  const gotoLines = gotoProgram.split(/\r?\n/);
  const gotoDiags = runLinter(gotoProgram, workDir);
  const gotoDiag = findDiagOnLine(gotoDiags, gotoLines, 'no-goto', 'GO TO FINE');
  assert(!!gotoDiag, 'Atteso diagnostico no-goto su GO TO FINE');
  assert(gotoDiag.severity === 1,
    `no-goto deve essere warning (severity 1), ottenuto ${gotoDiag && gotoDiag.severity}`);

  // ---------------------------------------------------------------------------
  // Soppressione diagnostiche (commenti magici cobol-lens-disable*).
  // Programma base che genera un no-goto: verifichiamo le varie direttive.
  // ---------------------------------------------------------------------------
  const suppBaseLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUPP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GO TO FINE.',
    '       FINE.',
    '           GOBACK.',
    ''
  ];

  // Controllo di base: senza direttive il no-goto viene segnalato.
  const suppBase = suppBaseLines.join('\n');
  assert(
    !!findDiagOnLine(runLinter(suppBase, workDir), suppBaseLines, 'no-goto', 'GO TO FINE'),
    'Controllo base soppressione: senza direttive il no-goto deve essere segnalato'
  );

  // disable-next-line con la regola: sopprime il no-goto sulla riga successiva.
  const suppNextLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUPP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '      * cobol-lens-disable-next-line no-goto',
    '           GO TO FINE.',
    '       FINE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !findDiagOnLine(runLinter(suppNextLines.join('\n'), workDir), suppNextLines, 'no-goto', 'GO TO FINE'),
    'disable-next-line no-goto deve sopprimere il no-goto sulla riga successiva'
  );

  // disable-next-line con una regola diversa: il no-goto resta segnalato.
  const suppNextOtherLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUPP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '      * cobol-lens-disable-next-line uppercase',
    '           GO TO FINE.',
    '       FINE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(suppNextOtherLines.join('\n'), workDir), suppNextOtherLines, 'no-goto', 'GO TO FINE'),
    'disable-next-line di un\'altra regola non deve sopprimere il no-goto'
  );

  // disable-line inline (*>) sulla riga del GO TO.
  const suppInlineLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUPP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GO TO FINE.                *> cobol-lens-disable-line no-goto',
    '       FINE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !findDiagOnLine(runLinter(suppInlineLines.join('\n'), workDir), suppInlineLines, 'no-goto', 'GO TO FINE'),
    'disable-line inline (*>) deve sopprimere il no-goto sulla riga corrente'
  );

  // Blocco disable/enable: il primo GO TO e' soppresso, il secondo no.
  const suppBlockLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUPP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '      * cobol-lens-disable no-goto',
    '           GO TO PASSO1.',
    '       PASSO1.',
    '      * cobol-lens-enable no-goto',
    '           GO TO FINE.',
    '       FINE.',
    '           GOBACK.',
    ''
  ];
  const suppBlockDiags = runLinter(suppBlockLines.join('\n'), workDir);
  assert(
    !findDiagOnLine(suppBlockDiags, suppBlockLines, 'no-goto', 'GO TO PASSO1'),
    'Nel blocco disabilitato il primo GO TO deve essere soppresso'
  );
  assert(
    !!findDiagOnLine(suppBlockDiags, suppBlockLines, 'no-goto', 'GO TO FINE'),
    'Dopo cobol-lens-enable il secondo GO TO deve tornare segnalato'
  );

  // disable senza regole: sopprime TUTTE le regole sulla riga successiva.
  const suppAllLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUPP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '      * cobol-lens-disable-next-line',
    '           GO TO FINE.',
    '       FINE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !findDiagOnLine(runLinter(suppAllLines.join('\n'), workDir), suppAllLines, 'no-goto', 'GO TO FINE'),
    'disable-next-line senza regole deve sopprimere qualunque diagnostica sulla riga successiva'
  );

  // ---------------------------------------------------------------------------
  // duplicate-paragraph: due paragrafi con lo stesso nome nella stessa sezione
  // vanno segnalati (il secondo). Nomi diversi non vanno segnalati.
  // ---------------------------------------------------------------------------
  const dupParaLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DUP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM RT-A.',
    '           GOBACK.',
    '       RT-A.',
    '           CONTINUE.',
    '       RT-A.',
    '           CONTINUE.',
    ''
  ];
  const dupParaDiags = runLinter(dupParaLines.join('\n'), workDir);
  assert(
    dupParaDiags.filter(d => String(d.code) === 'duplicate-paragraph').length === 1,
    'Atteso un solo errore duplicate-paragraph (sulla seconda RT-A)'
  );
  assert(
    dupParaDiags.some(d => String(d.code) === 'duplicate-paragraph' && d.range.start.line === 8),
    'duplicate-paragraph deve essere segnalato sulla seconda occorrenza di RT-A (riga 9)'
  );

  const noDupParaLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NODUP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM RT-A.',
    '           GOBACK.',
    '       RT-A.',
    '           CONTINUE.',
    '       RT-B.',
    '           CONTINUE.',
    ''
  ];
  assert(
    !runLinter(noDupParaLines.join('\n'), workDir).some(d => String(d.code) === 'duplicate-paragraph'),
    'Non atteso duplicate-paragraph con nomi di paragrafo distinti'
  );

  // ---------------------------------------------------------------------------
  // alter-statement: l'uso di ALTER va segnalato; identificatori che contengono
  // "ALTER" (es. WS-ALTERNATE) non vanno segnalati.
  // ---------------------------------------------------------------------------
  const alterLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-ALTER.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           ALTER RT-A TO PROCEED TO RT-B.',
    '           GOBACK.',
    '       RT-A.',
    '           GO TO RT-A.',
    '       RT-B.',
    '           CONTINUE.',
    ''
  ];
  const alterLinesArr = alterLines;
  const alterDiags = runLinter(alterLines.join('\n'), workDir);
  assert(
    !!findDiagOnLine(alterDiags, alterLinesArr, 'alter-statement', 'ALTER RT-A'),
    'Atteso alter-statement su ALTER RT-A TO PROCEED TO RT-B'
  );

  const noAlterLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NOALTER.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-ALTERNATE          PIC X(005).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE SPACES TO WS-ALTERNATE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(noAlterLines.join('\n'), workDir).some(d => String(d.code) === 'alter-statement'),
    'Non atteso alter-statement su un identificatore che contiene ALTER (WS-ALTERNATE)'
  );

  // ---------------------------------------------------------------------------
  // next-sentence: NEXT SENTENCE va segnalato.
  // ---------------------------------------------------------------------------
  const nextSentLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NEXT.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           IF WS-A = 1',
    '              NEXT SENTENCE',
    '           END-IF.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(nextSentLines.join('\n'), workDir), nextSentLines, 'next-sentence', 'NEXT SENTENCE'),
    'Atteso next-sentence su NEXT SENTENCE'
  );

  // ---------------------------------------------------------------------------
  // evaluate-without-when-other: EVALUATE con END-EVALUATE senza WHEN OTHER va
  // segnalato; con WHEN OTHER no.
  // ---------------------------------------------------------------------------
  const evalNoOtherLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-EVAL.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           EVALUATE WS-A',
    '              WHEN 1',
    '                 CONTINUE',
    '              WHEN 2',
    '                 CONTINUE',
    '           END-EVALUATE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(evalNoOtherLines.join('\n'), workDir), evalNoOtherLines, 'evaluate-without-when-other', 'EVALUATE WS-A'),
    'Atteso evaluate-without-when-other su EVALUATE senza WHEN OTHER'
  );

  const evalWithOtherLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-EVAL2.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           EVALUATE WS-A',
    '              WHEN 1',
    '                 CONTINUE',
    '              WHEN OTHER',
    '                 CONTINUE',
    '           END-EVALUATE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(evalWithOtherLines.join('\n'), workDir).some(d => String(d.code) === 'evaluate-without-when-other'),
    'Non atteso evaluate-without-when-other quando e\' presente WHEN OTHER'
  );

  // ---------------------------------------------------------------------------
  // perform-varying-without-until: PERFORM VARYING senza UNTIL va segnalato;
  // con UNTIL (anche su riga di continuazione) no.
  // ---------------------------------------------------------------------------
  const pvNoUntilLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-PV.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM VARYING WS-I FROM 1 BY 1',
    '              ADD 1 TO WS-TOT',
    '           END-PERFORM.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(pvNoUntilLines.join('\n'), workDir), pvNoUntilLines, 'perform-varying-without-until', 'PERFORM VARYING'),
    'Atteso perform-varying-without-until su PERFORM VARYING senza UNTIL'
  );

  const pvWithUntilContLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-PV2.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM VARYING WS-I FROM 1 BY 1',
    '              UNTIL WS-I > 10',
    '              ADD 1 TO WS-TOT',
    '           END-PERFORM.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(pvWithUntilContLines.join('\n'), workDir).some(d => String(d.code) === 'perform-varying-without-until'),
    'Non atteso perform-varying-without-until quando UNTIL e\' su riga di continuazione'
  );

  // ---------------------------------------------------------------------------
  // level-88-without-parent: un 88 senza campo padre va segnalato; un 88 sotto
  // un campo valido no.
  // ---------------------------------------------------------------------------
  const l88OrphanLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-L88.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '          88 WS-FLAG-ON          VALUE 1.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(l88OrphanLines.join('\n'), workDir), l88OrphanLines, 'level-88-without-parent', '88 WS-FLAG-ON'),
    'Atteso level-88-without-parent su un 88 senza campo padre'
  );

  const l88OkLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-L88OK.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-FLAG               PIC 9(001).',
    '          88 WS-FLAG-ON          VALUE 1.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(l88OkLines.join('\n'), workDir).some(d => String(d.code) === 'level-88-without-parent'),
    'Non atteso level-88-without-parent quando il campo padre esiste'
  );

  // ---------------------------------------------------------------------------
  // move-truncation: MOVE alfanumerico piu' grande -> destinazione piu' piccola;
  // MOVE numerico con piu' cifre intere -> destinazione con meno cifre intere.
  // Un MOVE verso destinazione uguale o piu' grande non va segnalato.
  // ---------------------------------------------------------------------------
  const truncLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-TRUNC.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-BIG                PIC X(010).',
    '       01 WS-SMALL              PIC X(005).',
    '       01 WS-NUM-BIG            PIC 9(005).',
    '       01 WS-NUM-SMALL          PIC 9(003).',
    '       01 WS-OK                 PIC X(010).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE WS-BIG TO WS-SMALL.',
    '           MOVE WS-NUM-BIG TO WS-NUM-SMALL.',
    '           MOVE WS-BIG TO WS-OK.',
    '           GOBACK.',
    ''
  ];
  const truncDiags = runLinter(truncLines.join('\n'), workDir);
  assert(
    !!findDiagOnLine(truncDiags, truncLines, 'move-truncation', 'MOVE WS-BIG TO WS-SMALL'),
    'Atteso move-truncation su MOVE WS-BIG (10) TO WS-SMALL (5)'
  );
  assert(
    !!findDiagOnLine(truncDiags, truncLines, 'move-truncation', 'MOVE WS-NUM-BIG TO WS-NUM-SMALL'),
    'Atteso move-truncation su MOVE WS-NUM-BIG (5 cifre) TO WS-NUM-SMALL (3 cifre)'
  );
  assert(
    !findDiagOnLine(truncDiags, truncLines, 'move-truncation', 'MOVE WS-BIG TO WS-OK'),
    'Non atteso move-truncation quando la destinazione e\' della stessa dimensione (WS-OK)'
  );

  // ---------------------------------------------------------------------------
  // EXHIBIT NAMED / EXHIBIT CHANGED NAMED / READY TRACE / RESET TRACE: statement
  // di debug COBOL, non vanno mai segnalati come undefined-variable.
  // ---------------------------------------------------------------------------
  const exhibitLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-EXHIBIT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-CAMPO               PIC X(010).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           READY TRACE.',
    '           EXHIBIT NAMED WS-CAMPO.',
    '           EXHIBIT CHANGED NAMED WS-CAMPO.',
    '           RESET TRACE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(exhibitLines.join('\n'), workDir).some(d => d.code === 'undefined-variable'),
    'Non atteso undefined-variable su EXHIBIT/NAMED/CHANGED/READY/TRACE/RESET'
  );

  // ---------------------------------------------------------------------------
  // SKIP1/SKIP2/SKIP3: parole riservate della clausola ADVANCING del WRITE
  // (avanzamento di 1/2/3 righe in stampa), non sono variabili del programma.
  // ---------------------------------------------------------------------------
  const skipLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SKIP.',
    '       DATA DIVISION.',
    '       FILE SECTION.',
    '       FD  PRINT-FILE.',
    '       01 PRINT-REC              PIC X(080).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           WRITE PRINT-REC AFTER ADVANCING SKIP1.',
    '           WRITE PRINT-REC AFTER ADVANCING SKIP2.',
    '           WRITE PRINT-REC AFTER ADVANCING SKIP3.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(skipLines.join('\n'), workDir).some(d => d.code === 'undefined-variable'),
    'Non atteso undefined-variable su SKIP1/SKIP2/SKIP3 (ADVANCING)'
  );

  // ---------------------------------------------------------------------------
  // Header di SECTION ("INIZIO SECTION."): il nome della section non e' una
  // variabile e non deve essere segnalato come undefined-variable.
  // ---------------------------------------------------------------------------
  const sectionHeaderLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SEZ.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-CAMPO               PIC X(010).',
    '       PROCEDURE DIVISION.',
    '       INIZIO SECTION.',
    '           MOVE SPACES TO WS-CAMPO.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(sectionHeaderLines.join('\n'), workDir).some(d => d.code === 'undefined-variable'),
    'Non atteso undefined-variable sul nome della SECTION (es. INIZIO SECTION.)'
  );

  // ---------------------------------------------------------------------------
  // "ID DIVISION." e' un alias valido di "IDENTIFICATION DIVISION.": le righe
  // tipiche della IDENTIFICATION DIVISION (PROGRAM-ID/AUTHOR) non vanno
  // segnalate come chars-after-period.
  // ---------------------------------------------------------------------------
  const idDivisionLines = [
    '       ID DIVISION.',
    '       PROGRAM-ID. PGM-IDDIV.',
    '       AUTHOR. TEST.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(idDivisionLines.join('\n'), workDir).some(d => d.code === 'chars-after-period'),
    'Non atteso chars-after-period quando la IDENTIFICATION DIVISION e\' abbreviata in "ID DIVISION."'
  );

  // ---------------------------------------------------------------------------
  // CURRENT-DATE (registro speciale) ed EIBRCODE (campo EIB CICS) non sono
  // variabili del programma: non vanno segnalati come undefined-variable.
  // ---------------------------------------------------------------------------
  const currentDateLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CURDATE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 CD-DATA                PIC X(021).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE CURRENT-DATE TO CD-DATA.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(currentDateLines.join('\n'), workDir).some(d => d.code === 'undefined-variable'),
    'Non atteso undefined-variable su CURRENT-DATE (registro speciale)'
  );

  const eibLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-EIB.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 ERCO-COD               PIC X(002).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE EIBRCODE TO ERCO-COD.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(eibLines.join('\n'), workDir).some(d => d.code === 'undefined-variable'),
    'Non atteso undefined-variable su EIBRCODE (campo EIB CICS)'
  );

  // ---------------------------------------------------------------------------
  // DFHRESP(NORMAL) / DFHVALUE(NOTFND): l'argomento e' una condizione di ritorno
  // CICS, non una variabile del programma: non va segnalato undefined-variable.
  // ---------------------------------------------------------------------------
  const dfhrespLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DFHRESP.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-RESP-CODE           PIC 9(009) COMP.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           EVALUATE WS-RESP-CODE',
    '               WHEN DFHRESP(NORMAL)',
    '                   CONTINUE',
    '               WHEN DFHVALUE(NOTFND)',
    '                   CONTINUE',
    '           END-EVALUATE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(dfhrespLines.join('\n'), workDir).some(d => d.code === 'undefined-variable'),
    'Non atteso undefined-variable per le condizioni dentro DFHRESP()/DFHVALUE()'
  );

  console.log('OK - test regressione linter superati');
  console.log(`Origine fixed: ${fixedSource}`);
  console.log(`Origine variable: ${variableSource}`);
  console.log(`Copie di lavoro: ${workDir}`);
}

function runLayoutTests() {
  const { computeFieldSize } = require('../src/cobol-layout');

  // Gruppo WS-SAVE-CHIAVE come da richiesta (somma dei campi 02 = 22 byte)
  const groupSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-LAYOUT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-SAVE-CHIAVE.',
    '           02 WS-SAVE-CODSOC          PIC X(004) VALUE SPACES.',
    '           02 WS-SAVE-FIL-1           PIC X(001) VALUE SPACES.',
    '           02 WS-SAVE-CODFIL          PIC X(004) VALUE SPACES.',
    '           02 WS-SAVE-FIL-2           PIC X(001) VALUE SPACES.',
    '           02 WS-SAVE-LIBPAG          PIC X(002) VALUE SPACES.',
    '           02 WS-SAVE-FIL-3           PIC X(001) VALUE SPACES.',
    '           02 WS-SAVE-QUALIF          PIC X(002) VALUE SPACES.',
    '           02 WS-SAVE-FIL-4           PIC X(001) VALUE SPACES.',
    '           02 WS-SAVE-MATR            PIC X(006) VALUE SPACES.',
    ''
  ].join('\n');
  const groupLines = groupSrc.split(/\r?\n/);

  const groupSize = computeFieldSize(groupLines, 4); // riga 0-based di WS-SAVE-CHIAVE
  assert(groupSize && groupSize.isGroup, 'WS-SAVE-CHIAVE deve essere riconosciuto come gruppo');
  assert(groupSize.size === 22, `Dimensione gruppo WS-SAVE-CHIAVE attesa 22, ottenuta ${groupSize && groupSize.size}`);

  const elemSize = computeFieldSize(groupLines, 5); // WS-SAVE-CODSOC PIC X(004)
  assert(elemSize && !elemSize.isGroup && elemSize.size === 4,
    `Dimensione WS-SAVE-CODSOC attesa 4, ottenuta ${elemSize && elemSize.size}`);

  // COMP-3, COMP, OCCURS, REDEFINES, FILLER, sottogruppi annidati, SIGN SEPARATE
  const mixSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-MIX.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-PACK                    PIC S9(7) COMP-3.',          // 4 byte (7 cifre -> floor(7/2)+1)
    '       01 WS-BIN-SMALL               PIC 9(4) COMP.',            // 2 byte
    '       01 WS-BIN-MED                 PIC 9(9) COMP.',            // 4 byte
    '       01 WS-BIN-BIG                 PIC 9(18) COMP.',           // 8 byte
    '       01 WS-NUM-V                   PIC S9(5)V99.',             // DISPLAY: 7 byte (V e S non contano)
    '       01 WS-SIGN-SEP               PIC S9(3) SIGN LEADING SEPARATE.', // 3 cifre + 1 segno = 4
    '       01 WS-TAB.',
    '           05 WS-TAB-EL              PIC X(010) OCCURS 5 TIMES.', // gruppo: 10 * 5 = 50
    '       01 WS-GRP.',
    '           05 WS-A                   PIC X(003).',
    '           05 WS-B                   PIC X(002).',
    '           05 WS-B-RED REDEFINES WS-B PIC X(002).',              // REDEFINES non si somma
    '           05 WS-FILL                PIC X(004).',               // FILLER-like, conteggiato
    '           05 WS-INNER.',
    '               10 WS-INNER-A         PIC 9(002).',
    '               10 WS-INNER-B         PIC 9(003).',
    ''
  ].join('\n');
  const mixLines = mixSrc.split(/\r?\n/);

  function sizeOf(name) {
    const re = new RegExp('\\b' + name.replace(/-/g, '\\-') + '\\b');
    const lineIdx = mixLines.findIndex(l => re.test(l));
    const r = computeFieldSize(mixLines, lineIdx);
    return r ? r.size : undefined;
  }

  assert(sizeOf('WS-PACK') === 4, `WS-PACK COMP-3 atteso 4, ottenuto ${sizeOf('WS-PACK')}`);
  assert(sizeOf('WS-BIN-SMALL') === 2, `WS-BIN-SMALL COMP atteso 2, ottenuto ${sizeOf('WS-BIN-SMALL')}`);
  assert(sizeOf('WS-BIN-MED') === 4, `WS-BIN-MED COMP atteso 4, ottenuto ${sizeOf('WS-BIN-MED')}`);
  assert(sizeOf('WS-BIN-BIG') === 8, `WS-BIN-BIG COMP atteso 8, ottenuto ${sizeOf('WS-BIN-BIG')}`);
  assert(sizeOf('WS-NUM-V') === 7, `WS-NUM-V DISPLAY atteso 7, ottenuto ${sizeOf('WS-NUM-V')}`);
  assert(sizeOf('WS-SIGN-SEP') === 4, `WS-SIGN-SEP atteso 4, ottenuto ${sizeOf('WS-SIGN-SEP')}`);
  assert(sizeOf('WS-TAB') === 50, `WS-TAB OCCURS atteso 50, ottenuto ${sizeOf('WS-TAB')}`);
  // WS-GRP: WS-A(3) + WS-B(2) + [WS-B-RED escluso] + WS-FILL(4) + WS-INNER(2+3=5) = 14
  assert(sizeOf('WS-GRP') === 14, `WS-GRP gruppo atteso 14, ottenuto ${sizeOf('WS-GRP')}`);
  assert(sizeOf('WS-INNER') === 5, `WS-INNER sottogruppo atteso 5, ottenuto ${sizeOf('WS-INNER')}`);

  // Definizione su piu' righe fisiche (riga di continuazione con la PIC)
  const contSrc = [
    '       WORKING-STORAGE SECTION.',
    '       01 WS-MULTI',
    '                    PIC X(010).',
    '       01 WS-NEXT                    PIC X(005).',
    ''
  ].join('\n');
  const contLines = contSrc.split(/\r?\n/);
  const contSize = computeFieldSize(contLines, 1); // WS-MULTI su riga 0-based 1
  assert(contSize && !contSize.isGroup && contSize.size === 10,
    `WS-MULTI multi-riga atteso 10, ottenuto ${contSize && contSize.size}`);

  // COPY annidata dentro un gruppo: i campi della copybook si sommano al gruppo
  const layoutCopyDir = path.join(workDir, 'Copy');
  ensureDir(layoutCopyDir);
  fs.writeFileSync(path.join(layoutCopyDir, 'LAYSUB'),
    [
      '      *-----------------------------------------------------------------',
      '       05 SUB-A                      PIC X(004).',
      '       05 SUB-B                      PIC X(006).',
      ''
    ].join('\n'), 'utf8');

  const nestSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NEST.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-OUTER.',
    '           05 WS-PRE                 PIC X(002).',
    '           COPY LAYSUB.',
    '           05 WS-POST                PIC X(003).',
    ''
  ].join('\n');
  const nestLines = nestSrc.split(/\r?\n/);
  const nestSize = computeFieldSize(nestLines, 4, workDir); // WS-OUTER su riga 0-based 4
  assert(nestSize && nestSize.isGroup && nestSize.size === 15,
    `WS-OUTER con COPY annidata atteso 15 (2 + 4 + 6 + 3), ottenuto ${nestSize && nestSize.size}`);

  // COPY sulla STESSA riga della definizione del gruppo: "01 WS-OUTER. COPY LAYSUB."
  const sameLineSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SAMELINE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-OUTER. COPY LAYSUB.',
    '           05 WS-PRE                 PIC X(002).',
    '           05 WS-POST                PIC X(003).',
    ''
  ].join('\n');
  const sameLineLines = sameLineSrc.split(/\r?\n/);
  const sameLineSize = computeFieldSize(sameLineLines, 4, workDir); // WS-OUTER su riga 0-based 4
  assert(sameLineSize && sameLineSize.isGroup && sameLineSize.size === 15,
    `WS-OUTER con COPY sulla stessa riga atteso 15 (4 + 6 + 2 + 3), ottenuto ${sameLineSize && sameLineSize.size}`);

  console.log('OK - test regressione layout (dimensioni) superati');
}

function runFormatterTests() {
  const { computeFormatted } = require('../src/cobol-formatter');

  function indentOf(line) {
    const m = line.match(/^(\s*)\S/);
    return m ? m[1].length : -1;
  }

  // EVALUATE/WHEN: i WHEN devono allinearsi alla colonna di EVALUATE (col 12,
  // indent 11) e gli statement del ramo WHEN rientrano di 3 (col 15, indent 14).
  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-EVAL.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '              EVALUATE TRUE',
    '                 WHEN A = 1',
    '                    MOVE 1 TO B',
    '                 WHEN OTHER',
    '                    MOVE 2 TO B',
    '              END-EVALUATE.',
    ''
  ];
  const procDefLines = new Set([3]); // riga 0-based del paragrafo MAIN

  const out = computeFormatted(src, procDefLines);

  const evalIdx = out.findIndex(l => /\bEVALUATE\b/.test(l) && !/END-EVALUATE/.test(l));
  const evalIndent = indentOf(out[evalIdx]);
  assert(evalIndent === 11, `EVALUATE atteso a colonna 12 (indent 11), ottenuto indent ${evalIndent}`);

  const when1Indent = indentOf(out[evalIdx + 1]);
  assert(when1Indent === evalIndent,
    `WHEN deve allinearsi a EVALUATE (indent ${evalIndent}), ottenuto ${when1Indent}`);

  const stmtIndent = indentOf(out[evalIdx + 2]);
  assert(stmtIndent === evalIndent + 3,
    `Statement sotto WHEN atteso a indent ${evalIndent + 3}, ottenuto ${stmtIndent}`);

  const when2Indent = indentOf(out[evalIdx + 3]);
  assert(when2Indent === evalIndent,
    `Secondo WHEN deve allinearsi a EVALUATE (indent ${evalIndent}), ottenuto ${when2Indent}`);

  const endEvalIdx = out.findIndex(l => /END-EVALUATE/.test(l));
  const endEvalIndent = indentOf(out[endEvalIdx]);
  assert(endEvalIndent === evalIndent,
    `END-EVALUATE deve allinearsi a EVALUATE (indent ${evalIndent}), ottenuto ${endEvalIndent}`);

  console.log('OK - test regressione formatter (EVALUATE/WHEN) superati');
}

function runSearchFormatterTests() {
  const { computeFormatted, formatDocument } = require('../src/cobol-formatter');

  function indentOf(line) {
    const m = line.match(/^(\s*)\S/);
    return m ? m[1].length : -1;
  }

  // SEARCH ALL / AT END / WHEN: AT END e WHEN rientrano di un livello sotto
  // SEARCH; gli statement dei rispettivi rami rientrano di un livello ulteriore.
  // END-SEARCH si allinea a SEARCH.
  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SRCH.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '              MOVE SPACES TO WS-CSV-QUALIFICA.',
    '              SEARCH ALL TAB-QUALIFICHE-ENTRY',
    '                 AT END',
    '                    CONTINUE',
    '                 WHEN TAB-QUAL-CODQUAL (TQ-IDX) = PGANAG-QUALIF-N',
    '                    MOVE TAB-QUAL-DESQUAL (TQ-IDX) TO WS-CSV-QUALIFICA',
    '              END-SEARCH.',
    ''
  ];
  const procDefLines = new Set([3]); // riga 0-based del paragrafo MAIN

  const out = computeFormatted(src, procDefLines);

  const searchIdx = out.findIndex(l => /\bSEARCH ALL\b/.test(l));
  const searchIndent = indentOf(out[searchIdx]);
  assert(searchIndent === 11, `SEARCH ALL atteso a colonna 12 (indent 11), ottenuto indent ${searchIndent}`);

  const atEndIndent = indentOf(out[searchIdx + 1]);
  assert(atEndIndent === searchIndent + 3,
    `AT END atteso a indent ${searchIndent + 3}, ottenuto ${atEndIndent}`);

  const continueIndent = indentOf(out[searchIdx + 2]);
  assert(continueIndent === searchIndent + 6,
    `CONTINUE (ramo AT END) atteso a indent ${searchIndent + 6}, ottenuto ${continueIndent}`);

  const whenIndent = indentOf(out[searchIdx + 3]);
  assert(whenIndent === atEndIndent,
    `WHEN deve allinearsi ad AT END (indent ${atEndIndent}), ottenuto ${whenIndent}`);

  const moveIndent = indentOf(out[searchIdx + 4]);
  assert(moveIndent === continueIndent,
    `Statement sotto WHEN atteso a indent ${continueIndent}, ottenuto ${moveIndent}`);

  const endSearchIdx = out.findIndex(l => /END-SEARCH/.test(l));
  const endSearchIndent = indentOf(out[endSearchIdx]);
  assert(endSearchIndent === searchIndent,
    `END-SEARCH deve allinearsi a SEARCH (indent ${searchIndent}), ottenuto ${endSearchIndent}`);

  // Stage 2 (righe vuote tra blocchi): una riga vuota prima di SEARCH ALL
  // (dopo il MOVE), ma NESSUNA riga vuota dentro il blocco SEARCH/AT END/WHEN.
  const doc = formatDocument(src, procDefLines, { blankLines: true });
  const searchIdx2 = doc.findIndex(l => /\bSEARCH ALL\b/.test(l));
  assert(doc[searchIdx2 - 1].trim() === '',
    'deve esserci una riga vuota prima di SEARCH ALL (statement precedente diverso)');
  const endSearchIdx2 = doc.findIndex(l => /END-SEARCH/.test(l));
  for (let k = searchIdx2 + 1; k <= endSearchIdx2; k++) {
    assert(doc[k].trim() !== '',
      `nessuna riga vuota attesa dentro il blocco SEARCH (trovata alla riga ${k})`);
  }

  console.log('OK - test regressione formatter (SEARCH/AT END/WHEN) superati');
}

function runSignatureTests() {
  const { getSignatureAt, COBOL_INTRINSICS } = require('../src/cobol-signatures');

  // Funzione semplice a un argomento: cursore dentro le parentesi.
  const l1 = "           COMPUTE R = FUNCTION SQRT(WS-X";
  const s1 = getSignatureAt(l1, l1.length);
  assert(s1 && s1.name === 'SQRT', 'Attesa signature SQRT dentro FUNCTION SQRT(...)');
  assert(s1.params.length === 1 && s1.activeParameter === 0,
    'SQRT: un solo parametro, attivo il primo');

  // Funzione a due argomenti: dopo la virgola il parametro attivo diventa il 2o.
  const l2 = "           COMPUTE R = FUNCTION MOD(A, B";
  const s2 = getSignatureAt(l2, l2.length);
  assert(s2 && s2.name === 'MOD', 'Attesa signature MOD');
  assert(s2.activeParameter === 1, 'MOD: dopo la virgola il parametro attivo e\' il secondo');

  // Prima della virgola il parametro attivo e' il primo.
  const l2a = "           COMPUTE R = FUNCTION MOD(A";
  const s2a = getSignatureAt(l2a, l2a.length);
  assert(s2a && s2a.activeParameter === 0, 'MOD: prima della virgola il parametro attivo e\' il primo');

  // Variadica: molte virgole non superano l'ultimo parametro "aperto".
  const l3 = "           COMPUTE R = FUNCTION MAX(A, B, C, D";
  const s3 = getSignatureAt(l3, l3.length);
  assert(s3 && s3.name === 'MAX', 'Attesa signature MAX');
  assert(s3.params.length === 2 && s3.activeParameter === 1,
    'MAX: variadica, il parametro attivo resta il secondo (aperto)');

  // Annidamento: cursore dentro la funzione interna.
  const l4 = "           COMPUTE R = FUNCTION MOD(FUNCTION ABS(WS-Y";
  const s4 = getSignatureAt(l4, l4.length);
  assert(s4 && s4.name === 'ABS', 'Annidamento: attesa la funzione interna ABS');

  // Dopo la chiusura della funzione interna si torna a quella esterna.
  const l5 = "           COMPUTE R = FUNCTION MOD(FUNCTION ABS(WS-Y), ";
  const s5 = getSignatureAt(l5, l5.length);
  assert(s5 && s5.name === 'MOD' && s5.activeParameter === 1,
    'Dopo la chiusura di ABS si torna a MOD con parametro attivo 2');

  // Virgola dentro un letterale stringa NON deve contare come separatore.
  const l6 = "           COMPUTE R = FUNCTION MOD('A,B' ";
  const s6 = getSignatureAt(l6, l6.length);
  assert(s6 && s6.name === 'MOD' && s6.activeParameter === 0,
    'La virgola dentro un letterale non deve incrementare il parametro attivo');

  // Nome non presente in tabella: nessuna signature.
  const l7 = "           COMPUTE R = FUNCTION FOOBAR(X";
  assert(getSignatureAt(l7, l7.length) === null,
    'Funzione sconosciuta: nessuna signature');

  // Riga senza FUNCTION: nessuna signature.
  const l8 = "           MOVE (A) TO B";
  assert(getSignatureAt(l8, l8.length) === null,
    'Parentesi non di FUNCTION: nessuna signature');

  assert(!!COBOL_INTRINSICS['LENGTH'] && !!COBOL_INTRINSICS['NUMVAL'],
    'La tabella intrinseche deve contenere LENGTH e NUMVAL');

  // Nuove funzioni aggiunte (standard 2014/2023 + Micro Focus/Rocket).
  assert(!!COBOL_INTRINSICS['CONCATENATE'] && !!COBOL_INTRINSICS['PI']
    && !!COBOL_INTRINSICS['FORMATTED-DATE'] && !!COBOL_INTRINSICS['TEST-NUMVAL']
    && !!COBOL_INTRINSICS['ULENGTH'] && !!COBOL_INTRINSICS['SIGN'],
    'La tabella intrinseche deve contenere le nuove funzioni (CONCATENATE, PI, FORMATTED-DATE, TEST-NUMVAL, ULENGTH, SIGN)');
  assert(Object.keys(COBOL_INTRINSICS).length >= 80,
    'La tabella intrinseche deve contenere almeno 80 funzioni');

  // PI: nessun parametro; la firma deve comunque essere risolta.
  const lpi = "           COMPUTE R = FUNCTION PI(";
  const spi = getSignatureAt(lpi, lpi.length);
  assert(spi && spi.name === 'PI' && spi.params.length === 0,
    'PI: funzione senza parametri');

  console.log('OK - test regressione signature help superati');
}

function runCallNavigationTests() {
  const { parseCallStatement, resolveProgramPath } = require('../src/cobol-parser');

  // CALL letterale con apici singoli.
  const c1 = "           CALL 'PGMABC' USING WS-X.";
  const r1 = parseCallStatement(c1);
  assert(r1 && r1.name === 'PGMABC' && r1.isLiteral === true,
    "CALL 'PGMABC': nome PGMABC come letterale");
  assert(c1.substr(r1.nameStart, r1.name.length) === 'PGMABC',
    'CALL letterale: nameStart deve puntare al nome');

  // CALL letterale con apici doppi.
  const c2 = '           CALL "SUBPROG".';
  const r2 = parseCallStatement(c2);
  assert(r2 && r2.name === 'SUBPROG' && r2.isLiteral === true,
    'CALL "SUBPROG": nome SUBPROG come letterale');

  // CALL a variabile (identificatore).
  const c3 = '           CALL WS-PROGRAMMA.';
  const r3 = parseCallStatement(c3);
  assert(r3 && r3.name === 'WS-PROGRAMMA' && r3.isLiteral === false,
    'CALL WS-PROGRAMMA: identificatore, non letterale');
  assert(c3.substr(r3.nameStart, r3.name.length) === 'WS-PROGRAMMA',
    'CALL variabile: nameStart deve puntare al nome');

  // Riga di commento: nessuna CALL.
  assert(parseCallStatement("      * CALL 'PGMABC'.") === undefined,
    'CALL in riga di commento: ignorata');

  // END-CALL da solo: non e\' una CALL.
  assert(parseCallStatement('           END-CALL.') === undefined,
    'END-CALL non deve essere interpretato come CALL');

  // Risoluzione del percorso programma su file reale nella work dir.
  ensureDir(workDir);
  const progPath = path.join(workDir, 'PGMABC.CBL');
  fs.writeFileSync(progPath, '       IDENTIFICATION DIVISION.\n', 'utf8');
  const resolved = resolveProgramPath('PGMABC', workDir);
  assert(resolved === progPath,
    `resolveProgramPath deve trovare PGMABC.CBL (ottenuto: ${resolved})`);
  assert(resolveProgramPath('NON-ESISTE-XYZ', workDir) === undefined,
    'resolveProgramPath deve restituire undefined per un programma inesistente');

  console.log('OK - test regressione navigazione CALL superati');
}

function runCopybookFormatterTests() {
  const { computeFormatted } = require('../src/cobol-formatter');

  function indentOf(line) {
    const m = line.match(/^(\s*)\S/);
    return m ? m[1].length : -1;
  }
  function picCol(line) {
    return line.toUpperCase().indexOf('PIC ');
  }

  // Copybook SENZA intestazione DATA DIVISION (solo tracciato dati), con
  // spaziatura piatta: il formattatore deve comunque indentare per livello di
  // annidamento e allineare le clausole PIC alla colonna 45.
  const src = [
    '      * Copybook tracciato di prova',
    '       01 PG-AREA.',
    '       05 PG-FLAG PIC X.',
    '       05 PG-CHIAVE.',
    '       08 PG-CODICE-TABN.',
    '       10 PG-CODICE PIC X(08).',
    '       10 FILLER PIC X(08).',
    '       05 PG-DATI PIC X(4000).',
    '       05 FILLER REDEFINES PG-DATI.',
    '       08 PG-ELEM OCCURS 150.',
    '       10 PG-VOCE PIC X(04).',
    "       88 PG-VOCE-OK VALUE 'A'.",
    ''
  ];
  const out = computeFormatted(src, new Set());

  const l01 = out.find(l => /\bPG-AREA\b/.test(l));
  assert(indentOf(l01) === 7,
    `01 PG-AREA atteso a colonna 8 (indent 7), ottenuto ${indentOf(l01)}`);

  const lFlag = out.find(l => /\bPG-FLAG\b/.test(l));
  assert(indentOf(lFlag) === 10,
    `05 PG-FLAG atteso a indent 10, ottenuto ${indentOf(lFlag)}`);

  const lTabn = out.find(l => /\bPG-CODICE-TABN\b/.test(l));
  assert(indentOf(lTabn) === 13,
    `08 PG-CODICE-TABN atteso a indent 13, ottenuto ${indentOf(lTabn)}`);

  const lCod = out.find(l => /\bPG-CODICE\b/.test(l) && !/TABN/.test(l));
  assert(indentOf(lCod) === 16,
    `10 PG-CODICE atteso a indent 16, ottenuto ${indentOf(lCod)}`);
  assert(picCol(lCod) === 44,
    `PIC di PG-CODICE atteso a colonna 45 (index 44), ottenuto ${picCol(lCod)}`);

  const lDati = out.find(l => /\bPG-DATI\b/.test(l) && !/REDEFINES/.test(l));
  assert(indentOf(lDati) === 10,
    `05 PG-DATI atteso a indent 10 (ritorno al livello 05), ottenuto ${indentOf(lDati)}`);

  const l88 = out.find(l => /\bPG-VOCE-OK\b/.test(l));
  assert(indentOf(l88) === 19,
    `88 PG-VOCE-OK atteso a indent 19, ottenuto ${indentOf(l88)}`);

  console.log('OK - test regressione formatter copybook superati');
}

function runConditionNameTests() {
  const { parseDataLevel, parseValueClause, findConditionNames, findConditionParent } =
    require('../src/cobol-parser');

  const lines = [
    '       01 WS-STATO          PIC X(01).',
    "           88 WS-STATO-OK    VALUE 'A'.",
    "           88 WS-STATO-KO    VALUE 'B' 'C'.",
    '       01 WS-ALTRO          PIC 9(02).',
    '           88 WS-RANGE       VALUE 1 THRU 9.',
    ''
  ];

  // parseDataLevel
  const dl = parseDataLevel(lines[0]);
  assert(dl && dl.level === 1 && dl.name === 'WS-STATO',
    'parseDataLevel deve estrarre livello 1 e nome WS-STATO');
  assert(parseDataLevel('      * commento') === undefined,
    'parseDataLevel deve ignorare i commenti');

  // parseValueClause
  assert(parseValueClause(lines[2]) === "'B' 'C'",
    `parseValueClause atteso "'B' 'C'", ottenuto ${parseValueClause(lines[2])}`);
  assert(parseValueClause(lines[4]) === '1 THRU 9',
    `parseValueClause atteso "1 THRU 9", ottenuto ${parseValueClause(lines[4])}`);

  // findConditionNames sul campo padre
  const conds = findConditionNames(lines, 0);
  assert(conds.length === 2, `Attesi 2 condition-name su WS-STATO, ottenuti ${conds.length}`);
  assert(conds[0].name === 'WS-STATO-OK' && conds[0].value === "'A'",
    'Primo condition-name atteso WS-STATO-OK = \'A\'');
  assert(conds[1].name === 'WS-STATO-KO' && conds[1].value === "'B' 'C'",
    'Secondo condition-name atteso WS-STATO-KO = \'B\' \'C\'');

  // Non deve sconfinare nel campo successivo.
  const conds2 = findConditionNames(lines, 3);
  assert(conds2.length === 1 && conds2[0].name === 'WS-RANGE',
    'WS-ALTRO deve avere solo WS-RANGE come condition-name');

  // Un 88 non ha condition-name propri.
  assert(findConditionNames(lines, 1).length === 0,
    'Un condition-name (88) non deve avere a sua volta condition-name');

  // findConditionParent
  const p1 = findConditionParent(lines, 1);
  assert(p1 && p1.name === 'WS-STATO', 'Il padre di WS-STATO-OK deve essere WS-STATO');
  const p2 = findConditionParent(lines, 4);
  assert(p2 && p2.name === 'WS-ALTRO', 'Il padre di WS-RANGE deve essere WS-ALTRO');

  console.log('OK - test regressione condition-name (88) superati');
}

function runExpandCopyTests() {
  const { expandCopyText } = require('../src/cobol-parser');

  const copybooks = {
    'CHILD': [
      '       05 CH-A            PIC X(01).',
      '       COPY GRAND.',
      '       05 CH-B            PIC 9(02).'
    ].join('\n'),
    'GRAND': [
      '       10 GR-X            PIC X(03).'
    ].join('\n'),
    'PFXCOPY': [
      '       01 :PFX:-FIELD     PIC X(05).'
    ].join('\n'),
    'SELFREF': [
      '       01 SELF-A          PIC X.',
      '       COPY SELFREF.'
    ].join('\n')
  };
  const resolve = (name) => copybooks[name.toUpperCase()] ? '/fake/' + name.toUpperCase() : undefined;
  const read = (p) => {
    const name = p.replace('/fake/', '');
    if (copybooks[name]) return copybooks[name];
    throw new Error('not found ' + p);
  };

  // 1) Espansione semplice + annidata (senza marcatori).
  const main = [
    '       01 WS-REC.',
    '       COPY CHILD.',
    '       01 WS-END           PIC X.'
  ];
  const out = expandCopyText(main, '/root', { resolve, read, markers: false });
  const joined = out.join('\n');
  assert(/CH-A/.test(joined) && /CH-B/.test(joined), 'La COPY CHILD deve essere espansa');
  assert(/GR-X/.test(joined), 'La COPY GRAND annidata deve essere espansa');
  assert(!/COPY\s+CHILD/i.test(joined), "La riga COPY CHILD non deve piu' comparire");
  assert(/WS-END/.test(joined), 'Le righe dopo la COPY devono restare');

  // 2) REPLACING pseudo-testo.
  const mainRepl = ['       COPY PFXCOPY REPLACING ==:PFX:== BY ==WS-CUST==.'];
  const outRepl = expandCopyText(mainRepl, '/root', { resolve, read, markers: false }).join('\n');
  assert(/WS-CUST-FIELD/.test(outRepl), 'REPLACING deve sostituire :PFX: con WS-CUST');
  assert(!/:PFX:/.test(outRepl), 'Il pseudo-testo :PFX: non deve restare');

  // 3) COPY sulla stessa riga di altro codice: il prefisso va preservato.
  const mainInline = ['       01 WS-OUTER. COPY GRAND.'];
  const outInline = expandCopyText(mainInline, '/root', { resolve, read, markers: false }).join('\n');
  assert(/WS-OUTER/.test(outInline), 'Il prefisso 01 WS-OUTER deve essere preservato');
  assert(/GR-X/.test(outInline), 'La COPY GRAND inline deve essere espansa');

  // 4) COPY non trovata: riga originale + marcatore.
  const outMissing = expandCopyText(['       COPY NON-ESISTE.'], '/root',
    { resolve, read, markers: true }).join('\n');
  assert(/COPY\s+NON-ESISTE/i.test(outMissing), 'La COPY non trovata deve restare invariata');
  assert(/non trovata/.test(outMissing), 'Deve comparire il marcatore "non trovata"');

  // 5) Ricorsione: una COPY che include se stessa non deve andare in loop.
  const outSelf = expandCopyText(['       COPY SELFREF.'], '/root',
    { resolve, read, markers: true }).join('\n');
  assert(/SELF-A/.test(outSelf), 'La COPY SELFREF deve essere espansa una volta');
  assert(/ricorsione/.test(outSelf), 'La ricorsione deve essere segnalata e interrotta');

  console.log('OK - test regressione espansione COPY superati');
}

function runUsageSizeTests() {
  const { computeFieldSize } = require('../src/cobol-layout');

  const lines = [
    '       01 WS-REC.',
    '       05 WS-DATA-COMP.',
    '       10 WS-ANNO-COMP    PIC 9(004).',
    '       10 WS-MESE-COMP    PIC 9(002).',
    '       10 WS-GIOR-COMP    PIC 9(002).',
    '       05 WS-BIN          PIC 9(004) COMP.',
    '       05 WS-PACK         PIC 9(005) COMP-3.',
    '       05 WS-BINARY-FLAG  PIC X(002).',
    '       05 WS-INDEX-KEY    PIC 9(003).',
    ''
  ];

  // Regressione: nomi con suffisso "-COMP" NON devono essere trattati come
  // USAGE COMP. Il gruppo WS-DATA-COMP e' DISPLAY: 4+2+2 = 8 byte (era 6).
  const grp = computeFieldSize(lines, 1, undefined);
  assert(grp && grp.isGroup && grp.size === 8,
    `WS-DATA-COMP atteso 8 byte (DISPLAY 4+2+2), ottenuto ${grp && grp.size}`);

  const anno = computeFieldSize(lines, 2, undefined);
  assert(anno && anno.size === 4,
    `WS-ANNO-COMP 9(004) atteso 4 byte (DISPLAY), ottenuto ${anno && anno.size}`);

  // USAGE COMP reale: 9(4) COMP = 2 byte.
  const bin = computeFieldSize(lines, 5, undefined);
  assert(bin && bin.size === 2,
    `WS-BIN 9(004) COMP atteso 2 byte, ottenuto ${bin && bin.size}`);

  // COMP-3 reale: 9(5) COMP-3 = floor(5/2)+1 = 3 byte.
  const pack = computeFieldSize(lines, 6, undefined);
  assert(pack && pack.size === 3,
    `WS-PACK 9(005) COMP-3 atteso 3 byte, ottenuto ${pack && pack.size}`);

  // Nome con "BINARY" ma DISPLAY: X(2) = 2 byte (non trattato come BINARY).
  const bf = computeFieldSize(lines, 7, undefined);
  assert(bf && bf.size === 2,
    `WS-BINARY-FLAG X(002) atteso 2 byte (DISPLAY), ottenuto ${bf && bf.size}`);

  // Nome con "INDEX" ma DISPLAY: 9(3) = 3 byte (non trattato come INDEX = 4).
  const ix = computeFieldSize(lines, 8, undefined);
  assert(ix && ix.size === 3,
    `WS-INDEX-KEY 9(003) atteso 3 byte (DISPLAY), ottenuto ${ix && ix.size}`);

  console.log('OK - test regressione usage/dimensioni (COMP nel nome) superati');
}

function runExecBlockTests() {
  const { findExecBlocks } = require('../src/cobol-parser');

  const lines = [
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           EXEC SQL',
    '              SELECT COD INTO :WS-COD',
    '              FROM TAB',
    '           END-EXEC.',
    '           EXEC CICS SEND MAP(\'M\') END-EXEC.',
    '           EXEC SQL',
    '              COMMIT',
    '           END-EXEC.',
    '           STOP RUN.',
    ''
  ];

  const blocks = findExecBlocks(lines);
  assert(blocks.length === 2,
    `Attesi 2 blocchi EXEC multi-riga, ottenuti ${blocks.length}`);
  assert(blocks[0].start === 2 && blocks[0].end === 5,
    `Primo blocco EXEC SQL atteso [2,5], ottenuto [${blocks[0].start},${blocks[0].end}]`);
  assert(blocks[1].start === 7 && blocks[1].end === 9,
    `Secondo blocco EXEC SQL atteso [7,9], ottenuto [${blocks[1].start},${blocks[1].end}]`);

  // EXEC CICS su una sola riga (riga 6): non deve generare un blocco.
  assert(!blocks.some(b => b.start === 6),
    'Un EXEC ... END-EXEC su riga singola non deve produrre un blocco ripiegabile');

  console.log('OK - test regressione blocchi EXEC superati');
}

function runOdoTests() {
  const { runLinter } = require('../src/cobol-linter');
  const { collectLayout, detectDependingOn } = require('../src/cobol-layout');

  // detectDependingOn estrae l'oggetto della clausola.
  assert(detectDependingOn('05 T-EL OCCURS 1 TO 10 DEPENDING ON WS-N PIC X.') === 'WS-N',
    'detectDependingOn deve estrarre WS-N');
  assert(detectDependingOn('05 T-EL OCCURS 10 PIC X.') === null,
    'detectDependingOn deve restituire null senza DEPENDING ON');

  // Layout: l'item ODO deve avere dependingOn e occursMin popolati.
  const odoSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-ODO.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-CNT               PIC 9(003).',
    '       01 WS-TAB.',
    '           05 WS-EL OCCURS 1 TO 10 DEPENDING ON WS-CNT PIC X(005).',
    ''
  ];
  const layout = collectLayout(odoSrc, undefined);
  const elItem = layout.find(it => it.name === 'WS-EL');
  assert(elItem && elItem.dependingOn === 'WS-CNT',
    `Layout WS-EL deve avere dependingOn=WS-CNT, ottenuto ${elItem && elItem.dependingOn}`);
  assert(elItem && elItem.occursMin === 1 && elItem.occurs === 10,
    `Layout WS-EL atteso occursMin=1 occurs=10, ottenuto ${elItem && elItem.occursMin}/${elItem && elItem.occurs}`);

  // odo-not-last: una tabella ODO seguita da un campo con storage nello stesso
  // record va segnalata.
  const odoBadLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-ODOBAD.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-CNT               PIC 9(003).',
    '       01 WS-REC.',
    '           05 WS-EL OCCURS 1 TO 10 DEPENDING ON WS-CNT PIC X(005).',
    '           05 WS-AFTER         PIC X(002).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(odoBadLines.join('\n'), workDir), odoBadLines, 'odo-not-last', 'WS-EL OCCURS 1 TO 10'),
    'Atteso odo-not-last su WS-EL seguita da WS-AFTER nello stesso record'
  );

  // odo-not-last: se la tabella ODO e' l'ultimo campo del record, nessun errore.
  const odoOkLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-ODOOK.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-CNT               PIC 9(003).',
    '       01 WS-REC.',
    '           05 WS-HEAD          PIC X(004).',
    '           05 WS-EL OCCURS 1 TO 10 DEPENDING ON WS-CNT PIC X(005).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(odoOkLines.join('\n'), workDir).some(d => String(d.code) === 'odo-not-last'),
    'Non atteso odo-not-last quando la tabella ODO e\' l\'ultimo campo del record'
  );

  // unused-variable: l'oggetto di OCCURS ... DEPENDING ON e' "usato" dalla
  // tabella anche se non compare (ancora) nella PROCEDURE DIVISION.
  assert(
    !runLinter(odoOkLines.join('\n'), workDir).some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-CNT'),
    'Non atteso unused-variable su WS-CNT quando e\' l\'oggetto di OCCURS ... DEPENDING ON'
  );

  // unused-variable: un gruppo/REDEFINES di livello > 1 (es. livello 10) i
  // cui sotto-campi sono usati in PROCEDURE DIVISION non va segnalato come
  // non utilizzato, anche se il nome del gruppo stesso non compare mai.
  const redefGroupLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-REDEFGRP.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-REC.',
    '           05 WS-IMPEGNI               PIC X(650).',
    '           05 WS-IMP-R REDEFINES WS-IMPEGNI.',
    '               10 WS-IMP-EL OCCURS 5.',
    '                   15 WS-IMP-BENEF     PIC X(080).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           DISPLAY WS-IMP-BENEF(1).',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(redefGroupLines.join('\n'), workDir).some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-IMP-R'),
    'Non atteso unused-variable su WS-IMP-R (REDEFINES di livello > 1) quando un suo sotto-campo e\' usato'
  );

  // unused-variable: se INVECE nessun sotto-campo del gruppo e' mai usato,
  // va segnalato anche il gruppo (livello 01), non solo i suoi campi.
  const deadGroupLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DEADGRP.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-CAMPI.',
    '           02 WS-MAI-USATO-1       PIC X(080).',
    '           02 WS-MAI-USATO-2       PIC X(080).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  const deadGroupDiags = runLinter(deadGroupLines.join('\n'), workDir);
  assert(
    deadGroupDiags.some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-CAMPI'),
    'Atteso unused-variable su WS-CAMPI quando nessun suo sotto-campo e\' mai usato'
  );
  assert(
    deadGroupDiags.some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-MAI-USATO-1'),
    'Atteso unused-variable su WS-MAI-USATO-1 (campo mai usato)'
  );

  console.log('OK - test regressione OCCURS DEPENDING ON superati');
}

function runRedefinesEditedPicTests() {
  const { runLinter } = require('../src/cobol-linter');

  // PIC con caratteri di inserimento (virgola, punto, barra): ogni carattere
  // occupa 1 byte. 99,99 = 5 byte, non 2.
  const okLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-REDPIC.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-REC.',
    '           02 R-DESMATX.',
    '              03 R-DESMATF     PIC X(20).',
    '              03 FILLER        PIC X(01).',
    '           02 FILLER REDEFINES R-DESMATX.',
    '              03 R-DESMAT-MDT  PIC X(16).',
    '              03 R-NUMSCA-MDT  PIC 99,99.',
    '              03 FILLER REDEFINES R-NUMSCA-MDT.',
    '                 04 R-NUMSCA-MDT-I  PIC 99.',
    '                 04 R-NUMSCA-MDT-D  PIC XXX.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  const okDiags = runLinter(okLines.join('\n'), workDir)
    .filter(d => String(d.code) === 'redefines-size');
  assert(okDiags.length === 0,
    'Non atteso redefines-size con PIC 99,99 (5 byte): ' + okDiags.map(d => d.message).join(' | '));

  // Caso davvero errato: la ridefinizione occupa 1 byte in PIU' dell'originale
  // (COBOL vieta solo questo verso: la ridefinizione non puo' essere piu' grande).
  const koLines = okLines.slice();
  koLines[9] = '              03 R-DESMAT-MDT  PIC X(17).';
  const koDiags = runLinter(koLines.join('\n'), workDir)
    .filter(d => String(d.code) === 'redefines-size');
  assert(koDiags.length > 0, 'Atteso redefines-size quando la ridefinizione e\' piu\' grande dell\'originale');

  // Anche una ridefinizione PIU' PICCOLA va segnalata: il compilatore MF la rifiuta.
  const smallerLines = okLines.slice();
  smallerLines[9] = '              03 R-DESMAT-MDT  PIC X(15).';
  const smallerDiags = runLinter(smallerLines.join('\n'), workDir)
    .filter(d => String(d.code) === 'redefines-size');
  assert(smallerDiags.length > 0,
    'Atteso redefines-size anche quando la ridefinizione e\' piu\' piccola dell\'originale');

  console.log('OK - test regressione redefines-size con PIC editate superati');
}

function runCopyTreeTests() {
  const { buildCopyTree } = require('../src/cobol-copytree');

  const files = {
    '/root/MAIN.CBL': [
      '       01 WS-REC.',
      '       COPY CHILD.',
      '       COPY MISSING.'
    ].join('\n'),
    '/fake/CHILD': [
      '       05 CH-A            PIC X.',
      '       COPY GRAND.'
    ].join('\n'),
    '/fake/GRAND': [
      '       10 GR-X            PIC X.',
      '       COPY CHILD.'
    ].join('\n')
  };
  const resolve = (name) => {
    const key = name.toUpperCase();
    return files['/fake/' + key] ? '/fake/' + key : undefined;
  };
  const read = (p) => {
    if (files[p]) return files[p];
    throw new Error('not found ' + p);
  };

  const roots = buildCopyTree('/root/MAIN.CBL', '/root', { resolve, read });
  assert(roots.length === 2, `Attese 2 COPY di primo livello, ottenute ${roots.length}`);

  const child = roots.find(n => n.name === 'CHILD');
  assert(child && child.resolved, 'CHILD deve essere risolta');
  assert(child.children.length === 1 && child.children[0].name === 'GRAND',
    'CHILD deve includere GRAND come figlio');

  // GRAND include di nuovo CHILD: deve essere marcata come ricorsione, non espansa.
  const grand = child.children[0];
  const grandChild = grand.children.find(n => n.name === 'CHILD');
  assert(grandChild && grandChild.cyclic,
    'La COPY CHILD dentro GRAND deve essere marcata come ricorsione');
  assert(grandChild.children.length === 0,
    'La COPY ricorsiva non deve essere ulteriormente espansa');

  const missing = roots.find(n => n.name === 'MISSING');
  assert(missing && !missing.resolved,
    'La COPY MISSING non risolvibile deve avere resolved=false');

  console.log('OK - test regressione albero dipendenze copybook superati');
}

function runWriteOccurrenceTests() {
  const { classifyWriteOccurrence } = require('../src/cobol-parser');

  // Helper: classifica l'occorrenza di `name` (prima occorrenza whole-word) in `line`.
  function cls(line, name) {
    const upper = line.toUpperCase();
    const idx = upper.indexOf(name.toUpperCase());
    assert(idx >= 0, `token ${name} non trovato nella riga di test`);
    return classifyWriteOccurrence(line, idx);
  }

  // MOVE: sorgente = read, destinazione (dopo TO) = write.
  const mv = '           MOVE WS-SRC TO WS-DST.';
  assert(cls(mv, 'WS-SRC') === 'read', 'MOVE: la sorgente e\' lettura');
  assert(cls(mv, 'WS-DST') === 'write', 'MOVE: la destinazione dopo TO e\' scrittura');

  // MOVE con piu' destinazioni.
  const mv2 = '           MOVE ZERO TO WS-A WS-B.';
  assert(cls(mv2, 'WS-A') === 'write' && cls(mv2, 'WS-B') === 'write',
    'MOVE: tutte le destinazioni dopo TO sono scrittura');

  // Subscript: l'indice tra parentesi e' sempre lettura.
  const mvSub = '           MOVE WS-SRC TO WS-TAB (WS-IDX).';
  assert(cls(mvSub, 'WS-IDX') === 'read', 'Il subscript tra parentesi e\' sempre lettura');
  assert(cls(mvSub, 'WS-TAB') === 'write', 'La tabella destinazione (fuori parentesi) e\' scrittura');

  // SET: destinazione PRIMA di TO.
  const st = '           SET WS-IDX TO 1.';
  assert(cls(st, 'WS-IDX') === 'write', 'SET: la destinazione prima di TO e\' scrittura');
  const stUp = '           SET WS-IDX UP BY 1.';
  assert(cls(stUp, 'WS-IDX') === 'write', 'SET UP BY: la destinazione e\' scrittura');

  // COMPUTE: destinazione prima di '='.
  const cp = '           COMPUTE WS-TOT = WS-A + WS-B.';
  assert(cls(cp, 'WS-TOT') === 'write', 'COMPUTE: la destinazione prima di = e\' scrittura');
  assert(cls(cp, 'WS-A') === 'read' && cls(cp, 'WS-B') === 'read',
    'COMPUTE: gli operandi dopo = sono lettura');

  // ADD senza GIVING: destinazione dopo TO.
  const ad = '           ADD WS-A TO WS-TOT.';
  assert(cls(ad, 'WS-A') === 'read' && cls(ad, 'WS-TOT') === 'write',
    'ADD ... TO: destinazione dopo TO in scrittura');
  // ADD con GIVING: destinazione dopo GIVING; l\'operando TO torna lettura.
  const adg = '           ADD WS-A TO WS-B GIVING WS-RES.';
  assert(cls(adg, 'WS-B') === 'read' && cls(adg, 'WS-RES') === 'write',
    'ADD ... GIVING: solo il target dopo GIVING e\' scrittura');

  // SUBTRACT / MULTIPLY / DIVIDE.
  const sub = '           SUBTRACT WS-A FROM WS-TOT.';
  assert(cls(sub, 'WS-TOT') === 'write', 'SUBTRACT ... FROM: destinazione in scrittura');
  const mul = '           MULTIPLY WS-A BY WS-TOT.';
  assert(cls(mul, 'WS-TOT') === 'write', 'MULTIPLY ... BY: destinazione in scrittura');
  const div = '           DIVIDE WS-A INTO WS-TOT.';
  assert(cls(div, 'WS-TOT') === 'write', 'DIVIDE ... INTO: destinazione in scrittura');
  const divR = '           DIVIDE WS-A BY WS-B GIVING WS-Q REMAINDER WS-R.';
  assert(cls(divR, 'WS-Q') === 'write' && cls(divR, 'WS-R') === 'write',
    'DIVIDE ... GIVING ... REMAINDER: entrambi i target in scrittura');
  assert(cls(divR, 'WS-A') === 'read' && cls(divR, 'WS-B') === 'read',
    'DIVIDE: dividendo e divisore sono lettura');

  // INITIALIZE.
  const ini = '           INITIALIZE WS-A WS-B.';
  assert(cls(ini, 'WS-A') === 'write' && cls(ini, 'WS-B') === 'write',
    'INITIALIZE: tutti i target sono scrittura');

  // ACCEPT.
  const acc = '           ACCEPT WS-DATA FROM DATE.';
  assert(cls(acc, 'WS-DATA') === 'write', 'ACCEPT: il ricevente e\' scrittura');

  // STRING / UNSTRING ... INTO.
  const str = "           STRING WS-A WS-B DELIMITED BY SIZE INTO WS-OUT.";
  assert(cls(str, 'WS-OUT') === 'write' && cls(str, 'WS-A') === 'read',
    'STRING ... INTO: destinazione in scrittura, sorgenti in lettura');
  const uns = '           UNSTRING WS-IN DELIMITED BY SPACE INTO WS-P1 WS-P2.';
  assert(cls(uns, 'WS-P1') === 'write' && cls(uns, 'WS-IN') === 'read',
    'UNSTRING ... INTO: destinazioni in scrittura, sorgente in lettura');

  // INSPECT ... TALLYING.
  const ins = '           INSPECT WS-TXT TALLYING WS-CNT FOR ALL SPACE.';
  assert(cls(ins, 'WS-CNT') === 'write', 'INSPECT ... TALLYING: il contatore e\' scrittura');
  assert(cls(ins, 'WS-TXT') === 'read', 'INSPECT: l\'item ispezionato (TALLYING) e\' lettura');

  // PERFORM VARYING: la variabile di ciclo e\' scrittura.
  const pv = '           PERFORM VARYING WS-I FROM 1 BY 1 UNTIL WS-I > 10';
  assert(cls(pv, 'WS-I') === 'write', 'PERFORM VARYING: la variabile di ciclo e\' scrittura');

  // Lettura pura: IF, DISPLAY, condizioni.
  const ifl = '           IF WS-FLAG = 1';
  assert(cls(ifl, 'WS-FLAG') === 'read', 'IF: la variabile in condizione e\' lettura');
  const disp = '           DISPLAY WS-MSG.';
  assert(cls(disp, 'WS-MSG') === 'read', 'DISPLAY: lettura');

  // Riga senza verbo (es. definizione dati): lettura prudente.
  const def = '       01 WS-FLAG               PIC 9(001).';
  assert(cls(def, 'WS-FLAG') === 'read', 'Definizione dati senza verbo: lettura');

  console.log('OK - test regressione read/write DocumentHighlight superati');
}

// ---------------------------------------------------------------------------
// Copybook di DATI aperta direttamente: le regole sui dati (missing-period)
// devono attivarsi anche se il frammento non contiene DIVISION/SECTION.
// Regressione: prima le voci senza punto finale non venivano segnalate perche'
// il contesto di sezione dati non era mai attivo su una copybook.
// ---------------------------------------------------------------------------
function runCopybookDataRulesTests() {
  const { runLinter } = require('../src/cobol-linter');

  const copyLines = [
    '      * AREA TABELLA - CERTSTIPENOTE',
    '       01 PGT1187-AREA.',
    '          05 PGT1187-FLAG            PIC X(001).',
    '          05 PGT1187-CHIAVE.',
    '             15 PGT1187-GG-ESEC      PIC 9(002)',
    '             15 PGT1187-MM-ESEC      PIC 9(002)',
    '             15 PGT1187-AA-ESEC      PIC 9(004).',
    ''
  ];
  const copyDiags = runLinter(copyLines.join('\n'), workDir);

  assert(
    !!findDiagOnLine(copyDiags, copyLines, 'missing-period', 'PGT1187-GG-ESEC'),
    'Atteso missing-period su PGT1187-GG-ESEC (voce senza punto in copybook di dati)'
  );
  assert(
    !!findDiagOnLine(copyDiags, copyLines, 'missing-period', 'PGT1187-MM-ESEC'),
    'Atteso missing-period su PGT1187-MM-ESEC (voce senza punto in copybook di dati)'
  );
  assert(
    !findDiagOnLine(copyDiags, copyLines, 'missing-period', 'PGT1187-AA-ESEC'),
    'Non atteso missing-period su PGT1187-AA-ESEC (voce con punto finale)'
  );
  assert(
    !findDiagOnLine(copyDiags, copyLines, 'missing-period', 'PGT1187-FLAG'),
    'Non atteso missing-period su PGT1187-FLAG (voce con punto finale)'
  );

  // Una copybook di PROCEDURE (paragrafi/statement, nessuna voce dati) non deve
  // essere trattata come contesto dati: nessun falso positivo missing-period.
  const procLines = [
    '      * Copy di procedure',
    '           MOVE ZERO TO WS-CONTATORE',
    '           ADD 1 TO WS-CONTATORE',
    '           DISPLAY WS-CONTATORE.',
    ''
  ];
  const procDiags = runLinter(procLines.join('\n'), workDir);
  assert(
    !procDiags.some(d => String(d.code) === 'missing-period'),
    'Non attesi missing-period su una copybook di procedure'
  );

  console.log('OK - test regressione copybook regole dati (missing-period) superati');
}

// ---------------------------------------------------------------------------
// missing-level: un letterale isolato dopo un punto terminatore in
// WORKING-STORAGE e' una voce dati non valida e va segnalato; la continuazione
// valida di un VALUE (riga precedente senza punto) NON va segnalata.
// ---------------------------------------------------------------------------
function runOrphanLiteralTests() {
  const { runLinter } = require('../src/cobol-linter');

  const orphanLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-ORPH.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    "       01 WS-A                    PIC X(50) VALUE 'aaaaaaa'.",
    "          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.",
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(orphanLines.join('\n'), workDir), orphanLines, 'missing-level', "'AAAAAAAA"),
    'Atteso missing-level sul letterale orfano dopo un punto terminatore'
  );

  const contLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CONT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-B                    PIC X(50) VALUE',
    "          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.",
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(contLines.join('\n'), workDir).some(d => String(d.code) === 'missing-level'),
    'Non atteso missing-level sulla continuazione valida di un VALUE (riga precedente senza punto)'
  );

  console.log('OK - test regressione letterale orfano (missing-level) superati');
}

// ---------------------------------------------------------------------------
// chars-after-period: uno statement COPY sulla stessa riga dopo il punto che
// chiude un data item (es. "01 GRUPPO.  COPY MEMBRO.") e' COBOL valido e NON
// va segnalato; contenuto spurio reale dopo il punto resta segnalato.
// ---------------------------------------------------------------------------
function runCopyAfterPeriodTests() {
  const { runLinter } = require('../src/cobol-linter');

  const copyLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CAP.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 COMM-AREA-08.  COPY DFHBMSCA.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(copyLines.join('\n'), workDir).some(
      d => String(d.code) === 'chars-after-period'),
    'Non atteso chars-after-period su COPY sulla stessa riga di un data item'
  );

  const spuriousLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CAP2.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A                    PIC X(10).  GARBAGE',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(spuriousLines.join('\n'), workDir), spuriousLines, 'chars-after-period', 'GARBAGE'),
    'Atteso chars-after-period su contenuto spurio reale dopo il punto terminatore'
  );

  // Il punto che chiude l'header di un paragrafo della ENVIRONMENT DIVISION non
  // e' un terminatore di frase: la entry puo' iniziare sulla stessa riga. I nomi
  // mnemonici definiti in SPECIAL-NAMES sono riferibili nella PROCEDURE.
  const specialNamesLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SPN.',
    '       ENVIRONMENT DIVISION.',
    '       CONFIGURATION SECTION.',
    '       SPECIAL-NAMES. DECIMAL-POINT IS COMMA',
    '           C01  IS CANALE1.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A                    PIC X(10).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE SPACES TO WS-A. DISPLAY WS-A UPON CANALE1.',
    '           GOBACK.',
    ''
  ];
  const specialNamesDiags = runLinter(specialNamesLines.join('\n'), workDir);
  assert(
    !findDiagOnLine(specialNamesDiags, specialNamesLines, 'chars-after-period', 'SPECIAL-NAMES.'),
    'Non atteso chars-after-period su "SPECIAL-NAMES. DECIMAL-POINT IS COMMA"'
  );
  assert(
    !findDiagOnLine(specialNamesDiags, specialNamesLines, 'chars-after-period', 'MOVE SPACES TO WS-A.'),
    'Non atteso chars-after-period su due statement sulla stessa riga in PROCEDURE'
  );
  assert(
    !specialNamesDiags.some(d => String(d.code) === 'undefined-variable' && d._symbolName === 'CANALE1'),
    'Non atteso undefined-variable sul nome mnemonico CANALE1 definito in SPECIAL-NAMES'
  );

  const envSpuriousLines = specialNamesLines.slice();
  envSpuriousLines[4] = '       SPECIAL-NAMES. DECIMAL-POINT IS COMMA. GARBAGE';
  envSpuriousLines[5] = '       INPUT-OUTPUT SECTION.';
  assert(
    !!findDiagOnLine(runLinter(envSpuriousLines.join('\n'), workDir), envSpuriousLines, 'chars-after-period', 'GARBAGE'),
    'Atteso chars-after-period su contenuto spurio dopo il punto in ENVIRONMENT DIVISION'
  );

  console.log('OK - test regressione COPY dopo il punto (chars-after-period) superati');
}


// ---------------------------------------------------------------------------
// undefined-variable: una COPY inline sulla stessa riga di una voce dati
// (es. "01 GRUPPO. COPY MEMBRO.") deve comunque far caricare i simboli della
// copybook, cosi' le variabili in essa definite NON vengono segnalate come non
// definite quando usate nella PROCEDURE DIVISION.
// ---------------------------------------------------------------------------
function runInlineCopyUndefinedTests() {
  const { runLinter } = require('../src/cobol-linter');

  const copyDir = path.join(workDir, 'Copy');
  ensureDir(copyDir);
  fs.writeFileSync(path.join(copyDir, 'CPINLINE'),
    [
      '           05 COMM-NOMIFILES.',
      '             10 COMM-ARCPASS          PIC X(08).',
      ''
    ].join('\n'), 'utf8');

  const inlineProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-INLINE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 COMM-AREA-08. COPY CPINLINE.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE SPACES TO COMM-NOMIFILES.',
    '           GOBACK.',
    ''
  ];
  const inlineLines = inlineProgram;
  assert(
    !findDiagOnLine(runLinter(inlineProgram.join('\n'), workDir), inlineLines,
      'undefined-variable', 'COMM-NOMIFILES'),
    'Non atteso undefined-variable su COMM-NOMIFILES definita in COPY inline (stessa riga del data item)'
  );

  // ---------------------------------------------------------------------------
  // Falso positivo 1: la parola COPY dentro un letterale (VALUE) NON deve
  // essere interpretata come direttiva COPY. Il membro citato nel letterale
  // esiste realmente su disco, ma non deve essere caricato: la variabile in
  // esso definita, se usata, resta correttamente "non definita".
  // ---------------------------------------------------------------------------
  fs.writeFileSync(path.join(copyDir, 'CPFAKE'),
    [
      '           05 FAKE-FROM-LITERAL     PIC X(08).',
      ''
    ].join('\n'), 'utf8');

  const literalProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-LIT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    "       01 FILLER          PIC X(30) VALUE '***** COPY CPFAKE *****'.",
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE SPACES TO FAKE-FROM-LITERAL.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(literalProgram.join('\n'), workDir), literalProgram,
      'undefined-variable', 'FAKE-FROM-LITERAL'),
    'Atteso undefined-variable su FAKE-FROM-LITERAL: una COPY dentro un letterale NON va caricata'
  );

  // ---------------------------------------------------------------------------
  // Falso positivo 2: un nome dato che contiene "COPY" (es. WS-COPY-FIELD) o e'
  // seguito da altro token non deve essere scambiato per una direttiva COPY; la
  // variabile resta regolarmente definita e usabile senza segnalazioni.
  // ---------------------------------------------------------------------------
  const nameProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NAME.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-COPY-FIELD              PIC X(08).',
    '       01 WS-COPY                    PIC X(08).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE SPACES TO WS-COPY-FIELD.',
    '           MOVE SPACES TO WS-COPY.',
    '           GOBACK.',
    ''
  ];
  const nameDiags = runLinter(nameProgram.join('\n'), workDir);
  assert(
    !findDiagOnLine(nameDiags, nameProgram, 'undefined-variable', 'MOVE SPACES TO WS-COPY-FIELD'),
    'Non atteso undefined-variable su WS-COPY-FIELD (nome dato che contiene COPY)'
  );
  assert(
    !findDiagOnLine(nameDiags, nameProgram, 'undefined-variable', 'MOVE SPACES TO WS-COPY'),
    'Non atteso undefined-variable su WS-COPY (nome dato seguito da altro token)'
  );

  console.log('OK - test regressione COPY inline (undefined-variable) superati');
}

// ---------------------------------------------------------------------------
// unused-paragraph / undefined-paragraph devono considerare anche i target
// dei GO TO (non solo dei PERFORM): un paragrafo raggiunto solo via GO TO
// non e' "inutilizzato", e un GO TO verso un paragrafo inesistente va
// segnalato come undefined-paragraph.
// ---------------------------------------------------------------------------
function runGotoParagraphTests() {
  const { runLinter } = require('../src/cobol-linter');

  const gotoProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-GOTO.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           IF WS-COND',
    '              GO TO ALTRO-PARA.',
    '           PERFORM PARA-USATO.',
    '           GOBACK.',
    '       PARA-USATO.',
    '           CONTINUE.',
    '       ALTRO-PARA.',
    '           CONTINUE.',
    ''
  ];
  const gotoDiags = runLinter(gotoProgram.join('\n'), workDir);
  assert(
    !findDiagOnLine(gotoDiags, gotoProgram, 'unused-paragraph', 'ALTRO-PARA.'),
    'Non atteso unused-paragraph su ALTRO-PARA: e\' raggiunto da un GO TO'
  );

  const gotoMissingProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-GOTOMISS.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           GO TO PARA-INESISTENTE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(gotoMissingProgram.join('\n'), workDir), gotoMissingProgram,
      'undefined-paragraph', 'GO TO PARA-INESISTENTE'),
    'Atteso undefined-paragraph su un GO TO verso un paragrafo mai definito'
  );

  console.log('OK - test regressione GO TO (unused/undefined-paragraph) superati');
}

function runFormatterConfigTests() {
  const { computeFormatted } = require('../src/cobol-formatter');

  // Colonna 1-based del primo carattere non-spazio.
  function colOf(line) {
    const m = line.match(/^(\s*)\S/);
    return m ? m[1].length + 1 : -1;
  }
  // Colonna 1-based (indexOf+1) della prima occorrenza di needle.
  function atCol(line, needle) {
    const idx = line.indexOf(needle);
    return idx < 0 ? -1 : idx + 1;
  }

  // --- MOVE/ADD allineano TO alla colonna PIC (45); SET resta ravvicinato. ---
  const procSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-FMT.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE 1 TO WS-A.',
    '           ADD 1 TO WS-B.',
    '           SET SW-OK TO TRUE.',
    ''
  ];
  const procDef = new Set([3]); // MAIN
  const out1 = computeFormatted(procSrc, procDef);

  const mv = out1.find(l => /\bMOVE 1\b/.test(l));
  assert(atCol(mv, 'TO WS-A') === 45,
    `MOVE: TO atteso a colonna 45, ottenuto ${atCol(mv, 'TO WS-A')}`);
  const ad = out1.find(l => /\bADD 1\b/.test(l));
  assert(atCol(ad, 'TO WS-B') === 45,
    `ADD: TO atteso a colonna 45, ottenuto ${atCol(ad, 'TO WS-B')}`);
  const st = out1.find(l => /\bSET SW-OK\b/.test(l));
  assert(st === ' '.repeat(11) + 'SET SW-OK TO TRUE.',
    `SET deve restare ravvicinato a colonna 12, ottenuto "${st}"`);
  assert(atCol(st, 'TO TRUE') !== 45,
    'SET: il TO NON deve essere allineato a colonna 45');

  // --- alignMoveTo=false: il TO di MOVE resta ravvicinato. ---
  const out1b = computeFormatted(procSrc, procDef, { alignMoveTo: false });
  const mvB = out1b.find(l => /\bMOVE 1\b/.test(l));
  assert(atCol(mvB, 'TO WS-A') !== 45,
    'alignMoveTo=false: il TO di MOVE non deve essere allineato a colonna 45');

  // --- PERFORM ... THRU: il THRU si indenta di un passo sotto il PERFORM. ---
  const thruSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-THRU.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM RT-ELAB',
    '           THRU RT-ELAB-EX.',
    ''
  ];
  const outThru = computeFormatted(thruSrc, new Set([3]));
  const perf = outThru.find(l => /\bPERFORM RT-ELAB\b/.test(l));
  const thru = outThru.find(l => /\bTHRU RT-ELAB-EX\b/.test(l));
  assert(colOf(perf) === 12, `PERFORM atteso a colonna 12, ottenuto ${colOf(perf)}`);
  assert(colOf(thru) === 15,
    `THRU atteso a colonna 15 (PERFORM+3), ottenuto ${colOf(thru)}`);

  // indentThru=false: il THRU resta alla colonna del PERFORM (12).
  const outThru2 = computeFormatted(thruSrc, new Set([3]), { indentThru: false });
  const thru2 = outThru2.find(l => /\bTHRU RT-ELAB-EX\b/.test(l));
  assert(colOf(thru2) === 12,
    `indentThru=false: THRU atteso a colonna 12, ottenuto ${colOf(thru2)}`);

  // --- PERFORM ... THRU inline (range) su una riga: il THRU va spezzato sulla
  //     riga sotto, indentato di un passo (col 15). ---
  const thruInlineSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-THRU2.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM RT-ELAB THRU RT-ELAB-EX.',
    ''
  ];
  const outThruIn = computeFormatted(thruInlineSrc, new Set([3])).join('\n').split('\n');
  const perfIn = outThruIn.find(l => /\bPERFORM RT-ELAB\b/.test(l) && !/THRU/.test(l));
  const thruIn = outThruIn.find(l => /^\s*THRU RT-ELAB-EX\./.test(l));
  assert(perfIn && colOf(perfIn) === 12,
    `PERFORM inline: la riga PERFORM (senza THRU) attesa a col 12, ottenuto ${perfIn && colOf(perfIn)}`);
  assert(thruIn && colOf(thruIn) === 15,
    `PERFORM inline: il THRU spezzato atteso a col 15, ottenuto ${thruIn && colOf(thruIn)}`);
  // indentThru=false: il PERFORM ... THRU resta su una sola riga.
  const outThruInOff = computeFormatted(thruInlineSrc, new Set([3]), { indentThru: false })
    .join('\n').split('\n');
  assert(outThruInOff.some(l => /\bPERFORM RT-ELAB THRU RT-ELAB-EX\./.test(l)),
    'indentThru=false: il PERFORM ... THRU inline deve restare su una riga');

  // --- pictureColumn e indentStep configurabili sui dati. ---
  const dataSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DATA.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-REC.',
    '       05 WS-FLAG PIC X(001).',
    '       05 WS-SUB.',
    '       10 WS-INNER PIC 9(003).',
    ''
  ];
  // Default: PIC a col 45, passo 3 (05 -> col 11, 10 -> col 14).
  const outD = computeFormatted(dataSrc, new Set());
  const flag = outD.find(l => /\bWS-FLAG\b/.test(l));
  assert(colOf(flag) === 11, `05 WS-FLAG atteso a colonna 11, ottenuto ${colOf(flag)}`);
  assert(atCol(flag, 'PIC ') === 45,
    `PIC di WS-FLAG atteso a colonna 45, ottenuto ${atCol(flag, 'PIC ')}`);
  const inner = outD.find(l => /\bWS-INNER\b/.test(l));
  assert(colOf(inner) === 14, `10 WS-INNER atteso a colonna 14, ottenuto ${colOf(inner)}`);

  // Personalizzato: PIC a col 30, passo 2 (05 -> col 10, 10 -> col 12).
  const outD2 = computeFormatted(dataSrc, new Set(), { pictureColumn: 30, indentStep: 2 });
  const flag2 = outD2.find(l => /\bWS-FLAG\b/.test(l));
  assert(colOf(flag2) === 10, `passo 2: 05 WS-FLAG atteso a colonna 10, ottenuto ${colOf(flag2)}`);
  assert(atCol(flag2, 'PIC ') === 30,
    `pictureColumn=30: PIC di WS-FLAG atteso a colonna 30, ottenuto ${atCol(flag2, 'PIC ')}`);
  const inner2 = outD2.find(l => /\bWS-INNER\b/.test(l));
  assert(colOf(inner2) === 12, `passo 2: 10 WS-INNER atteso a colonna 12, ottenuto ${colOf(inner2)}`);

  // --- Copybook di PROCEDURE (senza header DIVISION): riconosciuto e formattato
  //     come statement (Area B + indentazione dei blocchi), non come dati. ---
  const copyProcSrc = [
    '      * Frammento di procedure',
    '       MOVE ZERO TO WS-CNT',
    '       IF WS-CNT = 0',
    '       ADD 1 TO WS-CNT',
    '       END-IF.',
    ''
  ];
  const outCP = computeFormatted(copyProcSrc, new Set());
  const cpMove = outCP.find(l => /\bMOVE ZERO\b/.test(l));
  const cpIf = outCP.find(l => /\bIF WS-CNT\b/.test(l));
  const cpAdd = outCP.find(l => /\bADD 1\b/.test(l));
  const cpEnd = outCP.find(l => /\bEND-IF\b/.test(l));
  assert(colOf(cpMove) === 12,
    `Copy procedure: MOVE atteso a colonna 12, ottenuto ${colOf(cpMove)}`);
  assert(colOf(cpIf) === 12,
    `Copy procedure: IF atteso a colonna 12, ottenuto ${colOf(cpIf)}`);
  assert(colOf(cpAdd) === 15,
    `Copy procedure: ADD dentro IF atteso a colonna 15, ottenuto ${colOf(cpAdd)}`);
  assert(colOf(cpEnd) === 12,
    `Copy procedure: END-IF atteso a colonna 12, ottenuto ${colOf(cpEnd)}`);

  // --- Copybook di DATI (senza header): resta trattato come tracciato. ---
  const copyDataSrc = [
    '      * Tracciato dati',
    '       01 REC-AREA.',
    '       05 REC-FLAG PIC X(001).',
    ''
  ];
  const outCD = computeFormatted(copyDataSrc, new Set());
  const cdRoot = outCD.find(l => /\bREC-AREA\b/.test(l));
  const cdFlag = outCD.find(l => /\bREC-FLAG\b/.test(l));
  assert(colOf(cdRoot) === 8,
    `Copy dati: 01 REC-AREA atteso a colonna 8, ottenuto ${colOf(cdRoot)}`);
  assert(colOf(cdFlag) === 11,
    `Copy dati: 05 REC-FLAG atteso a colonna 11, ottenuto ${colOf(cdFlag)}`);
  assert(atCol(cdFlag, 'PIC ') === 45,
    `Copy dati: PIC di REC-FLAG atteso a colonna 45, ottenuto ${atCol(cdFlag, 'PIC ')}`);

  // --- Overflow VALUE: il PIC resta a col 45 e il letterale va a capo sotto il
  //     nome della variabile. Copre anche il caso in cui in input la coda del
  //     letterale sfora oltre la col 72 (area identificazione = codice sbordato). ---
  const ovSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-OV.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    "       01 WS-LUNGA PIC X(40) VALUE 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.",
    "       01 WS-MEDIA PIC X(20) VALUE 'BBBBBBBBBBBBBBBBBBBB'.",
    "       01 WS-BREVE                     PIC X(02) VALUE 'XY'.",
    ''
  ];
  const ovPhys = computeFormatted(ovSrc, new Set()).join('\n').split('\n');
  const ovI = ovPhys.findIndex(l => /\bWS-LUNGA\b/.test(l));
  const ovL1 = ovPhys[ovI];
  const ovL2 = ovPhys[ovI + 1];
  assert(atCol(ovL1, 'PIC ') === 45,
    `Overflow: PIC di WS-LUNGA atteso a colonna 45, ottenuto ${atCol(ovL1, 'PIC ')}`);
  assert(/VALUE\s*$/.test(ovL1),
    `Overflow: la riga 1 deve terminare con VALUE, ottenuto "${ovL1}"`);
  assert(ovL1.length <= 72, `Overflow: la riga 1 non deve superare la col 72 (${ovL1.length})`);
  // Letterale lungo (non ci sta a col 45): allineato sotto il nome (col 11).
  assert(colOf(ovL2) === 11,
    `Overflow lungo: il letterale a capo atteso a colonna 11 (sotto il nome), ottenuto ${colOf(ovL2)}`);
  assert(ovL2.trim().startsWith("'"),
    `Overflow: la riga 2 deve iniziare con l'apice del letterale, ottenuto "${ovL2}"`);
  assert(ovL2.length <= 72, `Overflow: la riga 2 non deve superare la col 72 (${ovL2.length})`);

  // Letterale medio (ci sta a col 45): allineato sotto la P di PIC (col 45).
  const ovMI = ovPhys.findIndex(l => /\bWS-MEDIA\b/.test(l));
  const ovM1 = ovPhys[ovMI];
  const ovM2 = ovPhys[ovMI + 1];
  assert(atCol(ovM1, 'PIC ') === 45,
    `Overflow medio: PIC di WS-MEDIA atteso a colonna 45, ottenuto ${atCol(ovM1, 'PIC ')}`);
  assert(colOf(ovM2) === 45,
    `Overflow medio: il letterale a capo (ci sta) atteso a colonna 45, ottenuto ${colOf(ovM2)}`);
  assert(ovM2.trim().startsWith("'") && ovM2.length <= 72,
    `Overflow medio: la riga 2 deve iniziare con l'apice ed entro col 72, ottenuto "${ovM2}"`);

  // La voce breve resta su una riga sola con PIC a col 45.
  const ovBreve = ovPhys.find(l => /\bWS-BREVE\b/.test(l));
  assert(atCol(ovBreve, 'PIC ') === 45,
    `WS-BREVE deve restare su una riga con PIC a col 45, ottenuto ${atCol(ovBreve, 'PIC ')}`);

  // --- Letterale troppo lungo anche dalla colonna del nome: continuazione fixed
  //     su piu' righe (indicatore '-' in col 7, apice in Area B), con il
  //     contenuto preservato esattamente (round-trip). ---
  const longContent = '0123456789ABCDE'.repeat(10); // 150 caratteri, ordine verificabile
  const contSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CONT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    "       01 WS-XL PIC X(150) VALUE '" + longContent + "'.",
    ''
  ];
  const contPhys = computeFormatted(contSrc, new Set()).join('\n').split('\n');
  const cI = contPhys.findIndex(l => /\bWS-XL\b/.test(l));
  const cLine1 = contPhys[cI];
  assert(atCol(cLine1, 'PIC ') === 45,
    `Continuazione: PIC di WS-XL atteso a col 45, ottenuto ${atCol(cLine1, 'PIC ')}`);
  assert(/VALUE\s*$/.test(cLine1), 'Continuazione: la riga 1 deve terminare con VALUE');
  // Ricostruzione del letterale dalle righe successive.
  let recon = '';
  let litLines = 0;
  for (let k = cI + 1; k < contPhys.length; k++) {
    const l = contPhys[k];
    if (l.trim() === '') break;
    assert(l.length <= 72, `Continuazione: la riga ${k} non deve superare col 72 (${l.length})`);
    const isCont = l.charAt(6) === '-';
    if (k === cI + 1) {
      assert(!isCont, 'Continuazione: la prima riga del letterale non ha il trattino');
      assert(colOf(l) >= 12, 'Continuazione: l\'apice deve essere in Area B (col >= 12)');
    } else {
      assert(isCont, `Continuazione: la riga ${k} deve avere '-' in col 7`);
    }
    const qi = l.indexOf("'");
    const qj = l.indexOf("'", qi + 1);
    litLines++;
    if (qj >= 0) { recon += l.substring(qi + 1, qj); break; } // riga di chiusura
    recon += l.substring(qi + 1); // riga piena fino a col 72
  }
  assert(recon === longContent,
    'Continuazione: il contenuto ricostruito deve coincidere esattamente con l\'originale');
  assert(litLines >= 3, `Continuazione: il letterale deve essere spezzato su piu' righe (${litLines})`);

  // --- IDENTIFICATION: i valori dei paragrafi allineati a colonna 22. ---
  const idSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGMTEST.',
    '       AUTHOR. TIZIO-AI.',
    '       DATE-WRITTEN. 2026-07-17.',
    ''
  ];
  const idOut = computeFormatted(idSrc, new Set());
  assert(atCol(idOut.find(l => /\bPGMTEST\b/.test(l)), 'PGMTEST') === 22,
    'PROGRAM-ID: valore atteso a colonna 22');
  assert(atCol(idOut.find(l => /\bTIZIO-AI\b/.test(l)), 'TIZIO-AI') === 22,
    'AUTHOR: valore atteso a colonna 22');
  assert(atCol(idOut.find(l => /2026-07-17/.test(l)), '2026-07-17') === 22,
    'DATE-WRITTEN: valore atteso a colonna 22');

  // --- FILE-CONTROL / SELECT: SELECT a col 12, clausole a col 29, valori a
  //     col 42, IS omesso (formato template). ---
  const selSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGMSEL.',
    '       ENVIRONMENT DIVISION.',
    '       INPUT-OUTPUT SECTION.',
    '       FILE-CONTROL.',
    '           SELECT ANAG ASSIGN TO ANAGFILE',
    '                ORGANIZATION IS INDEXED',
    '              ACCESS IS DYNAMIC',
    '                  RECORD KEY IS ANAG-CHIAVE',
    '               STATUS IS FS-ANAG.',
    '           SELECT STAMPA ASSIGN TO STAMPAFIL',
    '                ORGANIZATION IS LINE SEQUENTIAL',
    '                 STATUS IS FS-STAMPA.',
    '       DATA DIVISION.',
    ''
  ];
  const selOut = computeFormatted(selSrc, new Set());
  const selL = selOut.find(l => /\bSELECT ANAG\b/.test(l));
  assert(colOf(selL) === 12, `SELECT atteso a col 12, ottenuto ${colOf(selL)}`);
  assert(atCol(selL, 'ANAG ') === 19, `nome file atteso a col 19, ottenuto ${atCol(selL, 'ANAG ')}`);
  assert(atCol(selL, 'ASSIGN TO') === 29, `ASSIGN TO atteso a col 29, ottenuto ${atCol(selL, 'ASSIGN TO')}`);
  assert(atCol(selL, 'ANAGFILE') === 42, `valore ASSIGN atteso a col 42, ottenuto ${atCol(selL, 'ANAGFILE')}`);
  const orgL = selOut.find(l => /\bORGANIZATION INDEXED\b/.test(l));
  assert(colOf(orgL) === 29, `ORGANIZATION atteso a col 29, ottenuto ${colOf(orgL)}`);
  assert(atCol(orgL, 'INDEXED') === 42, `valore ORGANIZATION atteso a col 42, ottenuto ${atCol(orgL, 'INDEXED')}`);
  assert(!/\bIS\b/.test(orgL), 'IS deve essere omesso nella clausola ORGANIZATION');
  const accL = selOut.find(l => /\bACCESS\b/.test(l));
  assert(atCol(accL, 'DYNAMIC') === 42 && !/\bIS\b/.test(accL) && !/\bMODE\b/.test(accL),
    'ACCESS: valore a col 42, IS/MODE omessi');
  const staL = selOut.find(l => /\bSTATUS\b/.test(l) && /FS-ANAG/.test(l));
  assert(colOf(staL) === 29 && atCol(staL, 'FS-ANAG') === 42,
    'STATUS: clausola a col 29, valore a col 42');

  console.log('OK - test regressione formatter (config, SET, THRU, copy) superati');
}

// ---------------------------------------------------------------------------
// Formatter Stage 2 (opt-in): separatori *---- e righe vuote tra blocchi.
// Verifica: inserimento corretto, esclusioni (IDENTIFICATION, paragrafi di
// uscita), idempotenza, invariante di sicurezza (nessuna riga di codice persa),
// e assenza di inserzioni quando le opzioni sono disattivate.
// ---------------------------------------------------------------------------
function runStage2FormatterTests() {
  const { formatDocument } = require('../src/cobol-formatter');

  function isSep(line) {
    return line.length > 7 && line.charAt(6) === '*' && /^-+$/.test(line.substring(7).trim());
  }
  function idxOf(lines, trimmed) {
    return lines.findIndex(l => l.trim() === trimmed);
  }
  function paraSet(lines, names) {
    const s = new Set();
    names.forEach(n => { const i = idxOf(lines, n + '.'); if (i >= 0) s.add(i); });
    return s;
  }
  function sepBefore(lines, trimmed) {
    const i = idxOf(lines, trimmed);
    if (i <= 0) return false;
    let k = i - 1;
    while (k >= 0 && lines[k].trim() === '') k--;
    return k >= 0 && isSep(lines[k]);
  }
  function blankBefore(lines, trimmed) {
    const i = idxOf(lines, trimmed);
    return i > 0 && lines[i - 1].trim() === '';
  }

  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-S2.',
    '       ENVIRONMENT DIVISION.',
    '       CONFIGURATION SECTION.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A                           PIC 9(03) VALUE 0.',
    '       01 SW-X                           PIC 9(01) VALUE 0.',
    '          88 SW-X-ON                                VALUE 1.',
    '       LINKAGE SECTION.',
    '       01 LK-A                           PIC X(04).',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           PERFORM INIT-PARA',
    '              THRU INIT-PARA-EX.',
    '           PERFORM WORK-PARA',
    '              THRU WORK-PARA-EX.',
    '           GOBACK.',
    '       INIT-PARA.',
    '           MOVE 0 TO WS-A.',
    '           MOVE 1 TO WS-A.',
    '           SET SW-X-ON TO TRUE.',
    '           IF WS-A > 0',
    '              MOVE 2 TO WS-A',
    '           END-IF.',
    '       INIT-PARA-EX.',
    '           EXIT.',
    '       WORK-PARA.',
    '           DISPLAY WS-A.',
    '       WORK-PARA-EX.',
    '           EXIT.',
    ''
  ];
  const paraNames = ['MAIN-PARA', 'INIT-PARA', 'INIT-PARA-EX', 'WORK-PARA', 'WORK-PARA-EX'];
  const procDef = paraSet(src, paraNames);

  // --- OFF: nessuna inserzione (stesso numero di righe dell'input). ---
  const off = formatDocument(src, procDef);
  assert(off.length === src.length,
    `Stage 2 disattivo: nessuna riga inserita (atteso ${src.length}, ottenuto ${off.length})`);
  assert(!off.some(isSep), 'Stage 2 disattivo: nessun separatore inserito');

  // --- Separatori. ---
  const sep = formatDocument(src, procDef, { sectionSeparators: true });
  assert(sepBefore(sep, 'ENVIRONMENT DIVISION.'), 'Separatore atteso prima di ENVIRONMENT DIVISION');
  assert(sepBefore(sep, 'DATA DIVISION.'), 'Separatore atteso prima di DATA DIVISION');
  assert(sepBefore(sep, 'PROCEDURE DIVISION.'), 'Separatore atteso prima di PROCEDURE DIVISION');
  assert(sepBefore(sep, 'WORKING-STORAGE SECTION.'), 'Separatore atteso prima di WORKING-STORAGE SECTION');
  assert(sepBefore(sep, 'LINKAGE SECTION.'), 'Separatore atteso prima di LINKAGE SECTION');
  assert(sepBefore(sep, 'MAIN-PARA.'), 'Separatore atteso prima di MAIN-PARA');
  assert(sepBefore(sep, 'INIT-PARA.'), 'Separatore atteso prima di INIT-PARA');
  assert(sepBefore(sep, 'WORK-PARA.'), 'Separatore atteso prima di WORK-PARA');
  // Esclusioni:
  assert(!sepBefore(sep, 'IDENTIFICATION DIVISION.'), 'Nessun separatore prima di IDENTIFICATION');
  assert(!sepBefore(sep, 'CONFIGURATION SECTION.'), 'Nessun separatore prima di CONFIGURATION SECTION');
  assert(!sepBefore(sep, 'INIT-PARA-EX.'), 'Nessun separatore prima di un paragrafo di uscita (-EX)');
  assert(blankBefore(sep, 'INIT-PARA-EX.'), 'Riga vuota attesa prima del paragrafo di uscita INIT-PARA-EX');

  // --- Righe vuote tra blocchi. ---
  const bl = formatDocument(src, procDef, { blankLines: true });
  // Blank dopo l'header del paragrafo principale (prima del primo PERFORM).
  const iMain = idxOf(bl, 'MAIN-PARA.');
  assert(bl[iMain + 1].trim() === '', 'Riga vuota attesa dopo l\'header MAIN-PARA');
  // I due PERFORM consecutivi vanno separati (uno e' un blocco).
  assert(blankBefore(bl, 'PERFORM WORK-PARA'), 'Riga vuota attesa tra i due PERFORM');
  // I due MOVE consecutivi restano ravvicinati (nessuna riga vuota tra loro).
  assert(!blankBefore(bl, 'MOVE 1 TO WS-A.'), 'I due MOVE consecutivi NON vanno separati');
  // MOVE -> SET: il SET e' enfatizzato, va separato.
  assert(blankBefore(bl, 'SET SW-X-ON TO TRUE.'), 'Riga vuota attesa prima del SET');
  // Riga vuota prima del paragrafo di uscita.
  assert(blankBefore(bl, 'INIT-PARA-EX.'), 'Riga vuota attesa prima di INIT-PARA-EX');

  // --- Invariante di sicurezza: nessuna riga di codice persa/alterata. ---
  function codeSig(lines) {
    return lines.filter(l => {
      const ind = l.length > 6 ? l.charAt(6) : '';
      return l.trim() !== '' && ind !== '*' && ind !== '/';
    }).map(l => l.replace(/\s+$/, ''));
  }
  const both = formatDocument(src, procDef, { sectionSeparators: true, blankLines: true });
  const sigOff = codeSig(off);
  const sigBoth = codeSig(both);
  assert(sigBoth.length === sigOff.length,
    `Invariante: stesse righe di codice (atteso ${sigOff.length}, ottenuto ${sigBoth.length})`);
  for (let k = 0; k < sigOff.length; k++) {
    assert(sigBoth[k] === sigOff[k],
      `Invariante: riga di codice ${k} alterata dallo Stage 2`);
  }
  assert(both.length > off.length, 'Stage 2 attivo: devono essere state inserite righe');

  // --- Idempotenza: riformattare l'output non cambia nulla. ---
  const procDef2 = paraSet(both, paraNames);
  const both2 = formatDocument(both, procDef2, { sectionSeparators: true, blankLines: true });
  assert(both2.length === both.length,
    `Idempotenza: seconda formattazione non deve cambiare il numero di righe (${both.length} vs ${both2.length})`);
  for (let k = 0; k < both.length; k++) {
    assert(both2[k] === both[k], `Idempotenza: riga ${k} cambiata alla seconda formattazione`);
  }

  // --- Nuove regole (blank dopo PROCEDURE DIVISION, verbi diversi separati e
  //     stesso verbo non-blocco raggruppato, paragrafo -FINE = principale). ---
  function idxRe(lines, re) { return lines.findIndex(l => re.test(l)); }
  function blankBeforeRe(lines, re) {
    const i = idxRe(lines, re);
    return i > 0 && lines[i - 1].trim() === '';
  }
  const src2 = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-S2B.',
    '       PROCEDURE DIVISION USING LK.',
    '           PERFORM P-INIT',
    '              THRU P-INIT-EX.',
    '           GOBACK.',
    '       P-INIT.',
    '           OPEN INPUT F.',
    '           DISPLAY A.',
    '           DISPLAY B.',
    '           MOVE 1 TO X.',
    '           MOVE 2 TO Y.',
    '       P-INIT-EX.',
    '           EXIT.',
    '       P0000-FINE.',
    '           CLOSE F.',
    '       P0000-EX.',
    '           EXIT.',
    ''
  ];
  const names2 = ['P-INIT', 'P-INIT-EX', 'P0000-FINE', 'P0000-EX'];
  const pd2 = paraSet(src2, names2);
  const b2 = formatDocument(src2, pd2, { sectionSeparators: true, blankLines: true });

  // Riga vuota dopo l'header PROCEDURE DIVISION (prima del primo statement).
  const iProc = idxOf(b2, 'PROCEDURE DIVISION USING LK.');
  assert(b2[iProc + 1].trim() === '',
    'Riga vuota attesa dopo l\'header PROCEDURE DIVISION');
  // OPEN -> DISPLAY: verbi diversi, separati.
  assert(blankBeforeRe(b2, /\bDISPLAY A\./), 'Riga vuota attesa tra OPEN e DISPLAY (verbi diversi)');
  // DISPLAY -> DISPLAY: stesso verbo non-blocco, raggruppati.
  assert(!blankBeforeRe(b2, /\bDISPLAY B\./), 'I due DISPLAY consecutivi NON vanno separati');
  // DISPLAY -> MOVE: verbi diversi, separati.
  assert(blankBeforeRe(b2, /\bMOVE 1\b/), 'Riga vuota attesa tra DISPLAY e MOVE (verbi diversi)');
  // MOVE -> MOVE: stesso verbo, raggruppati.
  assert(!blankBeforeRe(b2, /\bMOVE 2\b/), 'I due MOVE consecutivi NON vanno separati');
  // P0000-FINE (finalizzazione) e' un paragrafo PRINCIPALE, non di uscita:
  // riceve separatore e riga vuota dopo l'header (l'uscita e' P0000-EX).
  assert(sepBefore(b2, 'P0000-FINE.'), 'Separatore atteso prima di P0000-FINE (paragrafo principale)');
  assert(b2[idxOf(b2, 'P0000-FINE.') + 1].trim() === '',
    'Riga vuota attesa dopo l\'header P0000-FINE');
  assert(!sepBefore(b2, 'P0000-EX.'), 'Nessun separatore prima del paragrafo di uscita P0000-EX');

  // --- Paragrafo di uscita con PREFISSO "EX-" (convenzione MF/Rocket comune,
  //     es. EX-LEGGI-CERTSTIPENOTE), non solo suffisso "-EX"/"-EXIT". ---
  const src3 = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-S2C.',
    '       PROCEDURE DIVISION.',
    '       LEGGI-DATI.',
    '           MOVE SPACES TO WS-A.',
    '           IF WS-A EQUAL ZEROS',
    '              MOVE 1 TO WS-A',
    '           END-IF.',
    '       EX-LEGGI-DATI.',
    '           EXIT.',
    ''
  ];
  const names3 = ['LEGGI-DATI', 'EX-LEGGI-DATI'];
  const pd3 = paraSet(src3, names3);
  const b3 = formatDocument(src3, pd3, { sectionSeparators: true, blankLines: true });
  assert(!sepBefore(b3, 'EX-LEGGI-DATI.'),
    'Nessun separatore prima del paragrafo di uscita EX-LEGGI-DATI (prefisso EX-)');
  assert(blankBefore(b3, 'EX-LEGGI-DATI.'),
    'Riga vuota attesa prima del paragrafo di uscita EX-LEGGI-DATI (prefisso EX-)');
  assert(b3[idxOf(b3, 'EX-LEGGI-DATI.') + 1].trim() !== '',
    'Nessuna riga vuota tra l\'header EX-LEGGI-DATI e la EXIT che segue');

  // --- Paragrafo di uscita riconosciuto SOLO come bersaglio di
  //     PERFORM ... THRU, senza seguire nessuna convenzione di nome. ---
  const src4 = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-S2D.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           PERFORM LEGGI-DATI',
    '              THRU CHIUDI-LETTURA.',
    '           GOBACK.',
    '       LEGGI-DATI.',
    '           MOVE SPACES TO WS-A.',
    '           IF WS-A EQUAL ZEROS',
    '              MOVE 1 TO WS-A',
    '           END-IF.',
    '       CHIUDI-LETTURA.',
    '           EXIT.',
    ''
  ];
  const names4 = ['MAIN-PARA', 'LEGGI-DATI', 'CHIUDI-LETTURA'];
  const pd4 = paraSet(src4, names4);
  const b4 = formatDocument(src4, pd4, { sectionSeparators: true, blankLines: true });
  assert(!sepBefore(b4, 'CHIUDI-LETTURA.'),
    'Nessun separatore prima del bersaglio THRU CHIUDI-LETTURA (nessuna convenzione di nome)');
  assert(blankBefore(b4, 'CHIUDI-LETTURA.'),
    'Riga vuota attesa prima del bersaglio THRU CHIUDI-LETTURA');
  assert(b4[idxOf(b4, 'CHIUDI-LETTURA.') + 1].trim() !== '',
    'Nessuna riga vuota tra l\'header CHIUDI-LETTURA e la EXIT che segue');

  // --- FILE SECTION: riga vuota prima di ogni FD tranne il primo. ---
  const fdSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGMFD.',
    '       DATA DIVISION.',
    '       FILE SECTION.',
    '       FD FILE1 LABEL RECORD STANDARD.',
    '       01 REC1                            PIC X(10).',
    '       FD FILE2 LABEL RECORD STANDARD.',
    '       01 REC2                            PIC X(20).',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A                            PIC X(01).',
    ''
  ];
  const fdOut = formatDocument(fdSrc, new Set(), { blankLines: true });
  assert(blankBeforeRe(fdOut, /\bFD FILE2\b/), 'Riga vuota attesa prima del secondo FD');
  assert(!blankBeforeRe(fdOut, /\bFD FILE1\b/), 'Nessuna riga vuota prima del primo FD');

  // --- FILE-CONTROL: riga vuota prima di ogni SELECT tranne il primo. ---
  const scSrc = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGMSC.',
    '       ENVIRONMENT DIVISION.',
    '       INPUT-OUTPUT SECTION.',
    '       FILE-CONTROL.',
    '           SELECT ANAG ASSIGN TO ANAGFILE',
    '                STATUS IS FS-ANAG.',
    '           SELECT STAMPA ASSIGN TO STAMPAFIL',
    '                STATUS IS FS-STAMPA.',
    '       DATA DIVISION.',
    ''
  ];
  const scOut = formatDocument(scSrc, new Set(), { blankLines: true });
  assert(blankBeforeRe(scOut, /\bSELECT STAMPA\b/), 'Riga vuota attesa prima del secondo SELECT');
  assert(!blankBeforeRe(scOut, /\bSELECT ANAG\b/), 'Nessuna riga vuota prima del primo SELECT');

  console.log('OK - test regressione formatter Stage 2 (separatori, righe vuote, idempotenza) superati');
}

// ---------------------------------------------------------------------------
// Formatter Stage 2 - statement multi-riga SENZA punto: un nuovo verbo a
// colonna base apre una nuova sentence anche se la riga precedente non termina
// con il punto, quindi le righe vuote tra i blocchi vengono comunque inserite
// (e non prima dei delimitatori di blocco come END-IF).
// ---------------------------------------------------------------------------
function runStage2NoPeriodTests() {
  const { formatDocument } = require('../src/cobol-formatter');
  const { parseCobolSymbols } = require('../src/cobol-parser');
  const memPath = path.join(workDir, 'NOPERIOD.CBL');

  function procDefOf(lines) {
    const set = new Set();
    for (const sym of parseCobolSymbols(memPath, lines.join('\n'), workDir)) {
      if ((sym.type === 'paragraph' || sym.type === 'section') && sym.filePath === memPath) {
        set.add(sym.line);
      }
    }
    return set;
  }
  function blankBefore(lines, trimmed) {
    const i = lines.findIndex(l => l.trim() === trimmed);
    return i > 0 && lines[i - 1].trim() === '';
  }

  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NP.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A   PIC 9(03) VALUE 0.',
    '       01 WS-C   PIC X(10).',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           MOVE SPACES',
    '              TO WS-C',
    '           IF WS-A > 0',
    '              MOVE 2 TO WS-A',
    '           END-IF',
    '           PERFORM SUB-PARA',
    '           MOVE 1',
    '              TO WS-A.',
    '           GOBACK.',
    '       SUB-PARA.',
    '           CONTINUE.',
    ''
  ];
  const out = formatDocument(src, procDefOf(src), { blankLines: true });
  assert(blankBefore(out, 'IF WS-A > 0'),
    'Stage 2: attesa riga vuota prima di IF (statement precedente senza punto)');
  assert(blankBefore(out, 'PERFORM SUB-PARA'),
    'Stage 2: attesa riga vuota prima di PERFORM (dopo END-IF)');
  assert(!blankBefore(out, 'END-IF'),
    'Stage 2: nessuna riga vuota prima di END-IF (delimitatore di blocco)');
  assert(!blankBefore(out, 'MOVE 2 TO WS-A'),
    'Stage 2: nessuna riga vuota prima di uno statement annidato nell\'IF');

  // Idempotenza con procDef ricalcolato a ogni passata (gli indici cambiano).
  const out2 = formatDocument(out, procDefOf(out), { blankLines: true });
  assert(out.join('\n') === out2.join('\n'),
    'Stage 2 (senza punto): la 2a formattazione cambia l\'output (non idempotente)');

  console.log('OK - test regressione Stage 2 senza punto (righe vuote tra blocchi) superati');
}

// ---------------------------------------------------------------------------
// Formatter Stage 2 su SELEZIONE: formattare una selezione deve inserire le
// righe vuote tra i blocchi come la formattazione dell'intero documento
// (stesso contenuto per il blocco selezionato), senza aggiungere una riga vuota
// iniziale prima della selezione ne' finale dopo l'ultima riga.
// ---------------------------------------------------------------------------
function runStage2SelectionTests() {
  const { formatDocumentMapped } = require('../src/cobol-formatter');
  const { parseCobolSymbols } = require('../src/cobol-parser');
  const memPath = path.join(workDir, 'SELSTAGE2.CBL');

  function procDefOf(lines) {
    const set = new Set();
    for (const sym of parseCobolSymbols(memPath, lines.join('\n'), workDir)) {
      if ((sym.type === 'paragraph' || sym.type === 'section') && sym.filePath === memPath) {
        set.add(sym.line);
      }
    }
    return set;
  }

  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SEL.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A   PIC 9(03) VALUE 0.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           MOVE 0 TO WS-A',            // indice 7
    '           IF WS-A > 0',               // indice 8 (dovra' avere una vuota prima)
    '              MOVE 2 TO WS-A',
    '           END-IF',
    '           PERFORM SUB-PARA.',         // indice 11 (vuota prima)
    '           GOBACK.',
    '       SUB-PARA.',
    '           CONTINUE.',
    ''
  ];
  const opts = { blankLines: true };
  const map = formatDocumentMapped(src, procDefOf(src), opts);

  // Selezione dalle righe di input 7..11 (MOVE 0 ... PERFORM SUB-PARA).
  const s = 7, e = 11;
  const block = map.finalLines.slice(map.lineStart[s], map.lineEndEx[e]);

  // Nel blocco selezionato ci sono righe vuote (tra i blocchi), ma la prima e
  // l'ultima riga del blocco NON sono vuote (niente vuota iniziale/finale).
  assert(block.length > (e - s + 1),
    'Selezione Stage 2: attese righe vuote inserite nel blocco');
  assert(block[0].trim() !== '',
    'Selezione Stage 2: nessuna riga vuota iniziale prima della selezione');
  assert(block[block.length - 1].trim() !== '',
    'Selezione Stage 2: nessuna riga vuota finale dopo la selezione');
  assert(block.some(l => l.trim() === ''),
    'Selezione Stage 2: attesa almeno una riga vuota interna al blocco');

  // Il blocco selezionato deve coincidere con la porzione corrispondente della
  // formattazione dell'intero documento (stesso comportamento doc/selezione).
  const full = map.finalLines;
  const same = block.join('\n') === full.slice(map.lineStart[s], map.lineEndEx[e]).join('\n');
  assert(same, 'Selezione Stage 2: il blocco differisce dalla formattazione documento');

  console.log('OK - test regressione Stage 2 selezione (come documento) superati');
}

// ---------------------------------------------------------------------------
// Formatter - compressione spazi interni negli statement PROCEDURE: parole
// separate da un solo spazio (es. "INITIALIZE   AREA" -> "INITIALIZE AREA"),
// preservando pero' gli spazi dentro le stringhe.
// ---------------------------------------------------------------------------
function runFormatterCollapseTests() {
  const { computeFormatted } = require('../src/cobol-formatter');
  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CL.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           INITIALIZE   WS-A',
    "           DISPLAY 'A   B'    WS-A",
    '           GOBACK.',
    ''
  ];
  const out = computeFormatted(src, new Set([3])).join('\n').split('\n');
  const init = out.find(l => l.includes('INITIALIZE')) || '';
  assert(/INITIALIZE WS-A\b/.test(init) && !/INITIALIZE {2,}/.test(init),
    'Collapse: INITIALIZE deve avere un solo spazio prima dell\'operando');
  const disp = out.find(l => l.includes('DISPLAY')) || '';
  assert(disp.includes("'A   B'"),
    'Collapse: gli spazi dentro la stringa devono restare invariati');
  assert(/'A   B' WS-A/.test(disp),
    'Collapse: un solo spazio tra la stringa e l\'operando successivo');

  console.log('OK - test regressione compressione spazi PROCEDURE superati');
}

// ---------------------------------------------------------------------------
// Formatter - operandi di continuazione: gli statement con lista di operandi
// (es. INITIALIZE) allineano l'operando sotto il primo operando; i MOVE/ADD
// spezzati vengono invece UNITI su una riga con il TO a colonna 45 (o, se non
// ci stanno, restano su due righe con il TO a col 45).
// ---------------------------------------------------------------------------
function runProcContinuationTests() {
  const { computeFormatted } = require('../src/cobol-formatter');
  const { parseCobolSymbols } = require('../src/cobol-parser');
  const memPath = path.join(workDir, 'PROCCONT.CBL');

  function procDefOf(lines) {
    const set = new Set();
    for (const sym of parseCobolSymbols(memPath, lines.join('\n'), workDir)) {
      if ((sym.type === 'paragraph' || sym.type === 'section') && sym.filePath === memPath) {
        set.add(sym.line);
      }
    }
    return set;
  }
  function col1(line) { const i = line.search(/\S/); return i < 0 ? -1 : i + 1; }

  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CONT.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           INITIALIZE WS-A',
    '           WS-B.',
    '           MOVE WS-C',
    '           TO WS-D.',
    '           GOBACK.',
    ''
  ];
  const out = computeFormatted(src, procDefOf(src)).join('\n').split('\n');

  // INITIALIZE: l'operando WS-B si allinea sotto il primo operando WS-A.
  const initLine = out.find(l => /\bINITIALIZE\b/.test(l)) || '';
  const wsB = out.find(l => /\bWS-B\b/.test(l)) || '';
  const initOperandCol = col1(initLine) + 'INITIALIZE'.length + 1;
  assert(col1(wsB) === initOperandCol,
    `Continuazione: WS-B atteso a col ${initOperandCol}, trovato ${col1(wsB)}`);

  // MOVE WS-C / TO WS-D. viene UNITO su una riga con il TO a colonna 45.
  const moveJoined = out.find(l => /\bMOVE WS-C\b/.test(l) && /\bTO WS-D\b/.test(l)) || '';
  assert(moveJoined !== '',
    'Join: MOVE WS-C e TO WS-D devono stare sulla stessa riga');
  assert(moveJoined.indexOf('TO WS-D') + 1 === 45,
    `Join: TO atteso a col 45, trovato ${moveJoined.indexOf('TO WS-D') + 1}`);
  const moveNo = out.findIndex(l => /\bMOVE WS-C\b/.test(l));
  assert(out[moveNo + 1].trim() === '',
    'Join: la riga di continuazione svuotata deve restare vuota');

  // Idempotenza (procDef ricalcolato a ogni passata).
  const out2 = computeFormatted(out, procDefOf(out)).join('\n').split('\n');
  assert(out.join('\n') === out2.join('\n'),
    'Continuazione/join: la 2a formattazione cambia l\'output (non idempotente)');

  // Caso che NON ci sta su una riga: resta su due righe, TO a colonna 45.
  const srcLong = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CONT2.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE WS-UN-CAMPO-DAVVERO-MOLTO-LUNGO-DI-NOME-AAA',
    '           TO WS-UN-ALTRO-CAMPO-ANCORA-PIU-LUNGO-DEL-PRIMO-BB.',
    '           GOBACK.',
    ''
  ];
  const outL = computeFormatted(srcLong, procDefOf(srcLong)).join('\n').split('\n');
  const moveLong = outL.find(l => /\bMOVE WS-UN-CAMPO\b/.test(l)) || '';
  const toLong = outL.find(l => /^\s*TO WS-UN-ALTRO\b/.test(l)) || '';
  assert(!/\bTO WS-UN-ALTRO\b/.test(moveLong),
    'Join lungo: il TO non deve stare sulla riga del MOVE (non ci sta)');
  assert(col1(toLong) === 45,
    `Join lungo: TO atteso a col 45 sulla riga di continuazione, trovato ${col1(toLong)}`);

  console.log('OK - test regressione operandi di continuazione e join MOVE/ADD superati');
}

// ---------------------------------------------------------------------------
// Formatter - ancoraggio di continuazione (allineamento a destra): UNTIL/AND/OR
// dopo VARYING (anche su riga separata) e INTO dopo STRING terminano alla stessa
// colonna della fine di VARYING / STRING.
// ---------------------------------------------------------------------------
function runContAnchorTests() {
  const { computeFormatted } = require('../src/cobol-formatter');
  // Colonna 1-based dell'ultima lettera di `word` nella riga.
  function lastCol(line, word) { const i = line.indexOf(word); return i < 0 ? -1 : i + word.length; }

  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CA.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM SUB',
    '           VARYING X FROM 1 BY 1',
    '           UNTIL X > 9',
    '           OR Y = SPACES.',
    '           STRING A B',
    '           INTO C.',
    '           GOBACK.',
    '       SUB.',
    '           CONTINUE.',
    ''
  ];
  const out = computeFormatted(src, new Set([3])).join('\n').split('\n');
  const varying = out.find(l => /\bVARYING\b/.test(l)) || '';
  const until = out.find(l => /\bUNTIL\b/.test(l)) || '';
  const orLine = out.find(l => /^\s*OR\b/.test(l)) || '';
  const strLine = out.find(l => /\bSTRING\b/.test(l)) || '';
  const intoLine = out.find(l => /^\s*INTO\b/.test(l)) || '';

  assert(lastCol(until, 'UNTIL') === lastCol(varying, 'VARYING'),
    `contAnchor: UNTIL deve finire alla colonna di VARYING (${lastCol(varying, 'VARYING')}), trovato ${lastCol(until, 'UNTIL')}`);
  assert(lastCol(orLine, 'OR') === lastCol(varying, 'VARYING'),
    `contAnchor: OR deve finire alla colonna di VARYING, trovato ${lastCol(orLine, 'OR')}`);
  assert(lastCol(intoLine, 'INTO') === lastCol(strLine, 'STRING'),
    `contAnchor: INTO deve finire alla colonna di STRING (${lastCol(strLine, 'STRING')}), trovato ${lastCol(intoLine, 'INTO')}`);

  // Idempotenza.
  const out2 = computeFormatted(out, new Set([3])).join('\n').split('\n');
  assert(out.join('\n') === out2.join('\n'),
    'contAnchor: la 2a formattazione cambia l\'output (non idempotente)');

  // STRING con operandi su piu' righe prima di INTO: l'INTO deve comunque
  // finire alla colonna di STRING (non allinearsi sotto il primo operando).
  const src2 = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CB.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           STRING PGT-CODICE ";" DELIMITED BY SIZE',
    '           PGT-CAMPO ";" DELIMITED BY SIZE',
    '           PGT-OPER ";" DELIMITED BY SIZE',
    '           INTO WS-AREA POINTER WS-POSIZ',
    '           END-STRING.',
    '           GOBACK.',
    ''
  ];
  const outB = computeFormatted(src2, new Set([3])).join('\n').split('\n');
  const strB = outB.find(l => /\bSTRING\b/.test(l) && !/END-STRING/.test(l)) || '';
  const intoB = outB.find(l => /^\s*INTO\b/.test(l)) || '';
  assert(lastCol(intoB, 'INTO') === lastCol(strB, 'STRING'),
    `contAnchor: INTO (multi-operando) deve finire alla colonna di STRING (${lastCol(strB, 'STRING')}), trovato ${lastCol(intoB, 'INTO')}`);
  const outB2 = computeFormatted(outB, new Set([3])).join('\n').split('\n');
  assert(outB.join('\n') === outB2.join('\n'),
    'contAnchor: STRING multi-operando non idempotente');

  console.log('OK - test regressione ancoraggio continuazione (VARYING/STRING) superati');
}

// ---------------------------------------------------------------------------
// Formatter - split del PERFORM VARYING: la condizione UNTIL (anche scritta
// sulla stessa riga) va su righe proprie con UNTIL/OR/AND allineati a destra
// alla fine di VARYING; la parentesi aperta si attacca alla keyword.
// ---------------------------------------------------------------------------
function runVaryingSplitTests() {
  const { computeFormatted } = require('../src/cobol-formatter');
  const { parseCobolSymbols } = require('../src/cobol-parser');
  const memPath = path.join(workDir, 'VARSPLIT.CBL');

  function procDefOf(lines) {
    const set = new Set();
    for (const sym of parseCobolSymbols(memPath, lines.join('\n'), workDir)) {
      if ((sym.type === 'paragraph' || sym.type === 'section') && sym.filePath === memPath) {
        set.add(sym.line);
      }
    }
    return set;
  }
  function lastCol(line, word) { const i = line.indexOf(word); return i < 0 ? -1 : i + word.length; }

  // Single-line semplice: UNTIL va su una riga propria, allineato a destra.
  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-VS.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 10',
    '              DISPLAY WS-IDX',
    '           END-PERFORM.',
    '           GOBACK.',
    ''
  ];
  const out = computeFormatted(src, procDefOf(src)).join('\n').split('\n');
  const varying = out.find(l => /\bVARYING\b/.test(l)) || '';
  const until = out.find(l => /^\s*UNTIL\b/.test(l)) || '';
  assert(!/\bUNTIL\b/.test(varying), 'VARYING split: UNTIL deve andare su una riga propria');
  assert(lastCol(until, 'UNTIL') === lastCol(varying, 'VARYING'),
    'VARYING split: UNTIL deve finire alla colonna di VARYING');
  const out2 = computeFormatted(out, procDefOf(out)).join('\n').split('\n');
  assert(out.join('\n') === out2.join('\n'), 'VARYING split: non idempotente');

  // Compound single-line: OR e AND ciascuno su riga propria, allineati a destra.
  const srcC = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-VS2.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM VARYING I FROM 1 BY 1 UNTIL I > 10 OR (I < 5 AND I = 3)',
    '              DISPLAY I',
    '           END-PERFORM.',
    '           GOBACK.',
    ''
  ];
  const outC = computeFormatted(srcC, procDefOf(srcC)).join('\n').split('\n');
  const vC = outC.find(l => /\bVARYING\b/.test(l)) || '';
  const uC = outC.find(l => /^\s*UNTIL\b/.test(l)) || '';
  const oC = outC.find(l => /^\s*OR\b/.test(l)) || '';
  const aC = outC.find(l => /^\s*AND\b/.test(l)) || '';
  assert(uC !== '' && oC !== '' && aC !== '',
    'VARYING compound: UNTIL/OR/AND devono stare su righe separate');
  assert(lastCol(uC, 'UNTIL') === lastCol(vC, 'VARYING')
    && lastCol(oC, 'OR') === lastCol(vC, 'VARYING')
    && lastCol(aC, 'AND') === lastCol(vC, 'VARYING'),
    'VARYING compound: UNTIL/OR/AND devono finire alla colonna di VARYING');
  assert(/\bOR\(/.test(oC),
    'VARYING compound: la parentesi aperta deve essere attaccata a OR');
  const outC2 = computeFormatted(outC, procDefOf(outC)).join('\n').split('\n');
  assert(outC.join('\n') === outC2.join('\n'), 'VARYING compound: non idempotente');

  // Re-align: sorgente gia' multi-riga con OR(...AND...) su UNA riga -> l'AND
  // interno deve comunque andare su una riga propria allineata a destra.
  const srcR = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-VS3.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           PERFORM VARYING J FROM 1 BY 1',
    '              UNTIL J > 10',
    '              OR (J < 5 AND J = 2)',
    '              DISPLAY J',
    '           END-PERFORM.',
    '           GOBACK.',
    ''
  ];
  const outR = computeFormatted(srcR, procDefOf(srcR)).join('\n').split('\n');
  const vR = outR.find(l => /\bVARYING\b/.test(l)) || '';
  const aR = outR.find(l => /^\s*AND\b/.test(l)) || '';
  assert(aR !== '', 'VARYING re-align: l\'AND interno all\'OR deve andare su una riga propria');
  assert(lastCol(aR, 'AND') === lastCol(vR, 'VARYING'),
    'VARYING re-align: l\'AND deve finire alla colonna di VARYING');
  const outR2 = computeFormatted(outR, procDefOf(outR)).join('\n').split('\n');
  assert(outR.join('\n') === outR2.join('\n'), 'VARYING re-align: non idempotente');

  console.log('OK - test regressione split PERFORM VARYING superati');
}

// ---------------------------------------------------------------------------
// Formatter - reflow della condizione IF composta: AND in coda, OR a inizio
// riga, operandi/operatori (=) incolonnati, parentesi sospesa; il body resta
// indentato nell'IF e END-IF alla colonna dell'IF. Gli IF semplici non si toccano.
// ---------------------------------------------------------------------------
function runIfReflowTests() {
  const { computeFormatted } = require('../src/cobol-formatter');
  const { parseCobolSymbols } = require('../src/cobol-parser');
  const memPath = path.join(workDir, 'IFREFLOW.CBL');

  function procDefOf(lines) {
    const set = new Set();
    for (const sym of parseCobolSymbols(memPath, lines.join('\n'), workDir)) {
      if ((sym.type === 'paragraph' || sym.type === 'section') && sym.filePath === memPath) {
        set.add(sym.line);
      }
    }
    return set;
  }
  function col1(line) { const i = line.search(/\S/); return i < 0 ? -1 : i + 1; }

  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-IF.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    "           IF WE3C-RICALC1-T NOT = 'X'",
    "              AND WE3C-RICALC2-T NOT = 'X'",
    "              AND (WE3C-RICALC3-T = 'X' OR WE3C-RICALC3-T = 'A')",
    '              MOVE -3 TO W-RETURNCODE',
    '           END-IF.',
    '           GOBACK.',
    ''
  ];
  const out = computeFormatted(src, procDefOf(src)).join('\n').split('\n');
  const ifLine = out.find(l => /^\s*IF\b/.test(l)) || '';
  const orLine = out.find(l => /^\s*OR\b/.test(l)) || '';
  const moveLine = out.find(l => /\bMOVE -3\b/.test(l)) || '';
  const endIf = out.find(l => /\bEND-IF\b/.test(l)) || '';

  assert(col1(ifLine) === 12, 'IF reflow: IF a colonna 12');
  assert(/\bAND\s*$/.test(ifLine), 'IF reflow: AND deve essere in coda alla riga IF');
  assert(col1(orLine) === 12, 'IF reflow: OR a inizio riga (col 12)');

  // Gli = delle sotto-condizioni devono essere incolonnati.
  const eqCols = out
    .filter(l => /=/.test(l) && /'X'|'A'/.test(l))
    .map(l => l.indexOf('='));
  assert(eqCols.length >= 3 && eqCols.every(c => c === eqCols[0]),
    'IF reflow: gli = devono essere incolonnati');

  assert(col1(moveLine) === 15, 'IF reflow: il body deve essere indentato a col 15');
  assert(col1(endIf) === 12, 'IF reflow: END-IF a col 12');

  const out2 = computeFormatted(out, procDefOf(out)).join('\n').split('\n');
  assert(out.join('\n') === out2.join('\n'), 'IF reflow: non idempotente');

  // IF semplice: non toccato.
  const srcS = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-IF2.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           IF A = 1',
    '              MOVE 1 TO B',
    '           END-IF.',
    ''
  ];
  const outS = computeFormatted(srcS, procDefOf(srcS)).join('\n').split('\n');
  assert(outS.some(l => /\bIF A = 1\b/.test(l)),
    'IF reflow: un IF semplice non deve essere spezzato');

  // Regressione: la parentesi aperta della prima sotto-condizione non deve
  // essere cancellata (issue parentesi iniziale di IF).
  const srcParen = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-IFPAREN.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           IF (W817-LIBPAG (X) NOT = SPACE AND LOW-VALUE)',
    '              MOVE W817-LIBPAG (X) TO PGANSO-LIBPAG',
    '           END-IF.',
    '           GOBACK.',
    ''
  ];
  const outParen = computeFormatted(srcParen, procDefOf(srcParen)).join('\n').split('\n');
  const ifParenLine = outParen.find(l => /^\s*IF\b/.test(l)) || '';
  assert(/\bIF\(/.test(ifParenLine),
    'IF reflow: la parentesi aperta della prima sotto-condizione deve essere preservata senza spazio');
  const lowValueLine = outParen.find(l => /LOW-VALUE\)/.test(l)) || '';
  assert(col1(lowValueLine) === 15,
    'IF reflow: LOW-VALUE) deve essere allineato alla colonna degli operandi (15)');
  const outParen2 = computeFormatted(outParen, procDefOf(outParen)).join('\n').split('\n');
  assert(outParen.join('\n') === outParen2.join('\n'), 'IF reflow parentesi: non idempotente');

  // Regressione OR: gli AND/OR interni a una sotto-condizione non devono
  // essere interpretati come separatori di livello superiore; la parentesi
  // aperta del ramo dopo OR deve rimanere e il layout deve essere idempotente.
  const srcOrParen = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-IFOR.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           IF (W817-CODFIL (X) NOT = SPACES AND ZERO) AND',
    '              (W817-LIBPAG (X) NOT = SPACES AND ZERO) OR',
    '              (W817-QUALIF (X) NOT = SPACES AND ZERO)',
    '              MOVE \'6\' TO AREA-TIPO-ELAB',
    '           END-IF.',
    '           GOBACK.',
    ''
  ];
  const outOrParen = computeFormatted(srcOrParen, procDefOf(srcOrParen)).join('\n').split('\n');
  const orParenLine = outOrParen.find(l => /^\s*OR\b/.test(l)) || '';
  assert(/\bOR\(/.test(orParenLine),
    'IF reflow OR: la parentesi aperta del ramo dopo OR deve essere preservata senza spazio');
  const outOrParen2 = computeFormatted(outOrParen, procDefOf(outOrParen)).join('\n').split('\n');
  assert(outOrParen.join('\n') === outOrParen2.join('\n'), 'IF reflow OR: non idempotente');

  console.log('OK - test regressione reflow condizione IF superati');
}

// ---------------------------------------------------------------------------
// Formatter Stage 2 - righe vuote ANCHE dentro i blocchi: uno statement di
// verbo diverso (o di blocco) dentro un IF riceve una riga vuota rispetto ai
// precedenti allo stesso livello; i verbi uguali restano ravvicinati.
// ---------------------------------------------------------------------------
function runNestedBlankTests() {
  const { formatDocument } = require('../src/cobol-formatter');
  const { parseCobolSymbols } = require('../src/cobol-parser');
  const memPath = path.join(workDir, 'NESTBLK.CBL');

  function procDefOf(lines) {
    const set = new Set();
    for (const sym of parseCobolSymbols(memPath, lines.join('\n'), workDir)) {
      if ((sym.type === 'paragraph' || sym.type === 'section') && sym.filePath === memPath) {
        set.add(sym.line);
      }
    }
    return set;
  }
  function blankBefore(lines, re) {
    const i = lines.findIndex(l => re.test(l));
    return i > 0 && lines[i - 1].trim() === '';
  }

  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NB.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           IF A = 0',
    '              MOVE 1 TO B',
    '              MOVE 2 TO C',
    '              PERFORM SUB',
    '           END-IF.',
    '           GOBACK.',
    '       SUB.',
    '           CONTINUE.',
    ''
  ];
  const out = formatDocument(src, procDefOf(src), { blankLines: true });
  assert(blankBefore(out, /\bPERFORM SUB\b/),
    'Nested: attesa riga vuota prima del PERFORM dentro l\'IF');
  assert(!blankBefore(out, /\bMOVE 2\b/),
    'Nested: nessuna riga vuota tra due MOVE consecutivi');

  const out2 = formatDocument(out, procDefOf(out), { blankLines: true });
  assert(out.join('\n') === out2.join('\n'),
    'Nested blank: la 2a formattazione cambia l\'output (non idempotente)');

  console.log('OK - test regressione righe vuote dentro i blocchi superati');
}

// formattato deve essere un no-op. Copre i vincoli citati nell'issue:
// tracciati copybook-only, nesting profondo, liste di 88, REDEFINES/OCCURS/ODO
// e righe di dati vicino/oltre la colonna 72 (con continuazione del letterale).
// Verificato sia sullo Stage 1 (computeFormatted) sia sullo Stage 1+2
// (formatDocument con separatori e righe vuote).
// ---------------------------------------------------------------------------
function runFormatterIdempotencyTests() {
  const { computeFormatted, formatDocument } = require('../src/cobol-formatter');
  const { parseCobolSymbols } = require('../src/cobol-parser');

  const memPath = path.join(workDir, 'IDEMPOT.CBL');

  // computeFormatted puo' restituire un elemento con '\n' incorporati (letterale
  // spezzato su piu' righe): va appiattito in righe fisiche reali prima di
  // ri-formattare o confrontare, come fanno il provider e gli altri test.
  function flat(lines) {
    return lines.join('\n').split('\n');
  }

  // Ricava le righe di definizione paragrafo/sezione (PROCEDURE) dal testo,
  // esattamente come fa il provider del formatter. Va RICALCOLATO a ogni
  // passata perche' gli indici di riga possono cambiare.
  function procDefOf(lines) {
    const set = new Set();
    for (const sym of parseCobolSymbols(memPath, lines.join('\n'), workDir)) {
      if ((sym.type === 'paragraph' || sym.type === 'section') && sym.filePath === memPath) {
        set.add(sym.line);
      }
    }
    return set;
  }

  function assertSame(label, once, twice) {
    assert(once.length === twice.length,
      `${label}: la 2a formattazione cambia il numero di righe (${once.length} vs ${twice.length})`);
    for (let k = 0; k < once.length; k++) {
      assert(once[k] === twice[k],
        `${label}: riga ${k} cambiata alla 2a formattazione\n  1: "${once[k]}"\n  2: "${twice[k]}"`);
    }
  }

  // format(format(x)) === format(x). Ritorna l'output stabilizzato (righe fisiche).
  function assertStage1Idempotent(label, src, options) {
    const once = flat(computeFormatted(src, procDefOf(src), options));
    const twice = flat(computeFormatted(once, procDefOf(once), options));
    assertSame(`${label} [Stage 1]`, once, twice);
    return once;
  }
  function assertStage2Idempotent(label, src, options) {
    const once = flat(formatDocument(src, procDefOf(src), options));
    const twice = flat(formatDocument(once, procDefOf(once), options));
    assertSame(`${label} [Stage 2]`, once, twice);
    return once;
  }

  const contenuto150 = '0123456789ABCDE'.repeat(10); // 150 caratteri

  // Fixture 1: programma completo, DATA "sporca" con tutti i costrutti critici
  // + PROCEDURE con IF/ELSE, EVALUATE/WHEN, PERFORM ... THRU.
  const prog = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-IDEM.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    "       01  WS-STATO      PIC X(01)   VALUE 'A'.",
    "          88  WS-STATO-OK      VALUE 'A'.",
    "          88  WS-STATO-KO   VALUE 'B' 'C' 'D'.",
    '       01 WS-TAB.',
    '         05 WS-ELEM OCCURS 10 TIMES.',
    '           10 WS-COD    PIC X(04).',
    '           10 WS-DESC   PIC X(20).',
    '           10 WS-FLG    PIC 9(01).',
    '              88 WS-FLG-SI VALUE 1.',
    '       01 WS-CNT   PIC 9(003) VALUE 0.',
    '       01 WS-VAR-TAB.',
    '          05 WS-VAR-EL OCCURS 1 TO 50 DEPENDING ON WS-CNT PIC X(005).',
    '       01 WS-AREA PIC X(20).',
    '       01 WS-AREA-R REDEFINES WS-AREA.',
    '          05 WS-R-A PIC X(10).',
    '          05 WS-R-B PIC X(10).',
    "       01 WS-LUNGA  PIC X(40)  VALUE 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.",
    "       01 WS-XL PIC X(150) VALUE '" + contenuto150 + "'.",
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           PERFORM INIT-PARA',
    '           THRU INIT-PARA-EX.',
    '           IF WS-STATO-OK',
    '              MOVE 1 TO WS-CNT',
    '           ELSE',
    '              MOVE 0 TO WS-CNT',
    '           END-IF.',
    '           EVALUATE TRUE',
    '              WHEN WS-FLG-SI',
    "                 MOVE 'X' TO WS-COD (1)",
    '              WHEN OTHER',
    '                 CONTINUE',
    '           END-EVALUATE.',
    '           GOBACK.',
    '       INIT-PARA.',
    '           MOVE ZERO TO WS-CNT.',
    '       INIT-PARA-EX.',
    '           EXIT.',
    ''
  ];
  const stab1 = assertStage1Idempotent('Programma completo (default)', prog);
  // Ulteriore garanzia: gia' l'output stabilizzato e' un punto fisso.
  assertStage1Idempotent('Programma completo (ri-input stabilizzato)', stab1);
  // Colonna PIC e passo indent personalizzati.
  assertStage1Idempotent('Programma completo (pic=40, step=2)', prog,
    { pictureColumn: 40, indentStep: 2 });
  // Stage 1 + Stage 2 (separatori + righe vuote).
  assertStage2Idempotent('Programma completo (Stage 2)', prog,
    { sectionSeparators: true, blankLines: true });

  // Fixture 2: copybook di soli DATI (nessun header DIVISION), con 88 in lista,
  // OCCURS, REDEFINES e sottogruppi annidati.
  const copyData = [
    '      * Tracciato dati di prova',
    '       01 CP-AREA.',
    '          05 CP-FLAG PIC X.',
    "             88 CP-FLAG-ON  VALUE 'S'.",
    "             88 CP-FLAG-OFF VALUE 'N'.",
    '          05 CP-CHIAVE.',
    '             10 CP-COD OCCURS 5 PIC X(04).',
    '             10 CP-SUB.',
    '                15 CP-A PIC 9(02).',
    '                15 CP-B PIC 9(02).',
    '          05 CP-DATI PIC X(4000).',
    '          05 CP-DATI-R REDEFINES CP-DATI.',
    '             10 CP-EL OCCURS 100 PIC X(40).',
    ''
  ];
  assertStage1Idempotent('Copybook dati (88/OCCURS/REDEFINES)', copyData);

  // Fixture 3: copybook di sole PROCEDURE (statement, nessuna voce dati).
  const copyProc = [
    '      * Frammento di procedure',
    '           MOVE ZERO TO WS-CNT',
    '           IF WS-CNT = 0',
    '           PERFORM RT-A',
    '           THRU RT-A-EX',
    '           END-IF.',
    ''
  ];
  assertStage1Idempotent('Copybook procedure', copyProc);

  console.log('OK - test regressione formatter idempotenza (issue #1) superati');
}

// ---------------------------------------------------------------------------
// Colorazione semantica - maskPicture: la stringa di PICTURE (dopo PIC/PICTURE)
// viene mascherata cosi' i suoi caratteri (X/A/N/9/S/V...) non vengano colorati
// come variabili quando coincidono con un nome di simbolo (es. variabile `X`);
// la lunghezza della riga (colonne) resta invariata.
// ---------------------------------------------------------------------------
// missing-period: identificatore in Area A (colonne 8-11) senza punto sulla
// frase precedente, assunto dal compilatore come nuovo paragrafo implicito
// (stesso errore Micro Focus 1069-E "Identifier in area A assumed procedure
// name. Period missing before it.").
// ---------------------------------------------------------------------------
function runMissingPeriodAreaATests() {
  const { runLinter } = require('../src/cobol-linter');

  // Caso positivo: MOVE senza punto finale, seguito da un identificatore
  // in Area A (7 spazi di indentazione, come i nomi di paragrafo).
  const areaAProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-AREAA.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           MOVE WS-A TO WS-B',
    '       WS-C NOT EQUAL SPACES',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(areaAProgram.join('\n'), workDir), areaAProgram,
      'missing-period', 'WS-C NOT EQUAL SPACES'),
    'Atteso missing-period (identificatore in Area A) quando la frase precedente non termina con un punto'
  );

  // Controllo: se la MOVE termina correttamente con un punto, nessuna
  // segnalazione (WS-C resta un semplice refuso di indentazione innocuo per
  // questa regola).
  const areaAOkProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-AREAAOK.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           MOVE WS-A TO WS-B.',
    '       WS-C NOT EQUAL SPACES',
    '           GOBACK.',
    ''
  ];
  assert(
    !findDiagOnLine(runLinter(areaAOkProgram.join('\n'), workDir), areaAOkProgram,
      'missing-period', 'WS-C NOT EQUAL SPACES'),
    'Non atteso missing-period quando la frase precedente termina gia\' con un punto'
  );

  // Controllo: una parola riservata (IF) in Area A non e' un identificatore
  // utente, quindi non deve attivare questa regola anche senza punto prima.
  const areaAKeywordProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-AREAAKW.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           MOVE WS-A TO WS-B',
    '       IF WS-C EQUAL SPACES',
    '              CONTINUE',
    '           END-IF.',
    '           GOBACK.',
    ''
  ];
  assert(
    !findDiagOnLine(runLinter(areaAKeywordProgram.join('\n'), workDir), areaAKeywordProgram,
      'missing-period', 'IF WS-C EQUAL SPACES'),
    'Non atteso missing-period (Area A) su una parola riservata come IF'
  );

  console.log('OK - test regressione missing-period (identificatore Area A) superati');
}

// ---------------------------------------------------------------------------
// 88 VALUES su piu' righe (elenco di valori numerici + punto terminatore su
// una riga a se'): la continuazione NON deve essere scambiata per una nuova
// voce dati (falso positivo missing-period / pic-missing).
// ---------------------------------------------------------------------------
function runMultilineConditionValuesTests() {
  const { runLinter } = require('../src/cobol-linter');

  const multilineValuesProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-88MULTI.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       10 PGKEYS-P-QUALIF-N        PIC 9(2).',
    '           88 PGKEYS-P-QUALIF-N-DIRIGENTI VALUES',
    '               5 15 19 35 39 55',
    '           .',
    '           88 PGKEYS-P-QUALIF-N-COLAB     VALUES',
    '               9 29',
    '           .',
    '       PROCEDURE DIVISION.',
    '           GOBACK.',
    ''
  ];
  const diags = runLinter(multilineValuesProgram.join('\n'), workDir);
  assert(
    !diags.some(d => d.code === 'missing-period'),
    'Non atteso missing-period sulla clausola VALUES di un 88 continuata su piu\' righe con punto su riga separata'
  );
  assert(
    !diags.some(d => d.code === 'pic-missing'),
    'Non atteso pic-missing: i numeri della continuazione VALUES non sono una nuova voce dati'
  );
  assert(
    !diags.some(d => d.code === 'unused-variable' && (d._symbolName === '15' || d._symbolName === '29')),
    'Non atteso unused-variable su \'15\'/\'29\': non sono voci dati, sono valori della continuazione VALUES'
  );

  console.log('OK - test regressione 88 VALUES su piu\' righe (missing-period/pic-missing) superati');
}

// ---------------------------------------------------------------------------
// unused-variable: un livello 88 mai testato (IF/WHEN/SET ... TO TRUE) va
// segnalato come non utilizzato ANCHE SE il campo genitore e' usato altrove
// (usare il genitore, es. MOVE, non equivale a testare la condizione).
// ---------------------------------------------------------------------------
function runUnusedConditionNameTests() {
  const { runLinter } = require('../src/cobol-linter');

  const unusedFlagLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-UNUSEDFLAG.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-FLAG                PIC 9(01) VALUE 0.',
    '           88 WS-FLAG-ON         VALUE 1.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  const unusedFlagDiags = runLinter(unusedFlagLines.join('\n'), workDir);
  assert(
    unusedFlagDiags.some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-FLAG'),
    'Atteso unused-variable su WS-FLAG (mai usato nella PROCEDURE DIVISION)'
  );
  assert(
    unusedFlagDiags.some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-FLAG-ON'),
    'Atteso unused-variable anche sul livello 88 WS-FLAG-ON (condizione mai testata)'
  );

  // Controllo: se il livello 88 e' effettivamente testato (IF), non va
  // segnalato, anche se il campo genitore non compare mai altrove.
  const usedFlagLines = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-USEDFLAG.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-FLAG                PIC 9(01) VALUE 0.',
    '           88 WS-FLAG-ON         VALUE 1.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           IF WS-FLAG-ON',
    '               CONTINUE',
    '           END-IF.',
    '           GOBACK.',
    ''
  ];
  assert(
    !runLinter(usedFlagLines.join('\n'), workDir).some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-FLAG-ON'),
    'Non atteso unused-variable su WS-FLAG-ON quando la condizione e\' testata con IF'
  );

  console.log('OK - test regressione unused-variable su condition-name (88) superati');
}

// ---------------------------------------------------------------------------
// consecutive-periods: due punti senza istruzione tra i due (es. "END-IF..")
// ---------------------------------------------------------------------------
function runConsecutivePeriodsTests() {
  const { runLinter } = require('../src/cobol-linter');

  // Caso positivo: due punti sullo stesso rigo, nessuna istruzione tra i due.
  const doubleDotProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DOUBLEDOT.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           IF WS-A EQUAL WS-B',
    '              GO TO EX-LEGGE',
    '           END-IF..',
    '       EX-LEGGE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !!findDiagOnLine(runLinter(doubleDotProgram.join('\n'), workDir), doubleDotProgram,
      'consecutive-periods', 'END-IF..'),
    'Atteso consecutive-periods su "END-IF.." (nessuna istruzione tra i due punti)'
  );

  // Controllo: un solo punto finale non deve essere segnalato.
  const singleDotProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SINGLEDOT.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           IF WS-A EQUAL WS-B',
    '              GO TO EX-LEGGE',
    '           END-IF.',
    '       EX-LEGGE.',
    '           GOBACK.',
    ''
  ];
  assert(
    !findDiagOnLine(runLinter(singleDotProgram.join('\n'), workDir), singleDotProgram,
      'consecutive-periods', 'END-IF.'),
    'Non atteso consecutive-periods su "END-IF." (un solo punto finale, corretto)'
  );

  // Controllo: un punto decimale (COMPUTE con letterale numerico) non deve
  // essere segnalato come punti consecutivi.
  const decimalProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DECIMAL.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           COMPUTE WS-A = 3.14.',
    '           GOBACK.',
    ''
  ];
  assert(
    !findDiagOnLine(runLinter(decimalProgram.join('\n'), workDir), decimalProgram,
      'consecutive-periods', 'COMPUTE WS-A'),
    'Non atteso consecutive-periods su un letterale decimale (3.14)'
  );

  console.log('OK - test regressione consecutive-periods superati');
}

// ---------------------------------------------------------------------------
// JSON GENERATE (dialetto entcobol): keyword, special register, NAME OF
// ---------------------------------------------------------------------------
function runJsonGenerateTests() {
  const { runLinter } = require('../src/cobol-linter');

  const program = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGMJSON.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-BUF                    PIC X(2000).',
    '       01 WS-LEN                    PIC S9(9) COMP-5.',
    '       01 CERT-DATI.',
    '          05 CD-NOME                PIC X(30).',
    '          05 IM-TAB OCCURS 5 TIMES.',
    '             10 IM-DESCRIZIONE      PIC X(50).',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           MOVE SPACES TO WS-BUF',
    '           JSON GENERATE WS-BUF FROM CERT-DATI',
    '               COUNT IN WS-LEN',
    '               NAME OF',
    '                  CERT-DATI IS OMITTED',
    '                  CD-NOME IS "nome"',
    '                  IM-TAB IS "impegni"',
    '                  IM-DESCRIZIONE IS "descrizione"',
    '               ON EXCEPTION',
    '                  DISPLAY "KO " JSON-CODE',
    '           END-JSON',
    '           GOBACK.',
    '       END PROGRAM PGMJSON.',
    ''
  ];
  const diags = runLinter(program.join('\n'), workDir);

  for (const name of ['JSON', 'NAME', 'JSON-CODE', 'END-JSON', 'PGMJSON']) {
    assert(
      !diags.some(d => String(d.code) === 'undefined-variable' && d.message.includes(`'${name}'`)),
      `Non atteso undefined-variable su '${name}' (istruzione JSON GENERATE)`
    );
  }

  assert(
    !diags.some(d => String(d.code) === 'unsubscripted-occurs'),
    'Non atteso unsubscripted-occurs dentro la frase NAME OF di JSON GENERATE'
  );

  // Controllo: fuori dalla frase NAME OF la regola OCCURS resta attiva.
  const badProgram = program.slice(0, -3).concat([
    '           MOVE SPACES TO IM-TAB',
    '           GOBACK.',
    '       END PROGRAM PGMJSON.',
    ''
  ]);
  assert(
    !!findDiagOnLine(runLinter(badProgram.join('\n'), workDir), badProgram,
      'unsubscripted-occurs', 'MOVE SPACES TO IM-TAB'),
    'Atteso unsubscripted-occurs su IM-TAB fuori dalla frase NAME OF'
  );

  console.log('OK - test regressione JSON GENERATE (NAME OF, special register) superati');
}

// ---------------------------------------------------------------------------
function runMaskPictureTests() {
  const { maskPicture } = require('../src/cobol-semantic');

  const line = '       01 W-COD-CAMPO             PIC X(03).';
  const masked = maskPicture(line);
  assert(masked.length === line.length,
    'maskPicture deve preservare la lunghezza della riga');
  assert(!/X\(03\)/.test(masked),
    'maskPicture deve mascherare la stringa di PICTURE (X(03))');
  assert(/W-COD-CAMPO/.test(masked),
    'maskPicture non deve toccare il nome della variabile');
  assert(/\bPIC\b/.test(masked),
    'maskPicture deve conservare la parola PIC');

  const line2 = '       05 WS-N   PIC S9(4)V99.';
  const masked2 = maskPicture(line2);
  assert(!/S9\(4\)V99/.test(masked2),
    'maskPicture deve mascherare anche le PICTURE numeriche');
  assert(masked2.length === line2.length,
    'maskPicture deve preservare la lunghezza (2)');

  console.log('OK - test regressione maskPicture (colorazione semantica PICTURE) superati');
}

// ---------------------------------------------------------------------------
// program-id-filename: il nome dopo PROGRAM-ID deve coincidere col file
// ---------------------------------------------------------------------------
function runProgramIdFilenameTests() {
  const { runLinter } = require('../src/cobol-linter');

  const program = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID.     TEST_CRISTIAN.',
    '       AUTHOR.         RENDANI.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           GOBACK.',
    ''
  ];

  assert(
    !findDiagOnLine(runLinter(program.join('\n'), workDir, 'TEST_CRISTIAN'), program,
      'program-id-filename', 'PROGRAM-ID'),
    'Non atteso program-id-filename quando il nome del file combacia con PROGRAM-ID'
  );
  assert(
    !!findDiagOnLine(runLinter(program.join('\n'), workDir, 'ALTRO_NOME'), program,
      'program-id-filename', 'PROGRAM-ID'),
    'Atteso program-id-filename quando il nome del file NON combacia con PROGRAM-ID'
  );
  assert(
    !findDiagOnLine(runLinter(program.join('\n'), workDir), program,
      'program-id-filename', 'PROGRAM-ID'),
    'Senza fileBaseName la regola non deve produrre diagnosi (retrocompatibilita\')'
  );

  console.log('OK - test regressione program-id-filename superati');
}

// ---------------------------------------------------------------------------
// Dimensioni (v1.30.0): USAGE nei letterali/commenti, USAGE di gruppo,
// simbolo P, FLOAT-SHORT/LONG, PIC X su binari
// ---------------------------------------------------------------------------
function runSizeEngineFixTests() {
  const { collectLayout, setBinaryStorageMode } = require('../src/cobol-layout');
  const { runLinter } = require('../src/cobol-linter');
  setBinaryStorageMode('ibmcomp');

  const lines = [
    '       WORKING-STORAGE SECTION.',
    '       01 L-PTR   PIC X(30) VALUE "POINTER NON VALIDO".',
    "       01 L-IDX   PIC X(20) VALUE 'INDEX ERRATO'.",
    '       01 L-BIN   PIC X(20) VALUE "TIPO BINARY".',
    '       01 L-CMT   PIC X(5). *> l\'importo COMP-3',
    '       01 G-PACK  COMP-3.',
    '          05 G-PACK-A  PIC S9(7).',
    '          05 G-PACK-B  PIC S9(3).',
    '          05 G-PACK-C.',
    '             10 G-PACK-D  PIC 9(5).',
    '       01 G-PTR   USAGE POINTER.',
    '          05 G-PTR-A.',
    '          05 G-PTR-B.',
    '       01 G-BIN   BINARY.',
    '          05 G-BIN-A  PIC 9(3).',
    '       01 G-DISP.',
    '          05 G-DISP-A PIC 9(3) COMP.',
    '          05 G-DISP-B PIC 9(3).',
    '       01 P-PACK  PIC 9(3)PP COMP-3.',
    '       01 P-DISP  PIC 9(3)PP.',
    '       01 F-LONG  FLOAT-LONG.',
    '       01 F-SHORT FLOAT-SHORT.',
    '       01 C5-ALNUM PIC X(4) COMP-5.',
    '       01 CX-NUM  PIC 9(4) COMP-X.',
    '       PROCEDURE DIVISION.',
    ''
  ];
  const expected = {
    'L-PTR': 30, 'L-IDX': 20, 'L-BIN': 20, 'L-CMT': 5,
    'G-PACK': 9, 'G-PACK-A': 4, 'G-PACK-B': 2, 'G-PACK-C': 3, 'G-PACK-D': 3,
    'G-PTR': 8, 'G-PTR-A': 4, 'G-PTR-B': 4,
    'G-BIN': 2, 'G-BIN-A': 2,
    'G-DISP': 5, 'G-DISP-A': 2, 'G-DISP-B': 3,
    'P-PACK': 2, 'P-DISP': 3,
    'F-LONG': 8, 'F-SHORT': 4,
    'C5-ALNUM': 4, 'CX-NUM': 2
  };
  const layout = collectLayout(lines);
  for (const name of Object.keys(expected)) {
    const it = layout.find(x => x.name === name);
    assert(it, `Campo ${name} non trovato nel layout`);
    assert(it.size === expected[name],
      `${name} atteso ${expected[name]} byte, ottenuto ${it.size}`);
  }

  // redefines-size usa lo stesso motore: il gruppo con COMP-3 a livello di
  // gruppo vale 6 byte (4+2), quindi un REDEFINES di 6 byte non va segnalato.
  const prog = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SIZES.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-TOT COMP-3.',
    '          05 WS-TOT-A  PIC S9(7).',
    '          05 WS-TOT-B  PIC S9(3).',
    '       01 WS-TOT-R REDEFINES WS-TOT PIC X(6).',
    '       01 WS-MSG PIC X(30) VALUE "POINTER NON VALIDO".',
    '       01 WS-MSG-R REDEFINES WS-MSG PIC X(30).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  const okDiags = runLinter(prog.join('\n'), workDir)
    .filter(d => String(d.code) === 'redefines-size');
  assert(okDiags.length === 0,
    'Non atteso redefines-size (USAGE di gruppo / USAGE nel letterale): '
      + okDiags.map(d => d.message).join(' | '));

  const koProg = prog.slice();
  koProg[7] = '       01 WS-TOT-R REDEFINES WS-TOT PIC X(10).';
  const koDiags = runLinter(koProg.join('\n'), workDir)
    .filter(d => String(d.code) === 'redefines-size');
  assert(koDiags.length > 0,
    'Atteso redefines-size: WS-TOT (6 byte) ridefinito con 10 byte');

  // FLOAT-LONG / FLOAT-SHORT non richiedono PIC: niente pic-missing.
  const floatProg = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-FLOAT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-FL  FLOAT-LONG.',
    '       01 WS-FS  FLOAT-SHORT.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  const floatDiags = runLinter(floatProg.join('\n'), workDir)
    .filter(d => String(d.code) === 'pic-missing');
  assert(floatDiags.length === 0,
    'Non atteso pic-missing su FLOAT-LONG/FLOAT-SHORT: ' + floatDiags.map(d => d.message).join(' | '));

  console.log('OK - test regressione motore dimensioni (letterali, USAGE di gruppo, P, FLOAT) superati');
}

// ---------------------------------------------------------------------------
// cobolLens.binaryStorage: COMP/COMP-4/BINARY/COMP-5 con IBMCOMP e NOIBMCOMP
// ---------------------------------------------------------------------------
function runBinaryStorageTests() {
  const { elementarySize, setBinaryStorageMode, getBinaryStorageMode } = require('../src/cobol-layout');
  const { runLinter } = require('../src/cobol-linter');

  // [pic, ibmcomp, noibmcomp]
  const cases = [
    ['S9(1)', 2, 1], ['S9(2)', 2, 1], ['S9(3)', 2, 2], ['S9(4)', 2, 2],
    ['S9(5)', 4, 3], ['S9(6)', 4, 3], ['S9(7)', 4, 4], ['S9(9)', 4, 4],
    ['S9(10)', 8, 5], ['S9(11)', 8, 5], ['S9(12)', 8, 6], ['S9(14)', 8, 6],
    ['S9(15)', 8, 7], ['S9(16)', 8, 7], ['S9(17)', 8, 8], ['S9(18)', 8, 8],
    ['9(2)', 2, 1], ['9(4)', 2, 2], ['9(5)', 4, 3], ['9(7)', 4, 3],
    ['9(8)', 4, 4], ['9(9)', 4, 4], ['9(12)', 8, 5], ['9(13)', 8, 6],
    ['9(16)', 8, 7], ['9(18)', 8, 8],
    ['S9(5)V99', 4, 4], ['9(3)PP', 2, 2]
  ];
  const usages = ['COMP', 'COMP-4', 'COMP-5'];

  try {
    setBinaryStorageMode('ibmcomp');
    assert(getBinaryStorageMode() === 'ibmcomp', 'Modalita\' attesa ibmcomp');
    for (const [pic, ibm] of cases) {
      for (const usage of usages) {
        const got = elementarySize({ pic, usage });
        assert(got === ibm, `[ibmcomp] PIC ${pic} ${usage} atteso ${ibm} byte, ottenuto ${got}`);
      }
    }

    setBinaryStorageMode('noibmcomp');
    assert(getBinaryStorageMode() === 'noibmcomp', 'Modalita\' attesa noibmcomp');
    for (const [pic, , noibm] of cases) {
      for (const usage of usages) {
        const got = elementarySize({ pic, usage });
        assert(got === noibm, `[noibmcomp] PIC ${pic} ${usage} atteso ${noibm} byte, ottenuto ${got}`);
      }
    }

    // La modalita' non tocca gli altri usage.
    assert(elementarySize({ pic: 'S9(7)', usage: 'COMP-3' }) === 4, 'COMP-3 non deve dipendere da binaryStorage');
    assert(elementarySize({ pic: '9(4)', usage: 'COMP-X' }) === 2, 'COMP-X non deve dipendere da binaryStorage');
    assert(elementarySize({ pic: 'S9(4)', usage: 'DISPLAY' }) === 4, 'DISPLAY non deve dipendere da binaryStorage');

    // Valori non riconosciuti tornano al default.
    setBinaryStorageMode('boh');
    assert(getBinaryStorageMode() === 'ibmcomp', 'Valore non valido: atteso fallback a ibmcomp');
    setBinaryStorageMode(undefined);
    assert(getBinaryStorageMode() === 'ibmcomp', 'Valore assente: atteso fallback a ibmcomp');

    // redefines-size segue la modalita': WS-B1-R (COMP) ridefinisce WS-B1 (1
    // byte) con un COMP S9(2) che in ibmcomp vale 2 byte (piu' grande, errore)
    // e in noibmcomp vale 1 byte (coincide, nessun errore).
    const prog = [
      '       IDENTIFICATION DIVISION.',
      '       PROGRAM-ID. PGM-BINSTG.',
      '       DATA DIVISION.',
      '       WORKING-STORAGE SECTION.',
      '       01 WS-B1   PIC X(1).',
      '       01 WS-B1-R REDEFINES WS-B1 PIC S9(2) COMP.',
      '       PROCEDURE DIVISION.',
      '       MAIN.',
      '           GOBACK.',
      ''
    ].join('\n');
    setBinaryStorageMode('ibmcomp');
    const ibmDiags = runLinter(prog, workDir).filter(d => String(d.code) === 'redefines-size');
    assert(ibmDiags.length > 0, '[ibmcomp] atteso redefines-size: WS-B1 = 1 byte, ridefinito con S9(2) COMP = 2 byte');
    setBinaryStorageMode('noibmcomp');
    const noibmDiags = runLinter(prog, workDir).filter(d => String(d.code) === 'redefines-size');
    assert(noibmDiags.length === 0,
      '[noibmcomp] non atteso redefines-size: S9(2) COMP = 1 byte: ' + noibmDiags.map(d => d.message).join(' | '));
  } finally {
    setBinaryStorageMode('ibmcomp');
  }

  console.log('OK - test regressione binaryStorage (IBMCOMP / NOIBMCOMP) superati');
}

// ---------------------------------------------------------------------------
// end-structure / SECTION / PERFORM (v1.30.1): PERFORM out-of-line con UNTIL,
// trattini nei nomi, punto decimale, PERFORM inline nudo, SECTION come
// bersagli, PERFORM a meta' riga, THROUGH.
// ---------------------------------------------------------------------------
function runPerformSectionTests() {
  const { runLinter } = require('../src/cobol-linter');
  const has = (diags, lines, code, snippet) => !!findDiagOnLine(diags, lines, code, snippet);

  const es = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-ES.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-IF-FLAG    PIC X.',
    '       01 WS-EOF        PIC X.',
    '       01 WS-N          PIC 9.',
    '       01 WS-X          PIC 9(5)V99.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    "           PERFORM CICLO-PARA UNTIL WS-EOF = 'S'.",
    '           MOVE WS-IF-FLAG TO WS-EOF.',
    "           IF WS-EOF = 'S'",
    '              COMPUTE WS-X = WS-X * 1.05',
    '           END-IF.',
    '           PERFORM',
    '              MOVE 1 TO WS-N',
    '           END-PERFORM.',
    '           PERFORM WS-N TIMES',
    '              MOVE 2 TO WS-N',
    '           END-PERFORM.',
    "           IF WS-EOF = 'X'",
    '              MOVE 3 TO WS-N.',
    "           PERFORM UNTIL WS-EOF = 'S'",
    "              MOVE 'S' TO WS-EOF.",
    '           GOBACK.',
    '       CICLO-PARA.',
    "           MOVE 'S' TO WS-EOF.",
    ''
  ];
  const esDiags = runLinter(es.join('\n'), workDir);
  assert(!has(esDiags, es, 'end-structure', 'PERFORM CICLO-PARA UNTIL'),
    'end-structure: PERFORM <paragrafo> UNTIL e\' out-of-line, niente END-PERFORM');
  assert(!has(esDiags, es, 'end-structure', 'MOVE WS-IF-FLAG'),
    'end-structure: -IF- dentro un nome non e\' un IF');
  assert(!esDiags.some(d => String(d.code) === 'orphan-scope-delimiter'),
    'orphan-scope-delimiter: nessun END-x orfano atteso (punto decimale, PERFORM inline nudo, PERFORM n TIMES): '
      + esDiags.filter(d => String(d.code) === 'orphan-scope-delimiter').map(d => d.message).join(' | '));
  assert(has(esDiags, es, 'end-structure', "IF WS-EOF = 'X'"),
    'end-structure: un IF chiuso dal punto deve restare segnalato');
  assert(has(esDiags, es, 'end-structure', "PERFORM UNTIL WS-EOF = 'S'"),
    'end-structure: un PERFORM inline chiuso dal punto deve restare segnalato');
  assert(!esDiags.some(d => ['undefined-paragraph', 'unused-variable'].includes(String(d.code)) && d._symbolName === 'WS-N'),
    'PERFORM WS-N TIMES: WS-N e\' un contatore, non un paragrafo');

  const sec = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SEC.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-EOF        PIC X.',
    '       PROCEDURE DIVISION.',
    '       MAIN SECTION.',
    '       MAIN-INIZIO.',
    '           PERFORM ALTRA.',
    "           IF WS-EOF = 'N' PERFORM SOLO-IF END-IF.",
    '           PERFORM P-UNO THROUGH P-DUE.',
    '           PERFORM P-TRE',
    '              THROUGH P-UNO.',
    '       MAIN-SECONDO.',
    '           GOBACK.',
    '       MAIN-MORTO.',
    '           CONTINUE.',
    '       SOLO-IF.',
    '           CONTINUE.',
    '       P-UNO.',
    '           CONTINUE.',
    '       P-DUE.',
    '           CONTINUE.',
    '       P-TRE.',
    '           CONTINUE.',
    '       ALTRA SECTION.',
    '       ALTRA-PARA.',
    '           CONTINUE.',
    '       MORTA SECTION.',
    '       MORTA-PARA.',
    '           CONTINUE.',
    ''
  ];
  const secDiags = runLinter(sec.join('\n'), workDir);
  assert(!has(secDiags, sec, 'undefined-paragraph', 'PERFORM ALTRA'),
    'undefined-paragraph: PERFORM di una SECTION definita non va segnalato');
  for (const p of ['ALTRA-PARA.', 'MAIN-SECONDO.', 'SOLO-IF.', 'P-DUE.']) {
    assert(!has(secDiags, sec, 'unused-paragraph', p),
      `unused-paragraph: ${p} e' raggiunto (SECTION eseguita / PERFORM a meta' riga / THROUGH)`);
  }
  assert(has(secDiags, sec, 'unused-paragraph', 'MORTA-PARA.'),
    'unused-paragraph: un paragrafo di una SECTION mai eseguita resta segnalato');
  assert(has(secDiags, sec, 'unused-paragraph', 'MAIN-MORTO.'),
    'unused-paragraph: un paragrafo dopo GOBACK, mai bersaglio, va segnalato anche nella prima SECTION');
  assert(!has(secDiags, sec, 'perform-thru-order', 'PERFORM P-UNO THROUGH'),
    'perform-thru-order: P-UNO THROUGH P-DUE e\' nell\'ordine giusto');
  assert(has(secDiags, sec, 'perform-thru-order', 'PERFORM P-TRE'),
    'perform-thru-order: P-TRE THROUGH P-UNO (su riga successiva) va segnalato');
  assert(!secDiags.some(d => String(d.code) === 'undefined-variable'),
    'undefined-variable: nessuno atteso: ' + secDiags.filter(d => String(d.code) === 'undefined-variable').map(d => d.message).join(' | '));

  console.log('OK - test regressione end-structure / SECTION / PERFORM superati');
}

// ---------------------------------------------------------------------------
// perform-range-exit / perform-thru-mismatch / unused-paragraph strutturale
// (v1.31.0): niente convenzioni di nome per i paragrafi di uscita.
// ---------------------------------------------------------------------------
function runPerformRangeTests() {
  const { runLinter } = require('../src/cobol-linter');
  const has = (diags, lines, code, snippet) => !!findDiagOnLine(diags, lines, code, snippet);
  const head = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-RANGE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-IND        PIC 99.',
    '       PROCEDURE DIVISION.',
  ];

  // THRU dimenticato: il GO TO verso l'uscita (nome qualsiasi) esce dal range.
  const forgot = head.concat([
    '       I0001-INIZIO.',
    '           PERFORM E0001-ELABORAZIONE UNTIL WS-IND > 10.',
    '           PERFORM E0001-ELABORAZIONE',
    '              THRU ESCI-DI-QUA.',
    '           GOBACK.',
    '       E0001-ELABORAZIONE.',
    '           ADD 1 TO WS-IND.',
    '           IF WS-IND > 5',
    '              GO TO ESCI-DI-QUA',
    '           END-IF.',
    '       ESCI-DI-QUA.',
    '           EXIT.',
    ''
  ]);
  const fd = runLinter(forgot.join('\n'), workDir);
  assert(has(fd, forgot, 'perform-range-exit', 'PERFORM E0001-ELABORAZIONE UNTIL'),
    'perform-range-exit: PERFORM senza THRU con GO TO verso l\'uscita va segnalato');
  assert(!has(fd, forgot, 'perform-range-exit', '              THRU ESCI-DI-QUA'),
    'perform-range-exit: con il THRU giusto il GO TO resta nel range');
  assert(!fd.some(d => String(d.code) === 'perform-range-exit' && forgot[d.range.start.line].includes('PERFORM E0001-ELABORAZIONE') && !forgot[d.range.start.line].includes('UNTIL')),
    'perform-range-exit: la PERFORM ... THRU ESCI-DI-QUA non va segnalata');
  assert(has(fd, forgot, 'perform-thru-mismatch', 'PERFORM E0001-ELABORAZIONE UNTIL'),
    'perform-thru-mismatch: stesso paragrafo eseguito con e senza THRU');
  assert(!has(fd, forgot, 'unused-paragraph', 'ESCI-DI-QUA.'),
    'unused-paragraph: ESCI-DI-QUA e\' bersaglio di THRU e GO TO');

  // GO TO verso un paragrafo che chiude il programma: uscita voluta, nessuna segnalazione.
  const abend = head.concat([
    '       I0001-INIZIO.',
    '           PERFORM E0001-ELAB.',
    '           GOBACK.',
    '       E0001-ELAB.',
    '           IF WS-IND > 5',
    '              GO TO Z9999-ABEND',
    '           END-IF.',
    '       Z9999-ABEND.',
    "           DISPLAY 'ERRORE'.",
    '           STOP RUN.',
    ''
  ]);
  assert(!runLinter(abend.join('\n'), workDir).some(d => String(d.code) === 'perform-range-exit'),
    'perform-range-exit: un GO TO verso un paragrafo che chiude il programma non va segnalato');

  // Uscita orfana (THRU dimenticato, nessun GO TO): segnalata come mai raggiunta, qualunque nome abbia.
  const orphan = head.concat([
    '       I0001-INIZIO.',
    '           PERFORM E0001-ELAB.',
    '           GOBACK.',
    '       E0001-ELAB.',
    '           ADD 1 TO WS-IND.',
    '       E0001-EX.',
    '           EXIT.',
    '       PIPPO-99.',
    '           EXIT.',
    ''
  ]);
  const od = runLinter(orphan.join('\n'), workDir);
  assert(has(od, orphan, 'unused-paragraph', 'E0001-EX.'),
    'unused-paragraph: un -EX mai raggiunto va segnalato (niente immunita\' sul nome)');
  assert(has(od, orphan, 'unused-paragraph', 'PIPPO-99.'),
    'unused-paragraph: un\'uscita con nome qualsiasi mai raggiunta va segnalata');

  // Programma a cascata: si va avanti per caduta e GO TO, nessun paragrafo morto.
  const cascade = head.concat([
    '       INIZIO.',
    '           MOVE 0 TO WS-IND.',
    '       CICLO.',
    '           ADD 1 TO WS-IND.',
    '           IF WS-IND < 10 GO TO CICLO.',
    '           IF WS-IND = 99 GO TO ERRORE.',
    '       STAMPA.',
    '           DISPLAY WS-IND.',
    '           GO TO FINE.',
    '       ERRORE.',
    "           DISPLAY 'KO'.",
    '       FINE.',
    '           STOP RUN.',
    '       MORTO.',
    '           CONTINUE.',
    ''
  ]);
  const cd = runLinter(cascade.join('\n'), workDir);
  for (const p of ['CICLO.', 'STAMPA.', 'ERRORE.', 'FINE.']) {
    assert(!has(cd, cascade, 'unused-paragraph', p),
      `unused-paragraph (cascata): ${p} e' raggiunto per caduta o GO TO`);
  }
  assert(has(cd, cascade, 'unused-paragraph', 'MORTO.'),
    'unused-paragraph (cascata): MORTO sta dopo STOP RUN e nessuno ci salta');

  // "PERFORM X THRU" a fine riga con il nome sulla riga dopo (forma reale vista su codice di produzione).
  const tail = head.concat([
    '       I0001-INIZIO.',
    '           PERFORM RT-ELAB THRU',
    '                   EX-ELAB.',
    '           PERFORM RT-ELAB THRU EX-ELAB.',
    '           PERFORM EX-ELAB THRU',
    '                   RT-ELAB.',
    '           GOBACK.',
    '       RT-ELAB.',
    '           IF WS-IND > 5 GO TO EX-ELAB.',
    '           ADD 1 TO WS-IND.',
    '       EX-ELAB. EXIT.',
    ''
  ]);
  const td = runLinter(tail.join('\n'), workDir);
  assert(!td.some(d => ['perform-range-exit', 'perform-thru-mismatch'].includes(String(d.code))),
    'THRU a fine riga: il bersaglio sulla riga dopo va riconosciuto (niente range-exit/mismatch): '
      + td.filter(d => ['perform-range-exit', 'perform-thru-mismatch'].includes(String(d.code))).map(d => d.message).join(' | '));
  assert(has(td, tail, 'perform-thru-order', 'PERFORM EX-ELAB THRU'),
    'perform-thru-order: EX-ELAB THRU RT-ELAB (THRU a fine riga) va segnalato');

  console.log('OK - test regressione perform-range-exit / perform-thru-mismatch / unused-paragraph superati');
}

// ---------------------------------------------------------------------------
// Blocco 2: COPY annidate, REPLACING a parola intera / senza == / LEADING,
// COPY tra apici, COPY ... OF libreria.
// ---------------------------------------------------------------------------
function runBlock3Tests() {
  const { runLinter } = require('../src/cobol-linter');
  const undef = (diags, name) => diags.some(d => String(d.code) === 'undefined-variable' && d.message.includes(name));

  // --- LOCAL-STORAGE SECTION: i suoi campi devono essere riconosciuti ---
  const localStorage = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-LOCST.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-X                      PIC X.',
    '       LOCAL-STORAGE SECTION.',
    '       01 LS-CNT                    PIC 9(003).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE 1 TO LS-CNT.',
    '           GOBACK.',
    ''
  ];
  const lsDiags = runLinter(localStorage.join('\n'), workDir);
  assert(!undef(lsDiags, 'LS-CNT'),
    'LOCAL-STORAGE SECTION: LS-CNT deve essere riconosciuta come definita');

  // --- SCREEN SECTION: non deve ereditare i flag WORKING-STORAGE (niente
  // pic-missing su una voce USING senza PIC) e USING conta come uso. ---
  const screen = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SCR.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-NOME                   PIC X(10).',
    '       SCREEN SECTION.',
    '       01 SCR-GROUP.',
    '           05 LINE 2 COL 5 USING WS-NOME.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           DISPLAY SCR-GROUP.',
    '           GOBACK.',
    ''
  ];
  const scrDiags = runLinter(screen.join('\n'), workDir);
  assert(!scrDiags.some(d => String(d.code) === 'pic-missing'),
    'SCREEN SECTION: una voce USING senza PIC non deve generare pic-missing');
  assert(!scrDiags.some(d => String(d.code) === 'unused-variable' && d.message.includes('WS-NOME')),
    'SCREEN SECTION: USING WS-NOME deve contare come uso di WS-NOME');

  // --- EXEC DLI ... END-EXEC va saltato come EXEC SQL/CICS ---
  const dli = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DLI.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           EXEC DLI',
    '              GU USING PCB SEGMENT(SEG01)',
    '           END-EXEC.',
    '           GOBACK.',
    ''
  ];
  const dliDiags = runLinter(dli.join('\n'), workDir);
  assert(!undef(dliDiags, 'PCB') && !undef(dliDiags, 'SEG01') && !undef(dliDiags, 'GU'),
    'EXEC DLI: GU/PCB/nome segmento non devono dare undefined-variable');

  // --- Letterali non tolti in no-goto/no-at-end/no-else-if/and-or-if ---
  const literalNoise = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-LIT.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           DISPLAY "GO TO THE SHOP".',
    '           DISPLAY "AT END OF THE DAY".',
    '           DISPLAY "ELSE IF YOU CAN".',
    '           DISPLAY "A AND OR IF B".',
    '           GOBACK.',
    ''
  ];
  const litDiags = runLinter(literalNoise.join('\n'), workDir);
  assert(!litDiags.some(d => String(d.code) === 'no-goto'),
    'no-goto: "GO TO" dentro un letterale non deve essere segnalato');
  assert(!litDiags.some(d => String(d.code) === 'no-at-end'),
    'no-at-end: "AT END" dentro un letterale non deve essere segnalato');
  assert(!litDiags.some(d => String(d.code) === 'no-else-if'),
    'no-else-if: "ELSE IF" dentro un letterale non deve essere segnalato');
  assert(!litDiags.some(d => String(d.code) === 'and-or-if'),
    'and-or-if: "AND IF"/"OR IF" dentro un letterale non deve essere segnalato');

  // --- Piu' programmi nello stesso file (END PROGRAM): la seconda
  // IDENTIFICATION DIVISION non va segnalata da section-order. ---
  const multiProgram = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-UNO.',
    '       PROCEDURE DIVISION.',
    '       MAIN-UNO.',
    '           GOBACK.',
    '       END PROGRAM PGM-UNO.',
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DUE.',
    '       PROCEDURE DIVISION.',
    '       MAIN-DUE.',
    '           GOBACK.',
    '       END PROGRAM PGM-DUE.',
    ''
  ];
  const multiDiags = runLinter(multiProgram.join('\n'), workDir);
  assert(!multiDiags.some(d => String(d.code) === 'section-order'),
    'section-order: un secondo programma dopo END PROGRAM non e\' fuori ordine');

  console.log('OK - test regressione blocco 3 (LOCAL-STORAGE/SCREEN/EXEC DLI/letterali/END PROGRAM) superati');
}

function runCopyReplacingTests() {
  const { runLinter } = require('../src/cobol-linter');
  const copyDir = path.join(workDir, 'Copy');
  ensureDir(copyDir);
  const writeCopy = (name, lines) => fs.writeFileSync(path.join(copyDir, name), lines.concat('').join('\n'), 'utf8');
  writeCopy('CB2OUT', ['       01 CB2-REC.', '           COPY CB2IN.']);
  writeCopy('CB2IN', ['           05 CB2-ALF               PIC X(3).', '           05 CB2-NUM               PIC 9(3).']);
  writeCopy('CB2OUTR', ['       01 CB2-RECR.', '           COPY CB2NEST.']);
  writeCopy('CB2NEST', ['           05 :T:-NEST              PIC X.']);
  writeCopy('CB2WORD', ['       01 WS-AB                     PIC X.', '       01 WS-A                      PIC X.']);
  writeCopy('CB2BARE', ['       01 WS-C                      PIC X.']);
  writeCopy('CB2LEAD', ['       01 PFX-CAMPO                 PIC X.']);
  writeCopy('CB2QUOT', ['       01 Q-FIELD                   PIC X.']);
  writeCopy('CB2PROC', ['           MOVE SPACES TO WS-X.']);

  const prog = (data, proc) => [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CB2.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-X                      PIC X.',
  ].concat(data, ['       PROCEDURE DIVISION.', '       MAIN.'], proc, ['           GOBACK.', '']);
  const undef = (diags, name) => diags.some(d => String(d.code) === 'undefined-variable' && d.message.includes(name));
  const lint = (lines) => runLinter(lines.join('\n'), workDir);

  // COPY annidata: i campi della copy interna sono definiti e tipizzati.
  const nested = prog(['           COPY CB2OUT.'],
    ['           MOVE CB2-ALF TO CB2-NUM.']);
  const nd = lint(nested);
  assert(!undef(nd, 'CB2-ALF') && !undef(nd, 'CB2-NUM'),
    'COPY annidata: i campi di CB2IN (dentro CB2OUT) devono risultare definiti');
  assert(nd.some(d => String(d.code) === 'move-alphanumeric-to-numeric'),
    'COPY annidata: i tipi dei campi della copy interna vanno classificati');

  // REPLACING della COPY esterna applicato anche alla copy annidata.
  const nestedRepl = prog(['           COPY CB2OUTR REPLACING ==:T:== BY ==ZZ==.'],
    ['           MOVE ZZ-NEST TO WS-X.']);
  assert(!undef(lint(nestedRepl), 'ZZ-NEST'),
    'COPY annidata: il REPLACING esterno vale anche per la copy interna');

  // REPLACING a parola intera: WS-AB non diventa WS-BB.
  const word = prog(['           COPY CB2WORD REPLACING ==WS-A== BY ==WS-B==.'],
    ['           MOVE WS-AB TO WS-X.', '           MOVE WS-B TO WS-X.', '           MOVE WS-A TO WS-X.']);
  const wd = lint(word);
  assert(!undef(wd, 'WS-AB'), 'REPLACING ==WS-A==: WS-AB non va toccato');
  assert(!undef(wd, 'WS-B'), 'REPLACING ==WS-A== BY ==WS-B==: WS-B definito');
  assert(undef(wd, 'WS-A'), 'REPLACING ==WS-A== BY ==WS-B==: WS-A non esiste piu\'');

  // REPLACING senza pseudo-testo.
  const bare = prog(['           COPY CB2BARE REPLACING WS-C BY WS-D.'],
    ['           MOVE WS-D TO WS-X.']);
  assert(!undef(lint(bare), 'WS-D'), 'REPLACING WS-C BY WS-D (senza ==): WS-D definito');

  // REPLACING LEADING (sostituzione di parte di parola).
  const lead = prog(['           COPY CB2LEAD REPLACING LEADING ==PFX== BY ==NEW==.'],
    ['           MOVE NEW-CAMPO TO WS-X.']);
  assert(!undef(lint(lead), 'NEW-CAMPO'), 'REPLACING LEADING ==PFX== BY ==NEW==: NEW-CAMPO definito');

  // COPY tra apici: simboli caricati, copy mancante segnalata.
  const quoted = prog(['           COPY "CB2QUOT".', "           COPY 'CB2MISSQ'."],
    ['           MOVE Q-FIELD TO WS-X.']);
  const qd = lint(quoted);
  assert(!undef(qd, 'Q-FIELD'), 'COPY "NOME": i simboli della copy vanno caricati');
  assert(!!findDiagOnLine(qd, quoted, 'mismatched-copy', 'CB2MISSQ'),
    "COPY 'NOME' mancante: va segnalata da mismatched-copy");

  // COPY in PROCEDURE con OF libreria e REPLACING: nessun token preso per variabile.
  const proc = prog([], ['           COPY CB2PROC OF MYLIB.', '           COPY CB2PROC REPLACING ==:Q:== BY ==QQ==.']);
  const pd = lint(proc);
  assert(!undef(pd, 'MYLIB'), 'COPY ... OF libreria: il nome libreria non e\' una variabile');
  assert(!pd.some(d => String(d.code) === 'undefined-variable' && proc[d.range.start.line].includes('REPLACING')),
    'COPY ... REPLACING in PROCEDURE: gli operandi non sono variabili');

  console.log('OK - test regressione COPY annidate / REPLACING / COPY tra apici superati');
}

// ---------------------------------------------------------------------------
// Simboli (F12/hover) di una copy con :TAG: inclusa piu' volte con REPLACING diversi.
// ---------------------------------------------------------------------------
function runCopySymbolsTests() {
  const { parseCobolSymbols } = require('../src/cobol-parser');
  const copyDir = path.join(workDir, 'Copy');
  ensureDir(copyDir);
  fs.writeFileSync(path.join(copyDir, 'CPSYM1'),
    ['          05 :PFX:-CODICE               PIC 9(05).', '          05 :PFX:-STATO-OLD            PIC X.', ''].join('\n'), 'utf8');
  const src = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SYM.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 G1.',
    '          COPY CPSYM1 REPLACING ==:PFX:== BY ==CLI==.',
    '       01 G2.',
    '          COPY CPSYM1 REPLACING ==:PFX:== BY ==FOR== ==-OLD== BY ====.',
    '       01 G3.',
    '          COPY CPSYM1 REPLACING ==:PFX:== BY ==CLI==.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           STOP RUN.',
    ''].join('\n');
  const all = parseCobolSymbols(path.join(workDir, 'PGM-SYM.CBL'), src, workDir);
  const syms = all.filter(s => s.type === 'variable').map(s => s.name);
  const forCod = all.find(s => s.name === 'FOR-CODICE');
  assert(forCod && forCod.copyLine === 7, 'il simbolo da copy porta la riga della COPY nel programma (copyLine)');
  assert(syms.includes('CLI-CODICE'), 'REPLACING :PFX: -> CLI: CLI-CODICE deve essere un simbolo');
  assert(syms.includes('FOR-CODICE') && syms.includes('FOR-STATO'),
    'stessa copy inclusa con REPLACING diverso: anche FOR-CODICE e FOR-STATO (suffisso -OLD tolto)');
  assert(syms.filter(n => n === 'CLI-CODICE').length === 1,
    'stessa copy inclusa due volte con lo stesso REPLACING: nessun doppione');
  console.log('OK - test regressione simboli copy con :TAG: / REPLACING multipli superati');
}

// ---------------------------------------------------------------------------
// Copy aperta dal programma (F12) o a mano: unused-variable col contesto del
// programma, regole che dipendono dal programma mute sulle copy orfane.
// ---------------------------------------------------------------------------
function runCopyContextTests() {
  const { runLinter } = require('../src/cobol-linter');
  const copyDir = path.join(workDir, 'Copy');
  ensureDir(copyDir);
  const writeCopy = (name, lines) => fs.writeFileSync(path.join(copyDir, name), lines.concat('').join('\n'), 'utf8');
  writeCopy('CPCTX1', ['       01 CTX-A                     PIC X.', '       01 CTX-B                     PIC X.']);
  writeCopy('CPCTX2', ['       01 :T:-F1                    PIC X.', '       01 :T:-F2                    PIC X.']);

  const prog = (copyLine, proc) => [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CTX.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    copyLine,
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    proc,
    '           GOBACK.',
    '',
  ].join('\n');
  const unused = (diags, name) => diags.some(d => String(d.code) === 'unused-variable' && d.message.includes(name));
  const code = (diags, c) => diags.some(d => String(d.code) === c);

  const copy1 = fs.readFileSync(path.join(copyDir, 'CPCTX1'), 'utf8');
  const copy2 = fs.readFileSync(path.join(copyDir, 'CPCTX2'), 'utf8');

  // Senza opzioni: comportamento storico (copy trattata come file a se').
  assert(unused(runLinter(copy1, workDir, 'CPCTX1'), 'CTX-A'), 'senza opzioni: unused-variable come prima');

  // Copy orfana (aperta a mano): nessuna segnalazione dipendente dal programma.
  const orphan = runLinter(copy1, workDir, 'CPCTX1', { copyAware: true });
  assert(!code(orphan, 'unused-variable'), 'copy orfana: unused-variable muta');

  // Copy aperta dal programma: solo il campo davvero inutilizzato.
  const p1 = prog('           COPY CPCTX1.', '           MOVE 1 TO CTX-A.');
  const withParent = runLinter(copy1, workDir, 'CPCTX1', { copyAware: true, parentText: p1 });
  assert(!unused(withParent, 'CTX-A'), 'copy col programma: CTX-A e\' usato nel programma');
  assert(unused(withParent, 'CTX-B'), 'copy col programma: CTX-B non e\' usato');

  // REPLACING: il programma usa il nome sostituito.
  const p2 = prog('           COPY CPCTX2 REPLACING ==:T:== BY ==ZZ==.', '           MOVE 1 TO ZZ-F1.');
  const repl = runLinter(copy2, workDir, 'CPCTX2', { copyAware: true, parentText: p2 });
  assert(!unused(repl, ':T:-F1'), 'copy col REPLACING: il campo usato col nome sostituito non e\' unused');
  assert(unused(repl, ':T:-F2'), 'copy col REPLACING: il campo non usato resta segnalato');

  // Piu' inclusioni con REPLACING diversi: conta solo quella da cui si e' partiti.
  const p4 = prog('           COPY CPCTX2 REPLACING ==:T:== BY ==ZZ==.\n           COPY CPCTX2 REPLACING ==:T:== BY ==YY==.',
    '           MOVE 1 TO ZZ-F1.');
  const fromYY = runLinter(copy2, workDir, 'CPCTX2', { copyAware: true, parentText: p4, parentCopyLine: 5 });
  assert(unused(fromYY, ':T:-F1'), 'inclusione YY: ZZ-F1 non conta, :T:-F1 e\' unused');
  const fromZZ = runLinter(copy2, workDir, 'CPCTX2', { copyAware: true, parentText: p4, parentCopyLine: 4 });
  assert(!unused(fromZZ, ':T:-F1') && unused(fromZZ, ':T:-F2'), 'inclusione ZZ: solo :T:-F2 e\' unused');
  const anyInc = runLinter(copy2, workDir, 'CPCTX2', { copyAware: true, parentText: p4 });
  assert(!unused(anyInc, ':T:-F1'), 'riga sconosciuta: vale qualsiasi inclusione');

  // Il programma non include questa copy: contesto non valutabile, nessuna segnalazione.
  const p3 = prog('           COPY CPCTX2 REPLACING ==:T:== BY ==ZZ==.', '           MOVE 1 TO ZZ-F1.');
  const notIncluded = runLinter(copy1, workDir, 'CPCTX1', { copyAware: true, parentText: p3 });
  assert(!code(notIncluded, 'unused-variable'), 'programma che non include la copy: nessun unused-variable');

  // Copy di procedure orfana: niente undefined-variable.
  const procCopy = '           MOVE SPACES TO WS-QUALSIASI.\n';
  assert(!code(runLinter(procCopy, workDir, 'CPPROC', { copyAware: true }), 'undefined-variable'),
    'copy di procedure orfana: undefined-variable muta');

  // Un programma intero non e' toccato dalla modalita' copyAware.
  const whole = prog('       01 WS-NEVER                  PIC X.', '           MOVE 1 TO WS-NEVER2.');
  assert(unused(runLinter(whole, workDir, 'PGM-CTX', { copyAware: true }), 'WS-NEVER'),
    'programma intero: unused-variable resta attiva');

  console.log('OK - test regressione contesto copy (F12 / orfana) superati');
}

// ---------------------------------------------------------------------------
// Blocco 4: missing-stop-run (EXIT PROGRAM), redefines-size (solo piu'
// grande), duplicate-variable (nomi qualificabili OF), unused-variable
// (gruppi REDEFINES), unsubscripted-occurs (subordinati + qualificazione OF),
// regex livello-nome non protetta (continuazioni numeriche), WS-DIVISIONE,
// string-delimited (id proprio), empty-paragraph (bersaglio GO TO).
// ---------------------------------------------------------------------------
function runBlock4Tests() {
  const { runLinter } = require('../src/cobol-linter');
  const lint = (lines) => runLinter(lines.join('\n'), workDir);
  const has = (diags, lines, code, snippet) => !!findDiagOnLine(diags, lines, code, snippet);

  // --- missing-stop-run: EXIT PROGRAM deve essere riconosciuto (sottoprogramma classico) ---
  const exitProg = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUB.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           DISPLAY \'HELLO\'.',
    '           EXIT PROGRAM.',
    ''
  ];
  assert(!lint(exitProg).some(d => String(d.code) === 'missing-stop-run'),
    'missing-stop-run: EXIT PROGRAM deve essere riconosciuto come terminazione valida');

  // --- duplicate-variable: nomi qualificabili (gruppi diversi) non sono duplicati ---
  const qualifiable = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-QUAL.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 GRP-A.',
    '           05 CAMPO    PIC X(5).',
    '       01 GRP-B.',
    '           05 CAMPO    PIC X(5).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE CAMPO OF GRP-A TO CAMPO OF GRP-B.',
    '           GOBACK.',
    ''
  ];
  const qualDiags = lint(qualifiable);
  assert(!qualDiags.some(d => String(d.code) === 'duplicate-variable'),
    'duplicate-variable: CAMPO OF GRP-A / CAMPO OF GRP-B sono qualificabili, non duplicati: '
    + qualDiags.filter(d => String(d.code) === 'duplicate-variable').map(d => d.message).join(' | '));

  // Stesso nome, stesso genitore (nessuna qualificazione possibile): duplicato vero.
  const realDup = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DUP.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 GRP-A.',
    '           05 CAMPO    PIC X(5).',
    '           05 CAMPO    PIC X(5).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  assert(lint(realDup).some(d => String(d.code) === 'duplicate-variable'),
    'duplicate-variable: due CAMPO sotto lo stesso GRP-A restano un duplicato vero');

  // --- unused-variable: usare solo la REDEFINES non deve far segnalare l'originale (e viceversa) ---
  const redefUsed = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-REDUSE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-NUM           PIC 9(5).',
    '       01 WS-NUM-ALFA REDEFINES WS-NUM PIC X(5).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           DISPLAY WS-NUM-ALFA.',
    '           GOBACK.',
    ''
  ];
  const redefDiags = lint(redefUsed);
  assert(!redefDiags.some(d => String(d.code) === 'unused-variable' && d._symbolName === 'WS-NUM'),
    'unused-variable: WS-NUM non va segnalato se si usa solo la sua REDEFINES WS-NUM-ALFA');

  // --- unsubscripted-occurs: un sotto-campo di una tabella OCCURS richiede l'indice ---
  const subOccurs = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-SUBOCC.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-TAB2.',
    '           05 WS-ITEM OCCURS 3.',
    '               10 WS-ITEM-VAL  PIC X(5).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    "           MOVE 'Y' TO WS-ITEM-VAL.",
    '           GOBACK.',
    ''
  ];
  assert(has(lint(subOccurs), subOccurs, 'unsubscripted-occurs', 'WS-ITEM-VAL'),
    'unsubscripted-occurs: un campo sotto OCCURS senza indice va segnalato anche se non e\' lui stesso OCCURS');

  // --- unsubscripted-occurs: qualificazione (OF <gruppo>) prima del subscript e' valida ---
  const qualifiedSub = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-QUALSUB.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-OUTER-GRP.',
    '           05 WS-ELEM OCCURS 5 PIC X(5).',
    '       01 WS-OUT                PIC X(5).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE WS-ELEM OF WS-OUTER-GRP (1) TO WS-OUT.',
    '           GOBACK.',
    ''
  ];
  const qsDiags = lint(qualifiedSub);
  assert(!qsDiags.some(d => String(d.code) === 'unsubscripted-occurs'),
    'unsubscripted-occurs: "WS-ELEM OF WS-OUTER-GRP (1)" e\' qualificato con subscript, non va segnalato: '
    + qsDiags.filter(d => String(d.code) === 'unsubscripted-occurs').map(d => d.message).join(' | '));

  // --- Regex livello-nome non protetta: una continuazione numerica (VALUES) non
  // deve essere scambiata per un nuovo livello da ws-levels/no-level-77-78/
  // level-88-without-parent. ---
  const numericContinuation = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-NUMCONT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-REC.',
    '           05 WS-CODE PIC 9(2).',
    '               88 WS-CODE-OK VALUE 10 11 12',
    '                  13     17.',
    '               88 WS-CODE-OK2 VALUE 76',
    '                  77     78.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           GOBACK.',
    ''
  ];
  const ncDiags = lint(numericContinuation);
  for (const code of ['ws-levels', 'no-level-77-78', 'level-88-without-parent']) {
    assert(!ncDiags.some(d => String(d.code) === code && (lines => lines[d.range.start.line])(numericContinuation).trim().match(/^\d+\s+\d+\.?$/)),
      `${code}: una continuazione puramente numerica (VALUES) non va scambiata per un livello`);
  }

  // --- includes('DIVISION'): WS-DIVISIONE non deve essere scambiato per un
  // header di DIVISION (division-separator e missing-period). ---
  const divisioneField = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DIVFIELD.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-REC.',
    '           05 WS-DIVISIONE  PIC X(10).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           MOVE WS-DIVISIONE TO WS-OUT',
    '       NEXT-PARA.',
    '           STOP RUN.',
    ''
  ];
  const dfDiags = lint(divisioneField);
  assert(!dfDiags.some(d => String(d.code) === 'division-separator' && divisioneField[d.range.start.line].includes('WS-DIVISIONE')),
    'division-separator: WS-DIVISIONE non e\' un header di DIVISION');
  assert(has(dfDiags, divisioneField, 'missing-period', 'MOVE WS-DIVISIONE'),
    'missing-period: la frase prima di NEXT-PARA non termina con un punto, va comunque segnalata (WS-DIVISIONE non deve far saltare il controllo)');

  // --- string-delimited: deve avere un id regola proprio, non 'end-structure' ---
  const stringNoDelim = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-STRNODEL.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A PIC X(5) VALUE \'AAAAA\'.',
    '       01 WS-OUT PIC X(20).',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           STRING WS-A INTO WS-OUT.',
    '           GOBACK.',
    ''
  ];
  assert(has(lint(stringNoDelim), stringNoDelim, 'string-delimited', 'STRING WS-A'),
    'string-delimited: STRING senza DELIMITED BY prima di INTO deve avere il proprio id regola');

  // --- empty-paragraph: un paragrafo bersaglio di GO TO, con solo EXIT, non va segnalato ---
  const goToExit = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-GOTOEXIT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-FLAG PIC X.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    "           IF WS-FLAG = 'E' GO TO HANDLE-ERR.",
    '           STOP RUN.',
    '       HANDLE-ERR.',
    '           EXIT.',
    ''
  ];
  assert(!lint(goToExit).some(d => String(d.code) === 'empty-paragraph'),
    'empty-paragraph: HANDLE-ERR e\' bersaglio di GO TO, solo EXIT e\' intenzionale');

  console.log('OK - test regressione blocco 4 (missing-stop-run/redefines/duplicate/unused/occurs/DIVISION/string-delimited/empty-paragraph) superati');
}

// Cache per-run di isSkippable/getCodeContent: non deve mai trapelare tra un run e l'altro.
function runLineCacheTests() {
  const { runLinter } = require('../src/cobol-linter');
  const vs = require.cache.vscode.exports;
  const summary = (diags) => JSON.stringify(diags.map(d => [String(d.code), d.range.start.line, d.message]));
  const hasNope = (diags) => diags.some(d => String(d.code) === 'undefined-variable' && d._symbolName === 'NOPE-VAR');

  // Riga identica nei due formati: oltre la col 72 conta solo in variable.
  const longLine = '           MOVE 1 TO WS-OK'.padEnd(72, ' ') + ' NOPE-VAR.';
  const body = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-CACHE.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-OK PIC 9.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    longLine,
    '           STOP RUN.',
    ''
  ];
  const variableText = ['      $SET SOURCEFORMAT(VARIABLE)', ...body].join('\n');
  const fixedText = body.join('\n');

  const v1 = runLinter(variableText, workDir);
  assert(hasNope(v1), 'cache: premessa del test, in variable NOPE-VAR oltre la col 72 deve essere undefined-variable');
  const f1 = runLinter(fixedText, workDir);
  assert(!hasNope(f1), 'cache: in fixed la colonna oltre la 72 non e\' codice (cache di un run variable trapelata?)');
  assert(hasNope(runLinter(variableText, workDir)), 'cache: variable dopo fixed deve di nuovo vedere NOPE-VAR');
  assert(!hasNope(runLinter(fixedText, workDir)), 'cache: fixed dopo variable non deve vedere NOPE-VAR');

  // Stesso input due volte: risultato identico (nessuno stato che sopravvive al run).
  assert(summary(runLinter(fixedText, workDir)) === summary(f1), 'cache: due run identici devono dare le stesse diagnostiche');
  assert(summary(runLinter(variableText, workDir)) === summary(v1), 'cache: due run identici (variable) devono dare le stesse diagnostiche');

  // Eccezione a meta' run: il run dopo deve essere pulito e uguale al riferimento.
  const origGetConfiguration = vs.workspace.getConfiguration;
  let calls = 0;
  vs.workspace.getConfiguration = (section) => {
    if (++calls === 3) throw new Error('boom');
    return origGetConfiguration(section);
  };
  let threw = false;
  try {
    runLinter(variableText, workDir);
  } catch (e) {
    threw = e && e.message === 'boom';
  } finally {
    vs.workspace.getConfiguration = origGetConfiguration;
  }
  assert(threw, 'cache: premessa del test, il run con eccezione simulata deve lanciare');
  assert(summary(runLinter(fixedText, workDir)) === summary(f1), 'cache: dopo un run andato in eccezione il run successivo deve essere pulito (fixed)');
  assert(summary(runLinter(variableText, workDir)) === summary(v1), 'cache: dopo un run andato in eccezione il run successivo deve essere pulito (variable)');

  console.log('OK - test regressione cache per-run isSkippable/getCodeContent (formati, ripetizione, eccezione) superati');
}

function loadPackageRuleDefaults() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const prefix = 'cobolLens.linter.rules.';
  const out = {};
  for (const section of [].concat(pkg.contributes.configuration)) {
    for (const [key, def] of Object.entries(section.properties || {})) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = def.default;
    }
  }
  return out;
}

// Il resto della suite gira con tutte le regole accese: qui si verifica
// quello che vede davvero l'utente con i default di package.json.
function runRealDefaultsTests() {
  const { runLinter, RULE_DEFAULT_SEVERITIES } = require('../src/cobol-linter');
  const pkgDefaults = loadPackageRuleDefaults();

  const linterIds = Object.keys(RULE_DEFAULT_SEVERITIES).sort();
  const pkgIds = [...new Set(Object.keys(pkgDefaults).map(k => k.replace(/\.(enabled|severity)$/, '')))].sort();
  assert(JSON.stringify(linterIds) === JSON.stringify(pkgIds),
    'default: regole diverse tra linter e package.json. Solo linter: ' +
    linterIds.filter(id => !pkgIds.includes(id)).join(', ') +
    ' / solo package.json: ' + pkgIds.filter(id => !linterIds.includes(id)).join(', '));
  for (const id of linterIds) {
    assert(typeof pkgDefaults[id + '.enabled'] === 'boolean',
      'default: ' + id + '.enabled senza default booleano in package.json');
    assert(pkgDefaults[id + '.severity'] === RULE_DEFAULT_SEVERITIES[id],
      'default: severity di ' + id + ' diversa tra linter (' + RULE_DEFAULT_SEVERITIES[id] +
      ') e package.json (' + pkgDefaults[id + '.severity'] + ')');
  }

  const program = [
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. PGM-DEFS.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       01 WS-A                       PIC 9.',
    '       PROCEDURE DIVISION.',
    '       MAIN.',
    '           move 1 to WS-A',
    '           IF WS-A = 1',
    '              CONTINUE',
    '           ELSE IF WS-A = 2',
    '              CONTINUE',
    '           END-IF',
    '           END-IF',
    '           GO TO FINE.',
    '       FINE.',
    '           STOP RUN.',
    ''
  ].join('\n');
  const codes = (diags) => new Set(diags.map(d => String(d.code)));

  const allOn = codes(runLinter(program, workDir));
  for (const id of ['uppercase', 'no-else-if', 'no-goto']) {
    assert(allOn.has(id), 'default: premessa del test, con tutte le regole accese ' + id + ' deve scattare');
  }

  const saved = mockConfig['cobolLens.linter.rules'];
  mockConfig['cobolLens.linter.rules'] = pkgDefaults;
  let real;
  try {
    real = codes(runLinter(program, workDir));
  } finally {
    mockConfig['cobolLens.linter.rules'] = saved;
  }
  for (const id of linterIds.filter(id => pkgDefaults[id + '.enabled'] === false)) {
    assert(!real.has(id), 'default: ' + id + ' e\' spenta in package.json ma ha prodotto diagnostiche');
  }
  assert(real.has('no-goto'), 'default: no-goto e\' accesa di default e deve scattare');

  console.log('OK - test regressione default reali di package.json (allineamento linter, regole spente) superati');
}

try {
  run();
  runLayoutTests();
  runFormatterTests();
  runSearchFormatterTests();
  runFormatterConfigTests();
  runStage2FormatterTests();
  runStage2NoPeriodTests();
  runStage2SelectionTests();
  runFormatterCollapseTests();
  runProcContinuationTests();
  runContAnchorTests();
  runNestedBlankTests();
  runVaryingSplitTests();
  runIfReflowTests();
  runFormatterIdempotencyTests();
  runSignatureTests();
  runCallNavigationTests();
  runCopybookFormatterTests();
  runConditionNameTests();
  runExpandCopyTests();
  runUsageSizeTests();
  runExecBlockTests();
  runOdoTests();
  runRedefinesEditedPicTests();
  runCopyTreeTests();
  runWriteOccurrenceTests();
  runCopybookDataRulesTests();
  runOrphanLiteralTests();
  runCopyAfterPeriodTests();
  runInlineCopyUndefinedTests();
  runGotoParagraphTests();
  runMissingPeriodAreaATests();
  runMultilineConditionValuesTests();
  runUnusedConditionNameTests();
  runConsecutivePeriodsTests();
  runJsonGenerateTests();
  runMaskPictureTests();
  runProgramIdFilenameTests();
  runSizeEngineFixTests();
  runBinaryStorageTests();
  runPerformSectionTests();
  runPerformRangeTests();
  runCopyReplacingTests();
  runCopyContextTests();
  runCopySymbolsTests();
  runBlock3Tests();
  runBlock4Tests();
  runLineCacheTests();
  runRealDefaultsTests();
} catch (err) {
  console.error('KO - test regressione falliti');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
