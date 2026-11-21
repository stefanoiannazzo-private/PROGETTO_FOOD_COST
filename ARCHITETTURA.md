# Architettura

Obiettivo: lo **stesso comportamento** dell'originale (Fastify + Next.js + PostgreSQL), con stessi numeri, stesse risposte API e stessa interfaccia. Il tutto deve girare su un **hosting condiviso** con PHP e MySQL, senza processi permanenti.

```
 Browser ── SPA React (pagine originali, compilate con Vite) ──► /api/*  (stesso dominio, cookie fc_session)
                                                                  │
                         Apache + .htaccess ─► public/index.php ─► Laravel 13
                                                                  ├─ Middleware: CSRF, sessione, intestazioni di sicurezza
                                                                  ├─ Controller (stesse rotte e formati dell'originale)
                                                                  ├─ Servizi: costi e cache, ricette, importazioni, lavori, audit, email
                                                                  └─ Dominio: motore di calcolo (port 1:1, aritmetica decimal.js)
                                                                  ▼
                                                               MySQL 8
```

## 1. Corrispondenza con l'originale

| Originale | Clone |
|---|---|
| `packages/domain` (TypeScript) | `app/Domain/Costing` (stessi algoritmi, file per file) |
| `apps/api` Fastify + Kysely | `app/Http/Controllers/Api` + query builder di Laravel |
| zod (validazione) | `app/Support/Validation` (S, Schema): stessi messaggi italiani e stesso formato `{error:{code,message,details:{fields}}}` |
| `auth/sessions.ts`, `auth/permissions.ts` | `app/Services/Sessions.php`, `app/Auth/Permissions.php` |
| worker delle importazioni (processo continuo) | coda nella tabella `jobs` eseguita senza worker (§5) |
| `apps/web` Next.js | `resources/frontend`: **stesse pagine e stessi componenti**, compilati con Vite (§6) |
| PostgreSQL / PGlite | MySQL 8 (§4) |

## 2. Fedeltà numerica

Tutti i calcoli usano `App\Domain\Costing\Dec` (su `brick/math`), che emula decimal.js come configurato nell'originale.

- **Precisione e arrotondamento:** 40 cifre significative, ROUND_HALF_UP dopo **ogni** operazione.
- **Divisione:** troncata con cifre di guardia, poi arrotondata nello stesso modo.
- **Serializzazione:** come `toFixed()` senza zeri finali.

**Come si verifica:** `tools/golden/generate.ts` esegue il **codice originale** e produce i casi in `tests/Fixtures/golden/`. `tests/Unit/Domain/GoldenParityTest.php` controlla che il motore PHP restituisca le stesse stringhe, carattere per carattere. I casi sono:
- 250 contesti con 1.055 ricette;
- 625 operazioni decimali;
- 66 numeri in formato italiano;
- 120 grafi di dipendenze.

Le formule sono quelle dell'originale, senza modifiche. L'unica aggiunta è la **voce extra della retribuzione** (`extraMonthly`), richiesta per il SaaS:
- si somma al lordo mensile dopo il controllo sul lordo negativo;
- le percentuali degli oneri si applicano a lordo + extra;
- se è assente, non ha alcun effetto, quindi i numeri dell'originale restano identici.

## 3. API, sicurezza e sessioni

- **Stesse rotte, stessi codici HTTP, stessi codici d'errore e messaggi.** Il confronto automatico con l'API originale avviata in parallelo (`tools/parity/compare.mjs`) dà 64 risposte identiche su 66. Le 2 differenze sono spiegate in MATRICE_PARITA_FUNZIONALE.md.
- **Comportamenti JavaScript riprodotti dove contano:** la stringa `"0"` è "vera" (`Recipes::t()`); le regole `refine` di zod vengono saltate se il campo ha già errori; un numero non valido dà "Invalid input".
- **Sessioni:** tabella `sessions` propria, come l'originale, al posto della sessione standard di Laravel.
  - La tabella contiene solo l'hash SHA-256 del token e l'azienda attiva.
  - Il cookie `fc_session` è httpOnly, SameSite=Lax e Secure in produzione, ed è escluso dalla cifratura dei cookie di Laravel.
  - `last_seen_at` viene aggiornato al massimo ogni 5 minuti.
- **CSRF:** come nell'originale, le richieste che modificano dati devono avere l'header `X-Requested-With: foodcost` e, se il browser la indica, un'origine ammessa (`ALLOWED_ORIGINS`). Il client `lib/api.ts` non è cambiato.
- **Tenancy:** ogni query filtra per `company_id` dell'azienda attiva. Un ID di un'altra azienda risponde 404.
- **Retribuzioni:** senza il permesso `salaries.read` i campi non sono nel payload. L'audit elimina gli importi, compresa la voce extra.
- **Intestazioni di sicurezza:** sulle risposte PHP le imposta il middleware `SecurityHeaders`. Sui file statici le imposta `public/.htaccess`, una sola volta.

## 4. Database (PostgreSQL → MySQL 8)

Unica migrazione: `database/migrations/2026_11_21_000001_create_foodcost_schema.php`. Contiene le 25 tabelle dell'originale, più `comparison_groups` e `comparison_group_items` (confronti del superadmin) e le tabelle `cache`/`cache_locks` di Laravel.

