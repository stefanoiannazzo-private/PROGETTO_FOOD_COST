# API principali

Base: `/api`. JSON in ingresso e uscita. Numeri normalizzati come stringhe con il punto (`"1234.56"`): l’API rifiuta i separatori delle migliaia (il formato italiano è gestito da interfaccia e importazioni). Date `aaaa-mm-gg`.

**Sicurezza**: cookie di sessione `fc_session` (httpOnly, SameSite=Lax). Ogni richiesta che modifica dati deve avere l’header `X-Requested-With: foodcost` e un’origine ammessa (CSRF). L’azienda è quella attiva nella sessione: un ID di un’altra azienda risponde 404. Errori: `{ error: { code, message, details } }`, con `details.fields` per gli errori di validazione campo per campo.

## Autenticazione e utenti

| Metodo | Percorso | Note |
|---|---|---|
| POST | `/auth/login` | limitato per IP; seleziona l’azienda se l’utente ne ha una sola |
| POST | `/auth/logout` | |
| GET | `/auth/me` | utente, azienda attiva, ruolo, permessi, aziende disponibili |
| POST | `/auth/company` | selezione esplicita dell’azienda attiva (verificata) |
| POST | `/auth/password/forgot` · `/auth/password/reset` · `/auth/password/change` | |
| GET/POST | `/auth/invitations/:token` · `/auth/invitations/accept` | |
| GET | `/users` · `/users/catalog` | `users.manage` |
| POST/DELETE | `/users/invitations` · `/users/invitations/:id` | |
| PATCH | `/users/:membershipId` | ruolo, permessi aggiuntivi, disattivazione; protezione dell’ultimo amministratore |
| POST | `/companies` | solo amministratore di piattaforma |

## Anagrafiche

| Metodo | Percorso | Note |
|---|---|---|
| GET | `/ingredients?q&category&price=missing\|zero&archived&sort&dir&page&pageSize&date` | prezzi solo con `costs.read` |
| GET/POST/PATCH | `/ingredients/:id` · `/ingredients` | PATCH con `lockVersion` |
| POST/DELETE | `/ingredients/:id/prices` · `/ingredients/:id/prices/:priceId` | risponde con `affectedRecipes` (anche indirette) |
| POST/DELETE | `/ingredients/:id/archive` · `/restore` · `/ingredients/:id` | eliminazione solo se mai usato |
| GET/POST/PATCH | `/tariffs` · `/tariffs/:id` | `tariffs.read` / `tariffs.manage` |
| POST | `/tariffs/:id/versions` | `mode: direct` o `mode: bill` (voci variabili/fisse, consumo) |
| POST | `/tariffs/bill-preview` | calcolo della tariffa media senza salvare |
| GET/POST/PATCH | `/equipment` · `/equipment/:id` | risponde con `warnings` di completezza |
| GET/POST/PATCH | `/employees` · `/employees/:id` | retribuzioni solo con `salaries.read` |
| POST/DELETE | `/employees/:id/costs` · `/employees/:id/costs/:configId` | `employees.manage` + `salaries.read` |
| POST | `/employees/cost-preview` | costi orari calcolati |

## Ricette e costi

| Metodo | Percorso | Note |
|---|---|---|
| GET | `/recipes?q&status&category&completeness&sort&dir&page` | con costi correnti in cache |
| GET | `/recipes/options?q&exclude` | semilavorati selezionabili (esclude cicli) |
| GET | `/recipes/:id?date=` | revisione corrente, valorizzazione, confronto con l’ultimo snapshot, snapshot, “usata in” |
| POST | `/recipes/preview` | valorizzazione autorevole di una composizione non salvata |
| POST | `/recipes` · PUT `/recipes/:id` | ogni salvataggio crea una revisione; PUT con `lockVersion`; 409 `cycle` con `details.path` |
| POST | `/recipes/:id/duplicate` · `/archive` · `/restore` · `/activate` | |
| GET | `/recipes/:id/valuation?date=` | valorizzazione a una data |
| GET | `/recipes/:id/revisions` · `/recipes/:id/revisions/:revisionId` | |
| POST | `/recipes/:id/snapshots` | `{ expectedRevisionId, label?, date? }` |
| GET | `/snapshots/:id` | |
| GET | `/dashboard` | conteggi, valorizzazioni incomplete, ultimi prezzi |

Senza `costs.read` le valorizzazioni sono `null`; senza `salaries.read` le righe di manodopera non hanno costo né costo al minuto (resta il subtotale aggregato).

## Importazioni

| Metodo | Percorso | Note |
|---|---|---|
| GET | `/imports/templates/{ingredients\|employees}.{csv\|xlsx}` | modelli con istruzioni |
| GET | `/imports/fields/:type` | campi e limiti |
| POST | `/imports` | multipart `type` + `file`; risposta con separatore, codifica, fogli, intestazioni, anteprima e abbinamento proposto |
| POST | `/imports/:id/preview` | anteprima con altre opzioni |
| POST | `/imports/:id/validate` | `{ options, mapping }` → validazione asincrona |
| GET | `/imports/:id` · `/imports/:id/rows?action=` | stato, avanzamento, riepilogo, righe normalizzate |
| POST | `/imports/:id/confirm` | `{ lockVersion }`; idempotente |
| POST | `/imports/:id/cancel` | |
| GET | `/imports/:id/report.csv?only=errors\|all` | report protetto da formula injection |
