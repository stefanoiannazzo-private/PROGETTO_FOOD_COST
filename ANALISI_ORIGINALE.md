# FOOD COST — Analisi del repository originale

**Repository analizzato:** `stefanoiannazzo-private/PROGETTO_FOOD_COST` (pubblico), ramo predefinito, commit `d17db7c` del 4 novembre 2026 ("Pronto per la pubblicazione su un dominio").
**Data dell'analisi:** 11 novembre 2026.
**Metodo:** lettura del codice sorgente (131 file, circa 16.500 righe), non solo della documentazione; esecuzione della suite di test originale in un clone separato.
**Il repository originale non è stato modificato:** clone in sola lettura, `git status` pulito dopo l'analisi, nessun push.

---

## 0. Premessa importante

Il capitolato originale di FOOD COST chiedeva già **Laravel + MySQL**. Il progetto è stato invece scritto in TypeScript perché l'ambiente di sviluppo non riusciva a scaricare i pacchetti PHP da Packagist (`docs/PIANO.md`, §2).

**Lo stesso blocco è presente nell'ambiente di lavoro attuale:** PHP 8.3.6 e Composer sono installati, ma le connessioni verso `repo.packagist.org` vengono rifiutate dal proxy di rete (risposta 403, rifiuto di policy). GitHub invece è raggiungibile, e la release Laravel `v13.9.0` esiste. Le possibili soluzioni sono nella sezione 7: è la prima decisione da prendere.

---

## 1. Evidenze verificate

| Verifica | Esito |
|---|---|
| `npm ci` (367 pacchetti) | riuscito |
| `npm test`: motore di dominio | **37/37 superati** |
| `npm test`: API con PostgreSQL in-process (PGlite) | **53/53 superati** |
| Casi numerici obbligatori A–E | coperti da `verifiche-obbligatorie.test.ts`, tutti superati |
| Stato del clone dopo i test | invariato (`git status` vuoto; `node_modules` è ignorato da git) |

I documenti originali (`docs/VERIFICHE.md`) dichiarano anche build Next.js, test E2E in Chrome headless e prove di produzione. Queste verifiche **non sono state rieseguite** in questa fase.

---

## 2. Architettura attuale

```
PROGETTO_FOOD_COST/                       monorepo npm workspaces, Node.js ≥ 22
├── packages/domain    motore di calcolo puro TypeScript (decimal.js, 40 cifre significative)
├── apps/api           API REST Fastify 5 + Kysely + Zod, PostgreSQL (PGlite in sviluppo)
│   └── src/{routes, services, services/imports, auth, http, db}
├── apps/web           Next.js 16 + React 19 + TanStack Query 5, SPA lato client
├── deploy/            Dockerfile api/web, docker-compose (Caddy, web, api, worker, PostgreSQL 17, backup)
├── templates/         modelli di importazione CSV/XLSX
└── docs/              PIANO, MODELLO_DATI, FORMULE, API, VERIFICHE, PUBBLICAZIONE
```

### 2.1 Frontend
- **Next.js 16 App Router usato come SPA.** Tutte le pagine e i componenti sono `'use client'`. Solo i due layout sono server component, e non caricano dati.
- Dipendenze da Next: `next/link` (18 import), `next/navigation` (`useRouter`, `useParams`, `usePathname`), `metadata` nel solo layout radice. Non usa `next/image`, `next/font`, middleware, server action, route handler né rendering lato server dei dati.
- Dati: TanStack Query (staleTime 30 s, cache 15 min, nessun retry sugli errori 4xx). Client HTTP in `lib/api.ts`: chiamate a `/api/*` sulla stessa origine, header `X-Requested-With: foodcost` sulle richieste che modificano dati, evento globale `foodcost:unauthorized` sulle risposte 401.
- Stile: un solo `globals.css` (310 righe) con token CSS, tema chiaro e scuro, font di sistema. Nessun framework CSS.
- Dal pacchetto di dominio il frontend usa solo la formattazione: `d`, `formatEuro`, `formatNumber`, `parseItalianNumber`. I calcoli autorevoli sono sempre nel backend.
- Stampa in produzione: `output: 'standalone'`. Serve quindi un **processo Node permanente**, incompatibile con un hosting condiviso PHP.

### 2.2 Backend
- Fastify 5 con prefisso `/api`. Plugin: cookie, rate-limit (in memoria), multipart (1 file, 10 MB).
- **Hook globale onRequest**: protezione CSRF (header `X-Requested-With: foodcost` + controllo `Origin` sulle origini ammesse), poi caricamento della sessione dal cookie.
- Formato errori unico: `{ error: { code, message, details } }`, con `details.fields` per gli errori campo per campo (messaggi in italiano).
- Numeri scambiati come **stringhe decimali normalizzate** (`"1234.56"`). L'API rifiuta i separatori delle migliaia.
- Data "di oggi" calcolata nel fuso `Europe/Rome`.
- Coda lavori su tabella `jobs`, eseguita da un **worker in ciclo continuo**: processo separato, oppure nello stesso processo con PGlite.
- Controlli bloccanti all'avvio in produzione (`assertProductionConfig`): database reale, `COOKIE_SECURE`, `APP_URL` in https, `ALLOWED_ORIGINS` coerente.

