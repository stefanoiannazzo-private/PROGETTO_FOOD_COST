# Food Cost — Piano tecnico e decisioni

Documento vivo: viene aggiornato a ogni fase. Ultimo aggiornamento: 2 novembre 2026, fase 1.

## 1. Stato del repository

Il repository `PROGETTO_FOOD_COST` era vuoto alla prima ispezione: nessun codice, nessuna istruzione preesistente. Il progetto parte da zero con lo stack di riferimento delle specifiche.

## 2. Architettura

Monorepo con due applicazioni e un dominio di calcolo isolato:

```
/backend    Laravel 12, API-first (JSON), PHP 8.3
            app/Domain/Costing   motore di calcolo puro, senza dipendenze da HTTP o UI
            app/Domain/Units     conversioni di unità e grandezze
            app/Http             controller sottili, FormRequest, Resource
            app/Jobs             importazioni asincrone a blocchi
/frontend   Next.js (App Router) + React + TypeScript
/docs       piano, modello dati, formule, API
/templates  modelli CSV/XLSX per le importazioni
docker-compose.yml   MySQL 8.4 e Redis per lo sviluppo locale
```

Niente microservizi: un'API, un frontend, un worker di coda, un database.

### Perché questa forma
- Il motore di calcolo è una libreria di dominio con input espliciti (quantità, prezzi, tariffe, costi del lavoro alla data) e output esplicito (righe valorizzate, totali, segnalazioni di incompletezza). È testabile senza database e viene riusato da anteprima, salvataggio, snapshot e importazioni.
- Il frontend mostra anteprime immediate, ma il valore autorevole è sempre quello restituito dal backend.

## 3. Velocità percepita: requisito esplicito del cliente

Obiettivo: nessuna attesa visibile nella navigazione ordinaria. Scelte concrete:

| Ambito | Scelta |
|---|---|
| Navigazione | App Router con navigazione client-side e prefetch dei link del menu; il guscio dell'applicazione (menu, intestazione) non si ricarica mai. |
| Dati | Cache lato client (TanStack Query): le liste già viste si mostrano subito e si aggiornano in background; mutazioni con aggiornamento ottimistico dove sicuro. |
| Liste | Paginazione, ricerca e ordinamento server-side con indici composti che iniziano sempre da `company_id`; risposte leggere (solo i campi della lista). |
| Ricerca | Ricerca con debounce di 200 ms e annullamento delle richieste superate. |
| Editor ricetta | Il riepilogo costi si ricalcola in anteprima sul client a ogni modifica e viene confermato dal backend in background; nessun salvataggio blocca la digitazione. |
| Calcolo | Memoizzazione delle sottoricette per (azienda, revisione, data) durante un calcolo; cache dei costi correnti invalidata a eventi su prezzi, tariffe, lavoro, resa e composizione. |
| Backend | OPcache, cache di configurazione e route in produzione, Redis per cache e code, eager loading per evitare query N+1. |
| Importazioni | Mai sincrone: job in coda, avanzamento interrogato a intervalli brevi. |

Obiettivi misurabili, verificati in fase 7: risposte API delle liste sotto 150 ms in locale con alcune migliaia di record, cambio pagina senza schermata di caricamento completa.

## 4. Multi-tenancy e sicurezza

- Database condiviso, colonna `company_id` su tutte le entità aziendali.
- L'azienda attiva deriva dalla sessione autenticata e viene verificata contro le membership dell'utente a ogni richiesta; l'ID che arriva dal browser serve solo a *scegliere* tra le aziende autorizzate.
- Global scope Eloquent per azienda su ogni modello aziendale, più policy per risorsa: un ID di un'altra azienda restituisce 404.
- Autenticazione: Laravel Sanctum in modalità SPA (cookie di sessione + CSRF), password gestite dal framework, rate limiting su login e recupero password.
- Ruoli per azienda: amministratore, responsabile, operatore. Permessi distinti e assegnabili: `employees.manage`, `salaries.read`, `costs.read`, `tariffs.manage`, oltre ai permessi di gestione anagrafiche.
- Le retribuzioni sono escluse dai payload (Resource condizionali) senza `salaries.read`; mai nei log.
- Audit essenziale su prezzi, tariffe, costi del lavoro, ricette e importazioni.

## 5. Modello dati (sintesi)

Il dettaglio dei campi è in `docs/MODELLO_DATI.md` (fase 2). Entità principali:

