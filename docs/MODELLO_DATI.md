# Modello dati

Schema completo in `apps/api/src/db/migrations/001_schema.sql` (PostgreSQL 15+). Convenzioni:

- **Multi-azienda**: ogni tabella aziendale ha `company_id`. Le query sono sempre delimitate all’azienda ricavata dalla sessione e verificata sulle membership; gli indici delle anagrafiche iniziano da `company_id`.
- **Importi e quantità**: `NUMERIC`, letti come stringhe esatte.
- **Codici** unici per azienda senza distinzione di maiuscole (`UNIQUE (company_id, lower(code))`).
- **Archiviazione** invece di cancellazione per tutto ciò che è referenziato.

## Accesso

| Tabella | Contenuto |
|---|---|
| `companies` | aziende clienti |
| `users` | account di accesso (password con scrypt), flag amministratore di piattaforma |
| `memberships` | utente ↔ azienda: ruolo (`admin`, `manager`, `operator`), permessi aggiuntivi, stato |
| `sessions` | sessioni (solo hash del token), azienda attiva selezionata esplicitamente |
| `password_resets`, `invitations` | token monouso (solo hash) con scadenza |
| `audit_logs` | chi ha fatto cosa: prezzi, tariffe, costi lavoro, ricette, snapshot, importazioni. Mai importi retributivi |

## Anagrafiche e storici

| Tabella | Note |
|---|---|
| `ingredients` | confezione corrente, unità in ricetta, resa edibile (0 < r ≤ 1), densità, peso unitario |
| `ingredient_prices` | storico: prezzo **e** confezione a cui si riferisce, `valid_from`, fonte, `import_id`; `UNIQUE (ingredient_id, valid_from)` |
| `utility_tariffs` | elettricità (solo kWh), gas (m³, Smc, kWh), acqua (m³) |
| `tariff_versions` | storico: prezzo unitario, origine (diretta / bolletta con dettaglio JSON), coefficienti m³→Smc e kWh/Smc; `UNIQUE (tariff_id, valid_from)` |
| `equipment` | alimentazione, potenza, coefficienti (medio, preriscaldamento, mantenimento), parametri gas, tariffe collegate |
| `employees` | risorse di produzione, collegamento facoltativo a un utente |
| `employee_cost_configs` | storico: lordo, oneri (una sola modalità, vincolo CHECK), altri costi, ore produttive; `UNIQUE (employee_id, valid_from)` |

## Ricette

| Tabella | Note |
|---|---|
| `recipes` | identità: codice, titolo, stato (bozza/attiva/archiviata), revisione corrente, `lock_version` |
| `recipe_revisions` | **immutabili**: ogni salvataggio crea una revisione con resa, porzioni, durata, istruzioni |
| `recipe_phases` | fasi ordinate della revisione |
| `recipe_components` | ingrediente **oppure** sottoricetta: `CHECK ((ingredient_id IS NULL) <> (sub_recipe_id IS NULL))`; quantità nulla ammessa solo nelle bozze |
| `recipe_equipment_uses` | strumento, fase, segmento, minuti, quota, fonti usate, consumi misurati |
| `recipe_labor` | dipendente, fase, minuti attivi, quota |

Il grafo delle sottoricette è ricavato dalle revisioni correnti. I cicli (anche indiretti) sono impediti al salvataggio, dentro la transazione.

## Costi

| Tabella | Note |
|---|---|
| `cost_snapshots` | fotografia **autosufficiente** in JSON: righe, prezzi, tariffe, costi al minuto, rese e sottoricette annidate con le loro revisioni. Creata in transazione `REPEATABLE READ` con lock sulla ricetta e verifica della revisione attesa |
| `recipe_cost_cache` | valorizzazione corrente per (ricetta, data). Invalidata da prezzi, tariffe, strumenti, costi del lavoro, resa o composizione per la ricetta e tutte quelle che ne dipendono |

## Importazioni e lavori

| Tabella | Note |
|---|---|
| `imports` | file in storage privato, opzioni, abbinamento colonne, riepilogo (con l’ordine delle colonne), stato, `lock_version` |
| `import_rows` | staging: dati grezzi, valori normalizzati, esito, errori, avvisi |
| `jobs` | coda su database con chiave di idempotenza (`dedupe_key`) e presa in carico `FOR UPDATE SKIP LOCKED` |