### 2.3 Dipendenze esterne
| Ambito | Libreria | Equivalente PHP proposto |
|---|---|---|
| Decimali esatti | decimal.js (precision 40, ROUND_HALF_UP) | `brick/math` (PHP puro, non richiede bcmath), con emulazione della precisione 40 |
| Validazione | zod 4 | Form Request Laravel con messaggi italiani identici |
| Query | kysely + pg / PGlite | Eloquent + Query Builder, MySQL |
| CSV | csv-parse (streaming) | `league/csv`, oppure `fgetcsv` con conversione da Windows-1252 |
| XLSX | exceljs (lettore a flusso) | `openspout/openspout` 4 (a flusso, riconosce le formule) |
| Email | nodemailer (SMTP, oppure outbox su file) | Laravel Mail (SMTP, oppure driver `log`/file) |
| Password | scrypt nativo di Node (`scrypt$N$r$p$salt$hash`) | bcrypt di Laravel; compatibilità scrypt solo se ci sono utenti da migrare (§7) |
| Rate limiting | @fastify/rate-limit (in memoria) | RateLimiter di Laravel (cache su file o database) |

Integrazioni esterne: solo SMTP (facoltativo). Nessun servizio di terze parti, nessuna API esterna.

---

## 3. Funzionalità individuate

Legenda: ✅ implementata e coperta da test · 🟡 parziale · ⛔ prevista ma assente.

### 3.1 Accesso, aziende, ruoli
| Funzionalità | Stato | Dettagli |
|---|---|---|
| Login email + password | ✅ | massimo 10 tentativi al minuto per IP; stesso messaggio per utente inesistente, disattivato o password errata; azienda attiva scelta da sola se l'utente ne ha una sola |
| Logout | ✅ | elimina la sessione |
| Sessione | ✅ | tabella `sessions` con il solo hash SHA-256 del token; cookie `fc_session` httpOnly, SameSite=Lax, Secure in produzione; 14 giorni; `last_seen_at` aggiornato al massimo ogni 5 minuti |
| Scelta dell'azienda attiva | ✅ | `POST /auth/company`, verificata sulla membership attiva e sull'azienda non archiviata; schermata "Scegli l'azienda" |
| Multi-azienda (tenancy) | ✅ | tutte le query filtrano per `company_id` della sessione; un ID di un'altra azienda risponde 404 |
| Cambio password | ✅ | minimo 10 caratteri; chiude le altre sessioni |
| Password dimenticata / reimpostazione | ✅ | token monouso valido 60 minuti; risposta identica che l'utente esista o meno; il reset chiude tutte le sessioni; limiti di frequenza |
| Inviti | ✅ | token valido 7 giorni; un utente già registrato conferma con la propria password; senza SMTP il link viene mostrato all'amministratore |
| Ruoli | ✅ | `admin` (tutti i permessi), `manager`, `operator` (solo `recipes.read`) |
| Permessi aggiuntivi | ✅ | 9 concedibili; implicazioni automatiche: salaries.read o snapshots.create danno costs.read, employees.manage dà employees.read, tariffs.manage dà tariffs.read |
| Protezione dell'ultimo amministratore | ✅ | rifiuto `last_admin` |
| Disattivazione di una membership | ✅ | chiude le sessioni dell'utente aperte su quell'azienda |
| Creazione aziende | ✅ | solo l'amministratore di piattaforma, che ne diventa admin; nessuna registrazione pubblica |
| Rinomina dell'azienda corrente | ✅ | `PATCH /companies/current` |
| Audit | 🟡 | registrato in `audit_logs` (mai importi retributivi né password), **senza pagina di consultazione** |

Matrice dei permessi (`apps/api/src/auth/permissions.ts`): 13 permessi. `recipes.read`, `recipes.manage`, `costs.read`, `snapshots.create`, `ingredients.manage`, `equipment.manage`, `tariffs.read`, `tariffs.manage`, `employees.read`, `employees.manage`, `salaries.read`, `imports.manage`, `users.manage`.

