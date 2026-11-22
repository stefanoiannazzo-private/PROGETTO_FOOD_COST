# Food Cost (Laravel)

Calcolo del costo di produzione di ricette e preparazioni: ingredienti, energia e manodopera.
Clone funzionale di `PROGETTO_FOOD_COST` (Fastify + Next.js + PostgreSQL), riscritto con **Laravel 13 + MySQL 8**
per l'**hosting condiviso** (Aruba Linux), con la stessa interfaccia compilata con **Vite + React**.
In più rispetto all'originale ha un livello **SaaS**: un superadmin crea le aziende clienti, consulta ricette e
prodotti di tutti e confronta ricette e prezzi. Ogni amministratore ha inoltre il **coefficiente di redditività**:
quanti piatti di un certo tipo deve vendere a settimana per coprire i costi fissi.

| Documento | Contenuto |
|---|---|
| [ANALISI_ORIGINALE.md](ANALISI_ORIGINALE.md) | analisi del progetto originale (funzionalità, formule, database, criticità) |
| [ARCHITETTURA.md](ARCHITETTURA.md) | come è fatto il clone e perché |
| [MATRICE_PARITA_FUNZIONALE.md](MATRICE_PARITA_FUNZIONALE.md) | ogni funzionalità dell'originale: stato, prova, differenze |
| [TASKS.md](TASKS.md) | attività svolte e aperte |
| [DEPLOYMENT.md](DEPLOYMENT.md) | pubblicazione su Aruba tramite GitHub |

## Requisiti

- **Produzione:** PHP ≥ 8.3 (estensioni `pdo_mysql`, `mbstring`, `zip`, `xmlreader`; `intl` consigliata), MySQL ≥ 8.0.16, Apache con `.htaccess` e `mod_rewrite`.
  Nessun processo permanente: niente worker, Octane o WebSocket.
- **Sviluppo:** Docker Desktop (Windows, macOS o Linux), oppure PHP 8.3 + Composer + MySQL 8 + Node 22.

## Avvio rapido con Docker (Windows)

```powershell
git clone <indirizzo-del-repository> food-cost
cd food-cost
docker compose up -d --build
```

Poi apri **http://localhost:8080**. Al primo avvio vengono eseguite queste operazioni:

- installazione delle librerie PHP;
- compilazione dell'interfaccia;
- creazione del database;
- caricamento dei dati dimostrativi.

L'ambiente riproduce l'hosting: Apache, PHP 8.3, MySQL 8.0, sito servito dalla cartella del progetto tramite `.htaccess`.

| Account dimostrativo | Ruolo |
|---|---|
| `admin@demo.local` | superadmin della piattaforma e amministratore di "Trattoria Demo" |
| `responsabile@demo.local` | responsabile (vede i costi aggregati, non le retribuzioni) |
| `operatore@demo.local` | operatore (consulta le ricette, nessun costo) |
| `admin@osteria.local` | amministratore di "Osteria Demo" (secondo cliente, utile per i confronti) |

La password è `Demo-locale-2026`, oppure il valore della variabile `DEMO_PASSWORD`. Vale **solo in locale**.

Per l'interfaccia con ricarica automatica durante lo sviluppo:

```powershell
docker compose --profile dev up -d
```

Poi apri http://localhost:5173.

## Avvio senza Docker

```bash
composer install
cp .env.example .env            # imposta DB_* e ALLOWED_ORIGINS
php artisan key:generate
php artisan migrate
php artisan foodcost:seed-demo --password=Una-password-locale
cd resources/frontend && npm ci && npm run build && cd ../..
php artisan serve               # http://localhost:8000
```

## Comandi

| Comando | A cosa serve |
|---|---|
| `php artisan foodcost:create-admin --email=… --name=… [--company=…]` | crea un superadmin (la password viene chiesta, oppure letta da `ADMIN_PASSWORD`) |
| `php artisan foodcost:create-admin --email=… --reset-password` | reimposta la password di un utente |
| `php artisan foodcost:seed-demo [--password=…]` | carica i dati dimostrativi, solo in locale |
| `vendor/bin/phpunit` | tutti i test (serve il database MySQL `foodcost_test`) |
| `cd resources/frontend && npm run build` | compila l'interfaccia in `public/app` |
| `cd resources/frontend && npm run e2e` | test end-to-end nel browser (servono Chrome e l'app avviata) |

## Test

`vendor/bin/phpunit` esegue **369 test**, divisi in tre gruppi.

**Dominio:**
- tutti i test dell'originale;
- la **parità numerica cifra per cifra** con il motore TypeScript originale, su 1.055 ricette, 625 operazioni decimali, 66 numeri in formato italiano e 120 grafi.

**API:** tutti i test dell'originale, cioè autenticazione, isolamento tra aziende, percorso ragù → lasagna, importazioni e velocità.

**Funzioni nuove:**
- console superadmin;
- coefficiente di redditività;
- agente sui prezzi;
- voce extra della retribuzione;
- cron e deploy.

Altre verifiche, descritte in [MATRICE_PARITA_FUNZIONALE.md](MATRICE_PARITA_FUNZIONALE.md):
- confronto automatico delle risposte con l'API originale (`tools/parity/compare.mjs`);
- confronto delle schermate (`tools/parity/screens.mjs`);
- test nel browser (`resources/frontend/e2e/`).

## Struttura

```
app/Domain/Costing/     motore di calcolo (port 1:1 del pacchetto domain originale)
app/Http/Controllers/   API (stesse rotte, stessi formati e messaggi dell'originale) + console di piattaforma
app/Services/           sessioni, costi e cache, ricette, importazioni, lavori in coda, audit, email
app/Support/Validation/ validazione equivalente a zod (messaggi italiani identici)
database/migrations/    schema MySQL (25 tabelle dell'originale + 2 per i confronti)
resources/frontend/     interfaccia originale (cartelle app/, components/, lib/) compilata con Vite
tests/                  PHPUnit: dominio, parità golden, API, novità
tools/                  generatore dei casi golden, confronti con l'originale
docker/, docker-compose.yml   ambiente locale
.github/workflows/      verifica e pubblicazione su Aruba (FTPS)
```

## Sicurezza

- Nessuna credenziale nel repository: `.env` è escluso. In produzione `.env` viene generato dai secrets di GitHub a ogni pubblicazione.
- Le password sono conservate come hash; i token di sessione, invito e reset come SHA-256.
- Cookie `fc_session` httpOnly, SameSite=Lax e Secure in produzione.
- Protezione CSRF: header dell'app più controllo dell'origine. Limite di frequenza sui login.
- Isolamento tra aziende in ogni query: un ID di un'altra azienda risponde 404.
- Le retribuzioni non compaiono mai nel payload di chi non ha il permesso, né nei log.
- Sull'hosting il `.htaccess` di radice instrada tutto in `public/`: codice, `.env`, `storage/` e `vendor/` non sono raggiungibili dal web (verificato).
