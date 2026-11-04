# Food Cost — Piano tecnico e decisioni

Ultimo aggiornamento: 4 novembre 2026. Tutte le fasi del capitolato sono state completate; il progetto è pronto per la pubblicazione (`docs/PUBBLICAZIONE.md`).

## 1. Stato del repository

Alla prima ispezione il repository era vuoto, quindi il progetto è partito da zero.

## 2. Decisione sullo stack

Il capitolato indicava Laravel, Next.js e MySQL. L’ambiente di sviluppo non poteva raggiungere Packagist (registro dei pacchetti PHP): Laravel sarebbe stato scritto senza poterlo installare né testare. Su decisione del cliente il progetto è interamente in TypeScript:

| Livello | Scelta | Motivo |
|---|---|---|
| Dominio | `packages/domain`, TypeScript puro, `decimal.js` | motore di calcolo testabile senza database, condiviso da API e interfaccia |
| API | Fastify + Kysely + Zod | API-first, leggera e veloce; query tipizzate |
| Database | **PostgreSQL** | MySQL non è eseguibile qui; PostgreSQL gira anche in-process (PGlite), quindi i test usano un database vero, con vincoli CHECK, lock e transazioni |
| Frontend | Next.js 16 + React 19 + TanStack Query | applicazione a pagina singola: menu fisso, prefetch, cache dei dati |
| Coda | tabella `jobs` su PostgreSQL | nessun servizio aggiuntivo da gestire per una piccola agenzia |

## 3. Architettura

```
packages/domain   motore di calcolo: unità, ingredienti, energia, lavoro, ricette annidate, grafo, formati italiani
apps/api          src/routes (HTTP), src/services (costi, ricette, importazioni, sessioni, audit, coda), src/db (schema, migrazioni, seed)
apps/web          app/(auth) accesso; app/(app) pagine; components (tabelle, editor, form, riepilogo)
```

Il backend calcola sempre il valore autorevole. L’editor mostra l’anteprima calcolata dal backend mentre si compila, con un ritardo di circa 450 ms dall’ultima modifica.

## 4. Velocità (requisito esplicito del cliente)

- Il menu e l’intestazione non si ricaricano mai, e le pagine del menu sono precaricate.
- Le liste già viste si mostrano subito e si aggiornano in background. Ricerca, filtri e ordinamento sono server-side, con indici che iniziano da `company_id`.
- Le valorizzazioni correnti stanno in cache per (ricetta, data) e vengono invalidate solo per le ricette interessate, anche indirettamente.
- Le importazioni girano sempre in background.

Misure in `docs/VERIFICHE.md`: risposte API tra 5 e 25 ms con 5.000 articoli, cambi pagina sotto i 160 ms.

## 5. Sicurezza e multi-azienda

- Database condiviso con `company_id`. L’azienda attiva viene dalla sessione e dalla membership verificata; un ID di un’altra azienda risponde 404.
- Sessioni con token salvato solo come hash e cookie httpOnly SameSite=Lax. Protezione CSRF con header dedicato e controllo dell’origine. Rate limiting su login, recupero password e caricamenti.
- Ruoli: amministratore, responsabile, operatore. Permessi distinti: `costs.read`, `salaries.read`, `employees.manage`, `tariffs.manage`, `imports.manage` e altri, concedibili oltre al ruolo.
- Le retribuzioni non entrano nei payload senza `salaries.read` e non finiscono mai nei log di audit.

## 6. Fasi

| Fase | Contenuto | Stato |
|---|---|---|
| 1 | Ispezione, piano, decisioni | completata |
| 2 | Autenticazione, aziende, ruoli, modello dati, migrazioni | completata |
| 3 | Ingredienti e prezzi, utenze, strumenti, dipendenti | completata |
| 4 | Motore di calcolo e test numerici A–E | completata |
| 5 | Editor ricette, annidamento, scheda, valorizzazioni, snapshot | completata |
| 6 | Importazioni CSV/XLSX con anteprima, validazione e report | completata |
| 7 | Dashboard, rifinitura, verifiche di velocità, documentazione | completata |

## 7. Assunzioni implementate

- Valuta EUR, interfaccia italiana. Si digita e si legge in formato italiano (1.234,56); l’API accetta solo numeri normalizzati (1234.56).
- Costi netti IVA, come inseriti, e convenzione indicata nell’interfaccia.
- Fuso orario Europe/Rome per la “data di oggi” delle valorizzazioni.
- Ogni salvataggio di una ricetta crea una revisione immutabile; gli snapshot sono fotografie JSON autosufficienti.
- Le sottoricette sono valorizzate con la loro revisione corrente alla data scelta. La valorizzazione a data passata usa i prezzi di quella data con la composizione corrente; la composizione storica esatta resta negli snapshot e nelle revisioni.
- Importazioni solo in modalità atomica (la modalità parziale, facoltativa nel capitolato, non è stata implementata).
- Le aziende clienti le crea l’amministratore di piattaforma; non c’è registrazione pubblica.

## 8. Limiti ancora presenti

- **Email**: invio via SMTP configurabile; senza SMTP l’amministratore riceve il link d’invito da consegnare a mano, mentre il recupero password autonomo richiede l’SMTP.
- **Immagini Docker**: i passaggi dei Dockerfile sono stati riprodotti e verificati fuori da Docker (non disponibile nell’ambiente di sviluppo); la prima `docker compose up --build` sul server è la verifica finale.
- **Dipendenze**: restano 9 avvisi di gravità moderata nelle librerie interne del lettore Excel (`exceljs` → `archiver`/`minimatch`, `uuid`). Non sono sfruttabili nell’uso che ne fa l’applicazione (nessun pattern di file fornito dagli utenti, `uuid` senza buffer esterni); da rivedere quando `exceljs` aggiornerà le sue dipendenze.
- **Acqua**: tariffa prevista nel modello, ma senza consumi d’acqua sugli strumenti.
- **Fasi**: l’editor gestisce nome e descrizione; i campi di inizio e durata sono nello schema ma non ancora nell’interfaccia.
- **Audit**: registrato nel database, senza una pagina di consultazione.
- **Rate limiting** in memoria del singolo processo: con più istanze dell’API serve un archivio condiviso.
- Conservazione delle importazioni: file e righe di staging eliminati dopo `IMPORT_RETENTION_DAYS` (30 di default); resta il riepilogo.