### 3.2 Ingredienti e prezzi
| Funzionalità | Stato | Dettagli |
|---|---|---|
| Elenco paginato | ✅ | ricerca su nome, codice e fornitore; filtri per categoria, prezzo (mancante o zero) e archiviati; ordinamento; data di valorizzazione; prezzi visibili solo con `costs.read` |
| Scheda, creazione, modifica | ✅ | codice automatico `ING-00001` se assente; codice unico per azienda senza distinzione di maiuscole; concorrenza ottimistica con `lockVersion` |
| Confezione e unità | ✅ | g, kg, ml, cl, l, pz; resa edibile 0–100%; densità kg/l; peso unitario kg |
| Coerenza delle conversioni | ✅ | volume↔peso richiede la densità; pezzi richiedono il peso unitario; pezzi↔volume richiedono entrambi |
| Storico prezzi | ✅ | ogni voce registra anche la confezione; una sola voce per data; date future non applicate prima del tempo; conflitto `duplicate_price` o `price_date_conflict` |
| Ricette interessate | ✅ | dopo un nuovo prezzo, un'eliminazione o una modifica rilevante (resa, densità, peso) la risposta elenca le ricette interessate, anche indirettamente |
| Archiviazione e ripristino | ✅ | |
| Eliminazione | ✅ | solo se l'ingrediente non è mai stato usato in nessuna revisione |
| Categorie | ✅ | elenco distinto |
| Creazione al volo dall'editor ricetta | ✅ | pannello laterale (`IngredientForm` dentro `Drawer`) |

### 3.3 Utenze (tariffe)
| Funzionalità | Stato | Dettagli |
|---|---|---|
| Tariffe | ✅ | elettricità solo in kWh; gas in m³, Smc o kWh; acqua in m³ |
| Versioni con decorrenza | ✅ | modalità **diretta** (prezzo unitario) o **da bolletta** (voci variabili e fisse con flag "includi", consumo del periodo, solo importi netti IVA) |
| Anteprima bolletta | ✅ | tariffa media = voci incluse ÷ consumo; mostra anche la tariffa con le sole voci variabili |
| Coefficienti gas | ✅ | m³→Smc e kWh/Smc, solo sulle tariffe gas |
| Eliminazione versione, archiviazione, ripristino | ✅ | |
| Acqua | 🟡 | tariffa prevista, ma **nessun consumo d'acqua sugli strumenti** |

### 3.4 Strumenti e macchinari
| Funzionalità | Stato | Dettagli |
|---|---|---|
| CRUD, archiviazione, eliminazione se mai usato | ✅ | codice `STR-00001`; stato attivo, manutenzione o inattivo |
| Alimentazione | ✅ | elettrica, gas, mista, manuale |
| Parametri elettrici | ✅ | kW, coefficiente medio, di preriscaldamento e di mantenimento, tariffa |
| Parametri gas | ✅ | da portata (m³/h o Smc/h) oppure da potenza (kW); fattore di carico; tariffa |
| Avvisi di completezza | ✅ | `warnings` in risposta: potenza, coefficiente o tariffa mancanti, unità gas incoerente con la tariffa |
| Controllo del tipo di tariffa | ✅ | elettrica su elettricità, gas su gas |

### 3.5 Dipendenti e costo del lavoro
| Funzionalità | Stato | Dettagli |
|---|---|---|
| CRUD, archiviazione | ✅ | codice `DIP-00001`; stato; collegamento facoltativo a un utente dell'azienda |
| Configurazioni di costo con decorrenza | ✅ | lordo mensile; oneri in **una sola** modalità (nessuno, importo o percentuale ≤ 200%); altri costi; ore produttive (fino a 744) |
| Anteprima del costo | ✅ | costo orario lordo e aziendale, costo al minuto, base "solo lordo" o "costo aziendale" |
| Riservatezza delle retribuzioni | ✅ | senza `salaries.read` i campi **non sono nel payload**; mai importi nei log di audit |

### 3.6 Ricette
| Funzionalità | Stato | Dettagli |
|---|---|---|
| Elenco | ✅ | ricerca, stato, categoria, completezza, ordinamento anche per costo e €/kg; costi correnti dalla cache |
| Editor | ✅ | intestazione; resa (quantità e unità, peso finale netto, porzioni, durata, note); fasi; componenti (ingredienti o semilavorati); usi degli strumenti (fase, segmento preriscaldamento/lavoro/mantenimento, minuti, quota %, fonti, consumi misurati); manodopera (fase, minuti attivi, quota %) |
| Anteprima dei costi nell'editor | ✅ | calcolata dal backend mentre si compila, circa 450 ms dopo l'ultima modifica |
| Revisioni immutabili | ✅ | ogni salvataggio crea una revisione; storico consultabile |
| Concorrenza | ✅ | `lockVersion`; conflitto `stale` con messaggio che rassicura sulle modifiche non perse |
| Cicli | ✅ | impediti al salvataggio, anche indiretti, ricontrollati dentro la transazione; 409 `cycle` con il percorso; i semilavorati selezionabili escludono quelli che creerebbero un ciclo |
| Duplicazione | ✅ | titolo "Copia di …", stato bozza, nessuno snapshot copiato |
| Stati | ✅ | bozza, attiva, archiviata. Attenzione: il ripristino riporta sempre a **bozza** |
| Eliminazione | ✅ | solo se non è usata come semilavorato e non ha snapshot |
| Scheda | ✅ | costi, confronto con l'ultimo snapshot e motivi della variazione, elenco snapshot, "usata in", valorizzazione a una data scelta |
| Snapshot di costo | ✅ | fotografia JSON autosufficiente; transazione REPEATABLE READ con lock e verifica della revisione attesa |
| Fasi: inizio e durata | 🟡 | campi presenti in schema e API, **non nell'interfaccia** |