- `companies`, `users`, `company_user` (ruolo e permessi aggiuntivi), `invitations`
- `ingredients`, `ingredient_prices` (storico con data di validità)
- `utility_tariffs` (elettricità, gas; estendibile ad acqua) con `utility_bills` per la modalità assistita
- `equipment` con parametri elettrici e gas
- `employees`, `employee_cost_configs` (storico con validità)
- `recipes`, `recipe_revisions` (composizione immutabile per revisione)
- `recipe_components` (ingrediente **oppure** sottoricetta, vincolo CHECK)
- `recipe_phases`, `recipe_equipment_uses`, `recipe_labor_assignments`
- `cost_snapshots` (fotografia immutabile, autosufficiente, in JSON + colonne di riepilogo)
- `imports`, `import_rows` (staging), `audit_logs`

Tutti gli importi e le quantità sono `DECIMAL`; nel codice si usa aritmetica decimale (brick/math), arrotondando solo in visualizzazione.

## 6. Formule

| Voce | Formula |
|---|---|
| Prezzo normalizzato ingrediente | prezzo confezione / contenuto confezione nell'unità base (kg, l, pz) |
| Quantità acquistata equivalente | quantità netta / resa edibile |
| Costo riga ingrediente | quantità acquistata equivalente × prezzo normalizzato |
| Costo riga semilavorato | quantità prelevata × costo unitario della sottoricetta (totale / resa finale) |
| Elettricità | kWh = kW × minuti / 60 × coefficiente di utilizzo; costo = kWh × €/kWh |
| Gas (portata) | consumo = portata oraria × minuti / 60 [× fattore di carico, una sola volta]; costo = consumo × tariffa nella stessa unità |
| Quota condivisa | costo uso strumento × quota di imputazione |
| Costo lavoro | costo orario aziendale = (lordo + oneri + altri costi) / ore produttive; costo/minuto = costo orario / 60; riga = minuti attivi × costo/minuto × quota |
| Totale lotto | ingredienti diretti + semilavorati + strumenti + manodopera |
| Costo/kg | totale / peso finale netto in kg |
| Costo/porzione | totale / numero porzioni |

Regole trasversali: nessuna conversione volume↔peso senza densità, nessuna pezzi↔peso senza peso unitario, m³ ≠ Smc, gas → kWh solo con coefficiente esplicito. Dati mancanti producono uno stato "incompleto" con le voci mancanti elencate, mai un totale definitivo.

## 7. Fasi di consegna

| Fase | Contenuto | Stato |
|---|---|---|
| 1 | Ispezione, piano, decisioni | completata |
| 2 | Autenticazione, aziende, ruoli, modello dati, migrazioni | da fare |
| 3 | Anagrafiche ingredienti/prezzi, utenze, strumenti, dipendenti | da fare |
| 4 | Motore di calcolo con i test numerici A–E | da fare |
| 5 | Editor ricette, annidamento, scheda, valorizzazioni, snapshot | da fare |
| 6 | Importazioni CSV/XLSX con anteprima, validazione, report | da fare |
| 7 | Dashboard, rifinitura UI, verifiche di velocità, documentazione | da fare |

## 8. Assunzioni

- Valuta EUR, interfaccia e formati italiani; le API scambiano numeri normalizzati come stringhe decimali con il punto.
- Tutti i costi inseriti sono netti IVA; la convenzione è mostrata nell'interfaccia.
- Database di sviluppo e produzione MySQL 8.4; i test automatici usano MySQL quando disponibile e SQLite come ripiego, con i vincoli CHECK verificati anche a livello applicativo.
- Push consentito solo sul repository `stefanoiannazzo-private/PROGETTO_FOOD_COST`, su richiesta esplicita del cliente; nessun deploy.

## 9. Blocchi aperti

- **Registri pacchetti non raggiungibili** dall'ambiente di sviluppo (Packagist, npm): da sbloccare nelle impostazioni di rete dell'account. Senza di essi non è possibile installare Laravel/Next.js né eseguire i test.
- **Scrittura sul repository**: richiede l'installazione dell'app GitHub di Claude sull'account.
- **MySQL** non disponibile nell'ambiente di sviluppo (nessun Docker attivo): i test useranno SQLite finché non è disponibile; `docker-compose.yml` sarà fornito per l'uso in locale.
