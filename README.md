# Food Cost

Applicazione web di COMETOWEB per ristoranti, gastronomie, macellerie, pasticcerie e laboratori alimentari. Calcola il **costo di produzione** delle preparazioni, cioè ingredienti, energia e manodopera, per lotto, per porzione e per chilogrammo. Gestisce ricette annidate (il ragù dentro la lasagna), lo storico di prezzi, tariffe e costi del lavoro, gli snapshot immutabili e le importazioni da Excel/CSV.

| Documento | Contenuto |
|---|---|
| [`docs/PIANO.md`](docs/PIANO.md) | architettura, decisioni, assunzioni, limiti |
| [`docs/MODELLO_DATI.md`](docs/MODELLO_DATI.md) | tabelle, vincoli, revisioni e snapshot |
| [`docs/FORMULE.md`](docs/FORMULE.md) | formule di calcolo e regole sui dati mancanti |
| [`docs/API.md`](docs/API.md) | endpoint principali |
| [`docs/VERIFICHE.md`](docs/VERIFICHE.md) | test, build e misure realmente eseguiti, con esiti |
| [`templates/`](templates) | modelli CSV e XLSX per le importazioni |

## Stack

- **Linguaggio:** TypeScript su tutto il progetto.
- **API:** Fastify, con il motore di calcolo in un pacchetto di dominio separato (`packages/domain`).
- **Database:** PostgreSQL. In sviluppo può girare in-process (PGlite), senza installare un server.
- **Frontend:** Next.js 16 + React 19 + TanStack Query, usato come applicazione a pagina singola per avere cambi pagina istantanei.

Lo stack di riferimento del capitolato (Laravel + MySQL) è stato sostituito su decisione del cliente. Il motivo è che l'ambiente di sviluppo non poteva scaricare i pacchetti PHP da Packagist; i dettagli sono in `docs/PIANO.md`.

## Requisiti

- Node.js 22 o superiore, con npm 10
- Per la produzione: PostgreSQL 15 o superiore (file `docker-compose.yml` incluso per lo sviluppo con un server vero)

## Avvio in locale

Dalla cartella principale del repository:

```bash
npm install

# 1. configurazione dell'API (nessuna credenziale reale nel repository)
cp apps/api/.env.example apps/api/.env
#    di default usa PostgreSQL in-process su file: DATABASE_URL=pglite:./.data/dev
#    per un server: docker compose up -d   e   DATABASE_URL=postgres://foodcost:foodcost@localhost:5432/foodcost

# 2. database e dati dimostrativi (solo locale: ragù, besciamella, lasagna, utenti demo)
npm run migrate
npm run seed:demo -- --password "scegli-una-password-locale"

# 3. API su http://127.0.0.1:4000 (con PGlite il worker delle importazioni gira nello stesso processo)
npm run dev:api

# 4. in un altro terminale: interfaccia su http://localhost:3000
npm run dev:web
```

Accessi demo creati dal seed, tutti con la password scelta al punto 2: `admin@demo.local` (amministratore), `responsabile@demo.local` (responsabile), `operatore@demo.local` (operatore). Il seed si rifiuta di partire con `NODE_ENV=production`.

### Produzione (senza deploy automatico)

```bash
npm run build                               # build dell'interfaccia
# API: DATABASE_URL=postgres://…  COOKIE_SECURE=true  WORKER_INLINE=false
npm run start -w apps/api                   # API
npm run worker                              # worker importazioni, processo separato
npm run start -w apps/web                   # interfaccia (API_URL indica dove raggiungere l'API)
```

L'interfaccia inoltra `/api/*` all'API (stessa origine: cookie di sessione semplici, nessun CORS). Dietro HTTPS impostare `COOKIE_SECURE=true` e `ALLOWED_ORIGINS` con il dominio pubblico.

## Comandi di verifica

```bash
npm test                 # motore di calcolo + API (PostgreSQL reale in-process)
npm run typecheck        # controllo dei tipi di dominio, API e web
npm run build            # build di produzione dell'interfaccia
npm run e2e -w apps/web  # flusso UI in Chrome headless (API e web avviati, seed caricato)
                         # variabili: CHROME_PATH, DEMO_PASSWORD, BASE_URL
```

## Percorso di verifica manuale

1. **Ingredienti**: in *Ingredienti* controlla carne, pomodori, verdure (con resa edibile) e olio (con densità). Oppure importa `templates/modello-ingredienti.xlsx` da *Importazioni*.
2. **Ragù**: apri *Ricette → Ragù alla bolognese*. Vedrai resa 5 kg, costo del lotto, costo al kg e il dettaglio di ingredienti, gas, abbattitore e manodopera.
3. **Lasagna**: *Lasagna alla bolognese* usa 1.400 g di ragù e 900 g di besciamella. La riga del ragù vale solo la quota prelevata, e con la freccia se ne vede la composizione, che non viene ricontata.
4. **Costo/kg e porzione**: il pannello *Costi* mostra lotto, €/kg (3,6 kg) e €/porzione (12 porzioni).
5. **Modifica prezzo**: in *Ingredienti → Carne macinata mista* aggiungi un nuovo prezzo con data di oggi. L'avviso elenca le ricette interessate, ragù e lasagna, quest'ultima indirettamente.
6. **Nuova valorizzazione**: riapri la lasagna. Il costo è aggiornato e il riquadro *Rispetto all'ultimo snapshot* mostra la differenza e il motivo (costo del semilavorato Ragù).
7. **Snapshot**: lo snapshot “Listino autunno 2026” resta invariato. Con il selettore di data nel pannello *Costi* puoi valorizzare la ricetta a una data passata.

## Struttura

```
packages/domain   motore di calcolo puro: unità, energia, lavoro, ricette annidate, cicli, formati italiani
apps/api          API Fastify: autenticazione, multi-azienda, anagrafiche, ricette, snapshot, importazioni, worker
apps/web          interfaccia Next.js
docs/             documentazione tecnica
templates/        modelli di importazione
```