### 3.7 Dashboard
✅ Conteggi; ricette con valorizzazione incompleta, ordinate per numero di errori (prime 10, con tre problemi ciascuna); ingredienti senza prezzo; ultimi 5 prezzi inseriti; ultime ricette modificate. Le sezioni sono visibili in base ai permessi.

### 3.8 Importazioni
| Funzionalità | Stato | Dettagli |
|---|---|---|
| Tipi | ✅ | ingredienti (con prezzo) e dipendenti (con costo del lavoro) |
| Caricamento | ✅ | `.csv` o `.xlsx` fino a 10 MB; `.xls` rifiutato con istruzioni; controllo del contenuto reale (firma ZIP per xlsx, nessun byte nullo nei csv) |
| Rilevamento automatico | ✅ | separatore (`;` `,` tab), codifica (UTF-8 o Windows-1252), fogli, riga di intestazione, abbinamento delle colonne tramite alias |
| Opzioni | ✅ | foglio, separatore, codifica, riga d'intestazione, formato numeri (it, en, auto), codici esistenti (aggiorna o ignora), codici nuovi (crea o ignora), generazione dei codici |
| Validazione | ✅ | in background; tabella di staging; avanzamento; numeri e date all'italiana; formule rifiutate; duplicati interni; conflitti di storico (identico → ignorato, diverso → errore); avvisi |
| Conferma | ✅ | **atomica** (tutto o niente), idempotente, ricontrolla i permessi dell'autore e le modifiche avvenute dopo l'anteprima |
| Report CSV | ✅ | solo errori o tutte le righe, protetto da formula injection |
| Modelli | ✅ | CSV e XLSX con istruzioni |
| Conservazione | ✅ | file e righe di staging eliminati dopo 30 giorni |
| Modalità parziale | ⛔ | facoltativa nel capitolato, **non implementata** |

### 3.9 Pagine dell'interfaccia (22 pagine)
`/accedi`, `/password-dimenticata`, `/reimposta-password`, `/invito`, `/` (dashboard), `/ricette`, `/ricette/nuova`, `/ricette/[id]`, `/ricette/[id]/modifica`, `/ricette/[id]/snapshot/[snapshotId]`, `/ingredienti`, `/ingredienti/[id]`, `/strumenti`, `/strumenti/[id]`, `/utenze`, `/utenze/[id]`, `/dipendenti`, `/dipendenti/[id]`, `/importazioni`, `/importazioni/[id]`, `/utenti`, `/impostazioni`.

Componenti condivisi: `AppShell` (menu laterale fisso filtrato per permesso, selettore azienda, indicatore di caricamento, menu mobile), `DataTable`, `AsyncPicker`, `RecipeEditor` (691 righe), `CostSummary`, form per ingrediente, strumento e costo dipendente, e `ui.tsx` (Icon, Field, NumberInput con formato italiano, Drawer, Confirm, Toast, badge, AffectedNotice, gestione errori).

---

## 4. Formule e logiche di calcolo (da replicare senza modifiche)

Fonte: `packages/domain/src/{calculators,engine,units}.ts`, coerente con `docs/FORMULE.md`.

**Aritmetica.** Decimali a 40 cifre significative con arrotondamento ROUND_HALF_UP **a ogni operazione** (comportamento di decimal.js). Nessun arrotondamento intermedio: si arrotonda solo in visualizzazione. Serializzazione con `toFixed()`, cioè senza notazione esponenziale.

**Ingredienti**
- prezzo normalizzato = prezzo confezione ÷ contenuto convertito nell'unità base (kg, l o pz)
- quantità netta = quantità in ricetta convertita nella grandezza della confezione (con densità e peso unitario se servono, altrimenti errore)
- quantità lorda = netta ÷ resa edibile
- costo = lorda × prezzo normalizzato
- prezzo assente → errore `missing_price`; prezzo zero → info `zero_price`
- se l'ingrediente ha un prezzo, confezione e unità valgono quelle registrate sulla voce di prezzo, non quelle correnti

**Energia** (per ogni uso, poi × quota)
- elettrica: kWh = kW × min ÷ 60 × coefficiente del segmento (preriscaldamento o mantenimento se configurati, altrimenti quello medio); costo = kWh × €/kWh
- gas da portata: consumo = portata × min ÷ 60 [× fattore di carico]
- gas da potenza: kWh = kW × min ÷ 60 × (fattore di carico, oppure 1)
- i consumi misurati sostituiscono la stima
- conversione verso l'unità della tariffa solo con i coefficienti configurati, in 6 combinazioni; altrimenti errore `gas_unit_mismatch`
- strumenti misti: le fonti indicate, oppure entrambe; strumenti manuali: costo 0
- info `shared_equipment` se la quota è sotto il 100%; info `estimated_energy` se il consumo è stimato

