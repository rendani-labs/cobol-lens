      $set check
      $SET sourceformat(variable)
       IDENTIFICATION DIVISION.                                         00010000
       PROGRAM-ID. COPYTABN_all.
      *---------------------------------------------------------------* 00030000
      *  COPYTABN_all:COPIA TUTTE LE TABELLE SU SEQUENZIALE x linea   * 00040000
      *---------------------------------------------------------------* 00050000
       ENVIRONMENT DIVISION.                                            00060000
       CONFIGURATION SECTION.                                           00070000
       SPECIAL-NAMES.                                                   00080000
           DECIMAL-POINT IS COMMA.                                      00090000
       INPUT-OUTPUT SECTION.                                            00100000
       FILE-CONTROL.                                                    00110000
           SELECT PGTABN     ASSIGN TABN                                00130000
                             ORGANIZATION INDEXED                       00140000
                             ACCESS DYNAMIC                             00150000
                             RECORD KEY PGTABN-CHIAVE                   00160001
                             STATUS IS STS-TABN.                        00170000
           SELECT FILOUT     ASSIGN TO FILOUT.
       DATA DIVISION.                                                   00180000
       FILE SECTION.                                                    00190000
      *                                                                 00200000
       FD  PGTABN LABEL RECORD STANDARD.                                00240000
           COPY PGCYTABN.                                               00250001
      *                                                                 00230000
       FD  FILOUT                                                       00170000
           BLOCK CONTAINS 0 RECORDS                                     00180000
           LABEL RECORD STANDARD.                                       00190000
       01 FILOUT-REC                  PIC  X(4065).                     00200000
      *---------------------------------------------------------------* 00260000
       WORKING-STORAGE SECTION.                                         00270000

       01 variabile-1                          pic x(001).
       01 variabile-2                          pic x(001).
       01 variabile-3                          pic x(001).
       01 variabile-4                          pic x(001).
      *-----------------------------------------------------------------00280000
      *---------------------------------------------------*             00290000
      *---------------------------------------------------------------* 00300000
      *                   C O M O D I                                 * 00310000
      *---------------------------------------------------------------* 00320000
       01 STS-TABN                  PIC   X(02) VALUE ZERO              00330000 .
       01 CTR-TABN                  PIC   9(09) VALUE ZERO.             00340000
       01 PGM                       PIC   X(10) VALUE 'COPYTABN- '.     00350000
      *---------------------------------------------------------------* 00400000
      *-----   I N I Z I O         P R O G R A M M A   ---------------* 00410000
      *---------------------------------------------------------------* 00420000
       PROCEDURE DIVISION.                                              00430000
      *---------------------------------------------------------------* 00440000
       INIZIO.                                                          00450000
      *---------------------------------------------------------------* 00460000
           DISPLAY  PGM  ' * INIZIO PROGRAMMA'.                         00470000
           OPEN   INPUT  PGTABN                                          00550000
           OPEN   OUTPUT FILOUT.                                         00550000
           PERFORM ELAB-TABN THRU EX-ELAB-TABN                          00560000
      *---------------------------------------------------------------* 00570000
       FINE.                                                            00580000
           DISPLAY '************ F I N E ************************'      00590000
           DISPLAY ' '                                                  00600000
           DISPLAY 'TOTALE RECORD COPIATI = ' CTR-TABN
           GO TO    CHIUDI-PROGRAMMA.                                   00620000
      *---------------------------------------------------------------*
       ELAB-TABN.

           compute function numval(variabile-1) =
                                 function numval(variabile-2) +
                                 function numval(variabile-3) +
                                 function numval(variabile-4).

           MOVE   SPACES              TO  PGTABN-CHIAVE.
           START  PGTABN  KEY IS NOT LESS PGTABN-CHIAVE.
           IF     STS-TABN  NOT EQUAL  '00'
                  DISPLAY PGM '* * MANCA CHIAVE TAB. IN START '
                                    PGTABN-CHIAVE
                  DISPLAY PGM '* * STATUS CHIAVE ' STS-TABN
                  GO TO   EX-ELAB-TABN.
       LEGG-TABN.
           READ     PGTABN NEXT AT END
                    GO TO EX-ELAB-TABN.
           MOVE  PGTABN-AREA    TO  FILOUT-REC.
           WRITE  FILOUT-REC
********** DISPLAY 'WW = ' FILOUT-REC
           ADD    1          TO  CTR-TABN
           GO TO LEGG-TABN.
       EX-ELAB-TABN.
           EXIT.
      *---------------------------------------------------------------*
       CHIUDI-PROGRAMMA.
      *---------------------------------------------------------------*
           CLOSE    PGTABN  FILOUT.
           GOBACK.
      *---------------------------------------------------------------*
      *---------------------------------------------------------------*
