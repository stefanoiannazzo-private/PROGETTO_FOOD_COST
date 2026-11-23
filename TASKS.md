# Attività

Stato al 22 novembre 2026. Un'attività è "fatta" solo se le sue prove sono superate (vedi MATRICE_PARITA_FUNZIONALE.md).
Legenda: ✅ fatta · 🔒 in attesa di una tua autorizzazione · ⏳ da fare · ⏸ rinviata per tua decisione.

## Migrazione (piano dell'analisi)

| # | Attività | Stato | Prova |
|---|---|---|---|
| T00 | Ambiente: Laravel 13 installato (pacchetti da GitHub, opzione B) | ✅ | `composer install`; `composer.lock` standard |
| T01 | Scheletro Laravel, Docker Compose (Apache + PHP 8.3 + MySQL 8.0), `.env.example` | ✅ | `docker compose up` provato da una copia pulita del repository |
| T02 | Schema MySQL: 25 tabelle con vincoli e indici | ✅ | migrazione da zero su MySQL 8.0 (locale e Docker) |
| T03 | `Dec` (emulazione di decimal.js), unità, formati italiani | ✅ | G: 625 operazioni, 66 numeri |
| T04 | Calcolatori di ingredienti, energia e manodopera | ✅ | U: casi A–D |
| T05 | Motore delle ricette, grafo, serializzazione | ✅ | G: 1.055 ricette; U: caso E |
| T06 | HTTP: formato errori, validazione con messaggi italiani, CSRF, intestazioni, limiti | ✅ | T, C |
| T07 | Autenticazione e sessioni | ✅ | T, A |
| T08 | Permessi e isolamento tra aziende | ✅ | T |
| T09 | Utenti, inviti, aziende, ultimo amministratore, audit | ✅ | T, A |
| T10 | Ingredienti e storico prezzi | ✅ | T, C, A |
| T11 | Tariffe e bollette | ✅ | T, C, A |
| T12 | Strumenti | ✅ | C, A |
| T13 | Dipendenti e riservatezza delle retribuzioni | ✅ | T, A |
| T14 | Servizio costi: contesto alla data, cache, invalidazione | ✅ | T |
| T15 | Ricette: CRUD, revisioni, cicli, anteprima, duplicazione, stati | ✅ | T, A |
| T16 | Valorizzazione a una data, snapshot, confronto | ✅ | T, C |
| T17 | Dashboard | ✅ | C, T |
| T18 | Importazioni: caricamento, rilevamento, anteprima, modelli | ✅ | T |
| T19 | Importazioni senza worker, applicazione atomica, report, pulizia | ✅ | T; 20.000 righe misurate |
| T20 | Interfaccia: Vite + React Router + sostituti di `next/*` | ✅ | `npm run build`; 22 pagine |
| T21 | Collegamento interfaccia ↔ API Laravel | ✅ | E |
| T22 | Dati dimostrativi, `create-admin`, `seed-demo` | ✅ | stessi valori dell'originale (C) |
| T23 | Test nel browser e confronto visivo | ✅ | E; V (18 schermate) |
| T24 | Pacchetto per hosting condiviso: `.htaccess`, deploy senza SSH, cron, primo superadmin | ✅ | provato su Apache in Docker |
| T25 | Documentazione | ✅ | questi file |
| T26 | Verifica finale | ✅ | confronti automatici con l'originale (C 64/66, A 56/56, V, E) e 369 test |

## Novità SaaS

| # | Attività | Stato | Prova |
|---|---|---|---|
| S01 | Superadmin e console `/piattaforma` (solo lettura) | ✅ | `PlatformTest`, E |
| S02 | Creazione aziende clienti con invito all'amministratore | ✅ | `PlatformTest`, E |
| S03 | Modalità assistenza, registrata nell'audit | ✅ | `PlatformTest`, E |
| S04 | Tutte le ricette e tutti i prodotti; doppioni segnalati | ✅ | `PlatformTest`, E |
| S05 | Confronti tra ricette scelte a mano | ✅ | `PlatformTest`, E |
| S06 | Statistiche dei prezzi per prodotto, fornitore, agente, azienda | ✅ | `PlatformTest`, E |
| S07 | Agente del fornitore sul prezzo (modulo, storico, importazione) | ✅ | `PlatformTest`, E |
| S08 | Voce extra della retribuzione (modulo, storico, importazione, calcolo) | ✅ | `PlatformTest`, E |
| S12 | Bollette delle utenze: caricamento PDF/foto, lettura automatica con Claude, modulo precompilato da confermare, archivio scaricabile | ✅ | `TariffBillsTest` (9), E `bolletta.mjs` |
| S11 | Coefficiente di redditività: costi fissi con scadenza, personale e quote fisse delle bollette automatici, giorni di chiusura, prezzo in menu con IVA, piatti a settimana e per giorno (solo amministratore) | ✅ | `BreakEvenTest`, `ProfitabilityTest`, E `redditivita.mjs` |
| S09 | Unificazione dei prodotti doppi tra aziende | ⏸ | tua decisione: "per il momento lasciali così" |
| S10 | Abbonamenti e pagamenti | ⏸ | tua decisione: non per ora |

## Da fare

| # | Attività | Stato | Cosa serve |
|---|---|---|---|
| P01 | Salvare il progetto su GitHub | ✅ | ramo `laravel` di `PROGETTO_FOOD_COST` (22 novembre) |
| P02 | Configurare secrets e variabili e fare la prima pubblicazione su Aruba | ✅ | online su https://www.ricettaquadra.it dal 23 novembre: migrazioni eseguite, file riservati bloccati, intestazioni di sicurezza attive |
| P03 | Primo superadmin in produzione e prima azienda cliente | 🔒 | dopo P02 (DEPLOYMENT.md §3) |
| P04 | Cron ogni 5 minuti sul pannello Aruba | 🔒 | dopo P02 (DEPLOYMENT.md §4) |
| P05 | Prova dell'invio email SMTP (inviti, recupero password) | ⏳ | una casella del dominio |
| P06 | Prova di `docker compose up` su Windows | ⏳ | il tuo PC con Docker Desktop |