**Manodopera**
- oneri: importo, oppure lordo × % ÷ 100, oppure 0
- costo aziendale mensile = lordo + oneri + altri costi
- costo orario = costo mensile ÷ ore produttive
- costo al minuto = costo orario ÷ 60
- costo della riga = minuti attivi × costo al minuto × quota
- avviso `gross_only` se non ci sono né oneri né altri costi; il dipendente senza configurazione valida alla data genera l'errore `missing_labor_cost`

**Ricetta**
- totale = ingredienti diretti + semilavorati + energia + manodopera, sommando **solo le righe valorizzate**
- costo/kg = totale ÷ peso finale netto; costo/porzione = totale ÷ porzioni; costo per unità di resa = totale ÷ resa nell'unità base
- semilavorato: se dosato a peso e la sottoricetta ha il peso finale, base "weight"; altrimenti, se la resa è nella stessa grandezza della dose, base "yield"; altrimenti errore `incompatible_subrecipe_unit`
- frazione prelevata = quantità ÷ denominatore; costo della riga = totale della sottoricetta × frazione
- riepilogo espanso = voci della sottoricetta × frazione, che **sostituiscono** il subtotale invece di sommarsi
- gli errori e gli avvisi delle sottoricette risalgono al padre con il percorso; non risalgono le info né `missing_final_weight`, `missing_portions`, `missing_yield`
- deduplica delle segnalazioni; profondità massima 12 livelli, 2.000 nodi; memoizzazione per ricetta dentro la stessa valorizzazione
- la ricetta è **completa** se non ci sono segnalazioni di gravità "error"
- minuti macchina, minuti-persona e durata dichiarata sono mostrati separatamente

**Confronto con lo snapshot.** Motivi possibili: cambio di revisione; resa o porzioni modificate; prezzi variati; tariffe variate; manodopera variata (il testo cambia in base a `salaries.read`); costo dei semilavorati variato; in alternativa il motivo generico. Delta assoluto, percentuale, €/kg e €/porzione.

**Oscuramento in risposta.** Senza `costs.read` la valorizzazione è `null`. Senza `salaries.read` costo e costo al minuto delle righe di manodopera sono `null` anche nelle sottoricette annidate; resta il subtotale aggregato.

**Casi di verifica (i valori attesi diventeranno test PHP):** A 0,90 € · B 15 €/h, 0,25 €/min, 3 € solo lordo · C 1,6 kWh, 0,48 € · D 0,5 m³, 0,60 €, €/Smc rifiutato · E ragù 34 €, 6,80 €/kg; lasagna 19,08 €, 7,95 €/kg, 2,385 €/porzione; espanso 10,40 + 1,24 + 7,44.

---

## 5. Struttura del database (PostgreSQL → MySQL)

25 tabelle in `apps/api/src/db/migrations/001_schema.sql`:

| Area | Tabelle |
|---|---|
| Accesso | `companies`, `users`, `memberships`, `sessions`, `password_resets`, `invitations`, `audit_logs` |
| Anagrafiche | `ingredients`, `ingredient_prices`, `utility_tariffs`, `tariff_versions`, `equipment`, `employees`, `employee_cost_configs` |
| Ricette | `recipes`, `recipe_revisions`, `recipe_phases`, `recipe_components`, `recipe_equipment_uses`, `recipe_labor` |
| Costi | `cost_snapshots`, `recipe_cost_cache` |
| Importazioni | `imports`, `import_rows`, `jobs` |

Vincoli rilevanti: chiavi UUID; importi `NUMERIC`; codici unici per azienda senza distinzione di maiuscole (`UNIQUE (company_id, lower(code))`); una sola voce di storico per data (`UNIQUE (…, valid_from)`); molti `CHECK` (unità ammesse, resa in (0,1], quote in (0,1], coerenza tipo-unità delle tariffe, una sola modalità per gli oneri, componente che è **o** ingrediente **o** sottoricetta); chiave esterna circolare `recipes.current_revision_id` ↔ `recipe_revisions`.

**Elementi specifici di PostgreSQL da convertire:**

| PostgreSQL | MySQL proposto |
|---|---|
| `uuid` + `gen_random_uuid()` | `char(36)` + `HasUuids` di Laravel |
| `text[]` (`extra_permissions`, `sources`) | colonna `JSON` |
| `jsonb` | `JSON` |
| `UNIQUE (company_id, lower(code))` | `UNIQUE (company_id, code)` con collation **case-insensitive ma accent-sensitive** (`utf8mb4_0900_as_ci`), che riproduce `lower()` |
| `CHECK` | supportati da MySQL ≥ 8.0.16; ripetuti comunque nella validazione applicativa |
| `LEFT JOIN LATERAL … LIMIT 1` (prezzo, tariffa o costo valido alla data) | sottoquery correlate o `ROW_NUMBER()`, portabili anche su MariaDB |
| `count(*) over()` | supportato da MySQL 8; in alternativa conteggio separato |
| `NULLS LAST` | `ORDER BY col IS NULL, col` |
| `FOR UPDATE SKIP LOCKED` (coda) | non necessario senza worker (§6.3) |
| `bigserial` | `BIGINT UNSIGNED AUTO_INCREMENT` |
| `INSERT … ON CONFLICT` | `upsert()` di Laravel / `ON DUPLICATE KEY UPDATE` |
| regex `~` in `nextCode` | `REGEXP` di MySQL 8, oppure calcolo in PHP |