| Aspetto | Soluzione |
|---|---|
| UUID | `CHAR(36)` generati dall'applicazione |
| Istanti | `DATETIME(3)` in UTC, restituiti come ISO `…Z` |
| JSON | colonne `JSON`. MySQL le normalizza (`{"a": 1}` con lo spazio): i filtri usano `JSON_EXTRACT`, mai il testo |
| Codici ed email unici senza distinzione di maiuscole | collation `utf8mb4_0900_as_ci` (come `lower(code)` dell'originale; distingue gli accenti) |
| CHECK | aggiunti con `ALTER TABLE`; richiedono MySQL ≥ 8.0.16 |
| `LATERAL JOIN` (prezzo valido a una data) | `Costing::latestAt` |
| `NULLS FIRST/LAST` | ordinamento con `col IS NULL` |
| `ILIKE` | `LOWER(col) LIKE ?` con collation sensibile agli accenti |
| `REPEATABLE READ` sugli snapshot | impostato solo fuori da transazioni aperte |

## 5. Lavori in coda senza worker

L'originale ha un processo sempre attivo che esegue validazione, applicazione e pulizia delle importazioni. Sull'hosting condiviso non esiste. Gli stessi lavori, nella tabella `jobs`, vengono eseguiti in tre modi:

1. **Dopo la risposta:** se c'è `fastcgi_finish_request` (PHP-FPM), la richiesta che li crea li esegue dopo aver risposto.
2. **Con il polling dell'interfaccia:** ogni `GET /api/imports/:id` mentre l'importazione è in corso fa avanzare il lavoro per un tempo limitato (`JOB_SLICE_SECONDS` × 5).
3. **Con il cron dell'hosting:** `GET /api/cron?k=<CRON_KEY>` esegue i lavori in attesa e pulisce sessioni scadute e importazioni oltre i 30 giorni.

Ogni lavoro viene preso in carico una sola volta tramite un aggiornamento condizionale. Un lavoro bloccato da più di 10 minuti viene ripreso.

L'applicazione di un'importazione resta **atomica** (tutto o niente, come l'originale), quindi non viene spezzata. Per stare nei limiti di tempo dell'hosting:
- simula in memoria, riga per riga, le stesse verifiche dell'originale: codici generati, conflitti, modifiche dopo l'anteprima, prezzi con la stessa data;
- poi scrive a blocchi.

Su questa macchina 20.000 ingredienti con prezzo si applicano in circa 3 secondi; 20.000 aggiornamenti in circa 7 secondi.

## 6. Interfaccia

`resources/frontend/app`, `components` e `lib` sono **copie delle cartelle dell'originale**. Si compilano con Vite in `public/app` e vengono servite dalla rotta di fallback di Laravel (`routes/web.php`), così i link diretti come `/ricette/<id>` funzionano.

- **Sostituzioni senza toccare le pagine:** `next/link` e `next/navigation` sono implementati su React Router in `resources/frontend/shims/`. `useRouter().push/replace` non restituiscono nulla, come in Next: le pagine li usano anche dentro `useEffect`.
- **Rotte:** si ricavano automaticamente dall'albero `app/` (gruppi `(auth)` e `(app)`, segmenti `[id]`).
- **Caricamento:** tutte le pagine si caricano subito, come il prefetch di Next, quindi non ci sono stati intermedi durante la navigazione.
- **Fedeltà visiva:** 18 schermate confrontate pixel per pixel con l'originale avviato in parallelo. Le uniche differenze sono gli orari di creazione dei dati e il badge di sviluppo di Next.
- **Modifiche alle pagine originali**, tutte marcate `NUOVO`:
  - campo "Agente" nel prezzo;
  - "Voce extra mensile" nel costo del dipendente;
  - sezione "Piattaforma" del menu e indicatore "Assistenza" (solo per il superadmin).

## 7. Livello SaaS (novità)

- **Superadmin:** `users.is_platform_admin`. Crea le aziende (tenant) e invita il loro amministratore, senza diventarne membro.
- **Console `/piattaforma`:**
  - aziende;
  - tutte le ricette con i costi correnti;
  - tutti i prodotti e i fornitori;
  - statistiche dei prezzi pagati per prodotto, fornitore, agente o azienda (minimo, massimo, media, mediana, scarto);
  - confronti tra ricette scelte a mano, con costo per kg e per porzione, ripartizione ingredienti/energia/manodopera e ingredienti.
- **Sola lettura:** la console non modifica i dati dei ristoratori. Per aiutare un cliente, il superadmin usa "Assisti": entra nell'azienda come amministratore, e ogni accesso viene registrato nell'audit (`assist_started`).
- **Doppioni tra aziende** (stesso nome e fornitore): vengono solo segnalati ("in N aziende"). Come da decisione, nessuna unificazione automatica.

## 8. Hosting condiviso

- **Instradamento:** `.htaccess` nella radice manda tutto in `public/` e nega file nascosti e file di progetto. Sull'hosting la cartella del dominio è la radice web.
- **Pubblicazione:** GitHub Actions esegue i test, compila, genera `.env` dai secrets, carica via FTPS e chiama `POST /api/system/deploy` (migrazioni e cache di configurazione, protetto da `DEPLOY_KEY`). Dettagli in DEPLOYMENT.md.
- **Primo superadmin senza SSH:** `POST /api/system/first-admin` (protetto da `DEPLOY_KEY`, solo finché non esiste alcun superadmin) restituisce un link monouso per impostare la password.
