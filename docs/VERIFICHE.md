# Verifiche eseguite

Esiti reali dell’ultima esecuzione (2 novembre 2026), nell’ambiente di sviluppo con Node.js 22, PostgreSQL 18 in-process (PGlite) e Chrome headless. Nulla di quanto segue è stimato.

## Test automatici: 90 superati, 0 falliti

| Suite | Test | Contenuto |
|---|---|---|
| `packages/domain` · verifiche obbligatorie | 10 | casi A–E del capitolato con i valori attesi esatti |
| `packages/domain` · dominio | 27 | resa edibile, conversioni e incompatibilità di unità, divisori nulli, prezzi mancanti vs zero, oneri, energia misurata/mista/manuale/condivisa, cicli su più livelli, sottoricetta condivisa, tre livelli, formati italiani |
| `apps/api` · autenticazione e aziende | 17 | login, rate limit, CSRF, selezione azienda, recupero password, inviti, ultimo amministratore, isolamento tra aziende (anche con ID noti), permessi su costi e retribuzioni, audit senza importi |
| `apps/api` · percorso costi | 17 | ragù → lasagna via API, cicli in modifica, snapshot immutabili, propagazione indiretta dei prezzi, valorizzazione a data, revisioni, concorrenza, bozze incomplete, anteprima, duplicazione, archiviazione, tariffe da bolletta, gas €/Smc |
| `apps/api` · importazioni | 15 | CSV italiano (punto e virgola, Windows-1252, virgola decimale), XLSX (fogli, date, formule rifiutate), duplicati, atomicità, idempotenza e retry, conflitti dopo l’anteprima, formula injection, permessi, isolamento, 5.000 righe, limite righe |
| `apps/api` · velocità | 4 | tempi con 5.000 ingredienti (15.000 prezzi) e 300 ricette annidate |

Comando: `npm test`.

### Casi numerici obbligatori

| Caso | Atteso | Ottenuto |
|---|---|---|
| A. 5 kg a 30 €, 150 g | 0,90 € | 0,90 € |
| B. 2.400 €, 160 h, 12 min | 15 €/h · 0,25 €/min · 3 € solo lordo | identico, con segnalazione “solo lordo” |
| C. 3 kW, 40 min, 0,8, 0,30 €/kWh | 1,6 kWh · 0,48 € | identico |
| D. 2 m³/h, 15 min, 1,20 €/m³ | 0,5 m³ · 0,60 €; €/Smc rifiutata | identico; €/Smc senza coefficiente → errore `gas_unit_mismatch` |
| E. ragù / lasagna | 34 € · 6,80 €/kg · 4,08 € · 19,08 € · 7,95 €/kg · 2,385 € (2,39) | identico, nel motore e via API con entità reali; riepilogo espanso 10,40 + 1,24 + 7,44 = 19,08 senza doppi conteggi |

## Controlli statici e build

| Controllo | Esito |
|---|---|
| `npm run typecheck` (dominio, API, web) | nessun errore |
| `npm run build` (Next.js 16, produzione) | riuscito, 23 percorsi |

## Interfaccia in Chrome headless

| Verifica | Esito |
|---|---|
| Flusso essenziale (`npm run e2e -w apps/web`): nuova ricetta → ingrediente creato al volo nel pannello laterale e inserito senza perdere la ricetta → semilavorato ragù → riepilogo dal backend → salvataggio → scheda | superato; totale anteprima e scheda identici (10,04 € = 3,00 € di ricotta + 600 g di ragù) |
| Importazione guidata di un CSV salvato da Excel italiano | separatore e codifica rilevati, colonne abbinate, 2 nuovi + 1 aggiornamento applicati |
| Responsive a 390 px: dashboard, elenco ricette, editor con riepilogo a scomparsa | verificato su schermate; corretta una sovrapposizione tra barra di salvataggio e pulsante del riepilogo |
| Responsabile: retribuzioni non visibili nell’elenco dipendenti | verificato |
| Errori JavaScript in console durante i percorsi | nessuno |

Difetti trovati e corretti grazie alle verifiche: stato della ricetta che tornava “bozza” al salvataggio; ambiguità dei numeri con il punto nell’API (ora solo formato normalizzato); avvisi irrilevanti delle sottoricette ripetuti nel padre; colonna “Resa” con testo errato su mobile; ordine delle colonne nel report d’importazione; sovrapposizione dei pulsanti su mobile.

## Velocità

Navigazione nell’interfaccia (produzione locale, dati dimostrativi, tempo dal clic alla tabella popolata): 30–100 ms tra le anagrafiche, circa 150 ms per scheda ricetta ed editor.

API con 5.000 ingredienti, 15.000 prezzi e 300 ricette annidate (mediana di 5 richieste, PGlite):

| Richiesta | ms |
|---|---|
| Elenco ingredienti, pagina 40 ordinata | 25 |
| Ricerca testuale | 11 |
| Filtro per categoria | 5 |
| Elenco ricette con costi: primo calcolo / da cache | 54 / 8 |
| Scheda ricetta annidata | 10 |
| Anteprima dall’editor | 11 |
| Nuovo prezzo con propagazione | 11 |
| Dashboard dopo l’invalidazione | 218 |

Importazione di 5.000 righe (validazione completa + applicazione atomica): circa 10 secondi, in background.

## Non verificato in questo ambiente

- Esecuzione su un **server PostgreSQL** (Docker non disponibile qui): il codice usa lo stesso dialetto e lo stesso schema, ma la prova va ripetuta in locale con `docker compose up -d`.
- **Worker separato** (`npm run worker`): con PGlite il database è di un solo processo, quindi i test eseguono la coda nello stesso processo dell’API.
- **Invio email reale**: inviti e reset sono scritti in `storage/outbox`.
- Browser diversi da Chrome e lettori di schermo.