---

## 6. Criticità della migrazione

### 6.1 Bloccanti o da decidere subito
1. **Packagist non raggiungibile da questo ambiente.** Senza dipendenze Composer non si possono installare né testare Laravel e le librerie (§7, decisione 1).
2. **Il frontend Next.js in produzione richiede Node** (`output: standalone`). Va trasformato in asset statici (§8).
3. **Rotte dinamiche e export statico.** `output: 'export'` di Next richiede `generateStaticParams` per `/ricette/[id]` e simili, incompatibile con ID creati a runtime senza cambiare gli URL.
4. **Worker continuo delle importazioni**, non disponibile su hosting condiviso (§6.3).

### 6.2 Fedeltà numerica
5. **Precisione decimale.** Serve emulare esattamente decimal.js: 40 cifre significative con ROUND_HALF_UP a ogni operazione. Altrimenti le stringhe restituite dall'API e salvate negli snapshot potrebbero differire nelle ultime cifre. Proposta: una classe `Dec` su `brick/math` e **test "golden"** che confrontano, sugli stessi dati, l'output JSON del motore TypeScript originale con quello del motore PHP.
6. **Formato delle risposte.** Va replicato campo per campo: camelCase, decimali come stringhe, date `aaaa-mm-gg`, codici d'errore e messaggi italiani di Zod e personalizzati. Il frontend dipende da questi dettagli.

### 6.3 Hosting condiviso
7. **Importazioni senza worker.** Proposta: elaborazione **a blocchi guidata dal polling** già presente nell'interfaccia (ogni 700 ms durante la validazione e l'applicazione). Ogni `GET /imports/:id` fa avanzare il lavoro di un blocco limitato nel tempo (pochi secondi), sotto `max_execution_time`. Se c'è il cron, il comando `schedule:run` fa lo stesso in modo affidabile. L'applicazione atomica di 20.000 righe in una sola transazione va verificata con i limiti reali dell'hosting.
8. **Pulizia periodica delle importazioni** (30 giorni): eseguita in modo opportunistico durante le richieste, oppure via cron se disponibile.
9. **Senza SSH né Composer sul server:** `vendor/` e asset compilati si preparano in locale e si caricano via FTP; le migrazioni si avviano da una procedura di installazione protetta e monouso (oppure via SSH, se c'è).
10. **Versione di MySQL dell'hosting:** CHECK, funzioni finestra e collation `0900` richiedono MySQL 8.0.16 o successivo. Su MariaDB servono adattamenti (collation, nessun `0900_as_ci`). Da verificare sul piano Aruba scelto.
11. **Directory pubblica:** se non si può puntare il dominio su `public/`, serve una configurazione `.htaccess` alternativa che protegga `.env`, `storage/` e `vendor/`.

### 6.4 Sicurezza e sessioni
12. **Sessioni e azienda attiva.** L'originale chiude le sessioni per utente e per azienda attiva (disattivazione di una membership). Proposta: un guard Laravel personalizzato sulla stessa tabella `sessions` dell'originale (hash del token, `active_company_id`), invece della sessione standard di Laravel.
13. **CSRF.** Va replicato il controllo header + Origin dell'originale con un middleware dedicato, così `lib/api.ts` non cambia. L'alternativa è il token XSRF di Laravel, che richiede una piccola modifica al client.
14. **Password scrypt.** Rilevante solo se ci sono utenti reali da migrare (§7, decisione 3).

### 6.5 Possibili anomalie nell'originale (da replicare così come sono, salvo tua decisione)
- `PATCH /employees/:id` e `PATCH /tariffs/:id` non usano `lockVersion`, a differenza delle altre anagrafiche.
- `POST /recipes/:id/restore` riporta sempre lo stato a **bozza**, anche se prima dell'archiviazione la ricetta era attiva.
- `GET /recipes/options` applica `LIMIT 50` prima di escludere le ricette che creerebbero un ciclo: può restituire meno di 50 risultati anche se ce ne sono altri.
- Le tariffe archiviate continuano a essere usate nelle valorizzazioni (non vengono filtrate). Sembra voluto, ma non è documentato.

---

## 7. Decisioni che servono da te

1. **Accesso a Packagist** (bloccante):
   - **(a, consigliata)** abilitare `repo.packagist.org` (e i download collegati) per questo ambiente;
   - **(b)** installare Laravel e le librerie dai repository sorgente su GitHub (raggiungibile), dichiarandoli in `composer.json`. Funziona, ma è più lento e fragile; lo uso solo con la tua approvazione esplicita;
   - **(c)** sviluppare e testare sul tuo PC Windows con Docker, collegando una cartella dall'app desktop di Claude. Lì Composer scarica normalmente.
2. **Frontend:** Vite + React Router con adattatori per `next/link` e `next/navigation` (consigliata, §8) oppure export statico Next con URL cambiati.
3. **Dati esistenti:** l'applicazione originale è già in uso con dati reali da migrare da PostgreSQL? Se sì, servono uno script di migrazione dei dati e la compatibilità con le password scrypt; se no, si parte con database vuoto e dati dimostrativi.
4. **Hosting:** piano Aruba (o altro) previsto, versione di PHP e MySQL o MariaDB, disponibilità di SSH e cron. Anche più avanti, ma prima della fase di pubblicazione.
5. **Anomalie del §6.5:** replicarle tali e quali (impostazione di default, per fedeltà) oppure correggerle.

---

## 8. Frontend: cosa si conserva

**Si conserva integralmente:** tutte le 22 pagine, i componenti, `globals.css`, `lib/` (api, hooks, session, num, labels, cost-types) e la logica di TanStack Query. Restano identici struttura delle pagine, menu, dashboard, tabelle, filtri, form, finestre modali e pannelli, messaggi e comportamento responsive.

**Cambia solo l'involucro di build e routing (proposta consigliata):**
- build con **Vite** invece di Next, verso asset statici in `public/build`, serviti da Laravel;
- moduli adattatori `next/link` e `next/navigation` (`Link`, `useRouter`, `useParams`, `usePathname`) basati su React Router, associati tramite alias di Vite. **I file delle pagine non si modificano**; si aggiunge solo una tabella delle rotte che rispecchia la cartella `app/`;
- i due layout (`(auth)` e `(app)` con `AppShell`) diventano rotte "layout" di React Router; il `metadata` del layout radice passa in `index.html`;
- le direttive `'use client'` restano e sono innocue;
- gli helper di formattazione del pacchetto di dominio (`formatEuro`, `formatNumber`, `parseItalianNumber`, `d`) restano in TypeScript nel frontend, senza cambiamenti;
- Laravel risponde con `index.html` a ogni percorso che non inizia con `/api`, così anche i link diretti a `/ricette/<id>` funzionano.

Prezzo da pagare: si perde il prefetch automatico dei link di Next; si recupera con il prefetch dei dati già fatto da TanStack Query e, se serve, con `prefetch` sui link. Nessun impatto visivo.

**Alternativa:** export statico di Next, sostituendo i segmenti dinamici con parametri di query (`/ricette/dettaglio?id=…`). Richiede modifiche a più pagine e cambia gli URL, quindi non la consiglio.

---

## 9. Nuova architettura Laravel proposta

```
food-cost-laravel/
├── app/
│   ├── Domain/Costing/        port 1:1 di packages/domain: Dec (brick/math, precisione 40), Units,
│   │                          Calculators, RecipeCostEngine, Graph, Serializer; nessuna dipendenza da Laravel
│   ├── Http/
│   │   ├── Controllers/Api/   Auth, Users, Companies, Ingredients, Tariffs, Equipment, Employees,
│   │   │                      Recipes, Snapshots, Dashboard, Imports
│   │   ├── Requests/          Form Request con messaggi italiani identici a quelli di Zod
│   │   ├── Middleware/        CsrfHeader (X-Requested-With + Origin), TenantContext, SecurityHeaders
│   │   └── Resources/         serializzazione camelCase identica all'originale
│   ├── Auth/                  guard personalizzato su tabella sessions (hash del token, azienda attiva)
│   ├── Policies + Gates       permessi effettivi (ruolo + permessi aggiuntivi + implicazioni)
│   ├── Services/              Costing (contesto, cache, invalidazione), Recipes, Audit, Codes,
│   │                          Imports (lettura, normalizzazione, validazione, applicazione), Mail
│   ├── Models/                25 modelli Eloquent
│   └── Console/Commands/      foodcost:create-admin, foodcost:seed-demo, foodcost:imports-cleanup
├── database/migrations/       schema MySQL equivalente, con vincoli e indici
├── routes/api.php             stessi percorsi e metodi dell'originale, con prefisso /api
├── routes/web.php             fallback SPA → index.html
├── resources/frontend/        apps/web conservato + adattatori next/* + vite.config
├── tests/
│   ├── Domain/                casi A–E e 27 test di dominio portati in PHP + test golden TS↔PHP
│   ├── Feature/               53 test API portati (autenticazione, isolamento, costi, importazioni, velocità)
│   └── e2e/                   flusso ricetta in Chrome headless (port di flusso-ricetta.mjs)
├── docker/ + docker-compose.yml   PHP 8.3 + Apache, MySQL 8, Node solo per sviluppo e build
└── docs: README, ARCHITETTURA, TASKS, MATRICE_PARITA_FUNZIONALE, DEPLOYMENT, .env.example
```

Requisiti minimi dell'hosting (da confermare): PHP ≥ 8.3 con `pdo_mysql`, `mbstring`, `openssl`, `fileinfo`, `zip`, `ctype`, `tokenizer`, `xml`; MySQL ≥ 8.0.16; HTTPS; possibilità di indicare la cartella pubblica oppure di usare `.htaccess`. SSH e cron sono utili ma non indispensabili.

Esclusi in assenza di tua approvazione: Octane, WebSocket, Redis, code con worker permanente.

---

## 10. Piano di sviluppo in task

Ogni task si chiude solo con i test indicati superati. Il dettaglio completo (file, criteri, test, stato) andrà in `TASKS.md` dopo la tua approvazione.

| # | Task | Dipende da | Criterio di accettazione |
|---|---|---|---|
| T00 | Decisioni del §7 e ambiente di sviluppo (accesso a Composer) | — | `composer install` di Laravel 13 riuscito |
| T01 | Scheletro Laravel 13, Docker Compose (PHP 8.3, Apache, MySQL 8), `.env.example`, avvio con un comando | T00 | `docker compose up` → `/api/health` risponde `{ok:true}` |
| T02 | Migrazioni MySQL delle 25 tabelle con vincoli e indici; modelli Eloquent | T01 | migrazione da zero e rollback; test sui vincoli CHECK e UNIQUE |
| T03 | Dominio: `Dec` (emulazione decimal.js), unità, conversioni, formati | T01 | test di precisione e arrotondamento, conversioni e incompatibilità |
| T04 | Dominio: calcolatori di ingredienti, energia e manodopera | T03 | casi A, B, C, D identici |
| T05 | Dominio: motore delle ricette, grafo, serializzazione | T04 | caso E, 27 test di dominio, **test golden** TS↔PHP su fixture condivise |
| T06 | Infrastruttura HTTP: formato errori, validazione con messaggi italiani, CSRF, header di sicurezza, rate limiting | T01 | test su CSRF, 422 con `fields`, 429 |
| T07 | Autenticazione: guard su `sessions`, login, logout, me, scelta azienda, cambio, recupero e reimpostazione password, email | T02, T06 | test di autenticazione portati |
| T08 | Permessi (ruoli, aggiuntivi, implicazioni), Gate e Policy, contesto aziendale | T07 | test di isolamento tra aziende e permessi |
| T09 | Utenti, inviti, aziende, ultimo amministratore, audit | T08 | test su utenti e inviti |
| T10 | Ingredienti e storico prezzi, categorie, archiviazione ed eliminazione | T08 | test su prezzi, conflitti e conversioni |
| T11 | Tariffe, versioni dirette e da bolletta, anteprima, coefficienti gas | T08 | test su bolletta e €/Smc |
| T12 | Strumenti con avvisi di completezza | T11 | test su prezzi, utenze e strumenti |
| T13 | Dipendenti, configurazioni di costo, anteprima, riservatezza | T08 | test sulle retribuzioni nascoste |
| T14 | Servizio costi: contesto alla data, cache, ricette interessate, invalidazione | T05, T10–T13 | test di propagazione indiretta |
| T15 | Ricette: CRUD, revisioni, cicli, anteprima, duplicazione, stati, eliminazione, opzioni | T14 | test sull'editor |
| T16 | Valorizzazione a una data, snapshot, confronto, oscuramento | T15 | test ragù → lasagna e snapshot immutabili |
| T17 | Dashboard | T16 | confronto JSON con l'originale sui dati demo |
| T18 | Importazioni: caricamento, rilevamento, anteprima, modelli | T10, T13 | test CSV italiano e XLSX |
| T19 | Importazioni: validazione a blocchi senza worker, applicazione atomica, report, pulizia | T18 | test su atomicità, idempotenza, 5.000 righe e limiti |
| T20 | Frontend: Vite + React Router + adattatori `next/*`, servito da Laravel | T06 | build statica; tutte le 22 pagine raggiungibili anche da link diretto |
| T21 | Collegamento frontend ↔ API Laravel, modulo per modulo | T20, T07–T19 | flussi manuali del README originale (punti 1–7) |
| T22 | Dati dimostrativi e comandi `create-admin` e `seed-demo` | T16 | stessi dati e valori dell'originale |
| T23 | Test E2E in Chrome headless e confronto visivo con l'originale | T21, T22 | flusso ricetta superato; schermate affiancate senza differenze significative |
| T24 | Pacchetto per hosting condiviso: build pronta per FTP, `.htaccess`, installazione senza SSH, permessi, log, HTTPS, controlli di produzione | T21 | installazione di prova su Apache "tipo condiviso" senza SSH |
| T25 | Documentazione finale e `MATRICE_PARITA_FUNZIONALE.md` | tutti | ogni funzionalità con stato, test e differenze |
| T26 | Verifica finale indipendente | T25 | revisione senza difetti aperti bloccanti |

Ordine di lavoro: T00 → T01 → (T02 ∥ T03) → T04 → T05 → T06 → T07 → T08 → T09–T13 → T14 → T15 → T16 → T17 → T18 → T19; T20 può partire dopo T06, in parallelo al backend; poi T21–T26.
