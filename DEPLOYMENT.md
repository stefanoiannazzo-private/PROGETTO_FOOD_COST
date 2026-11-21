# Pubblicazione su Aruba (hosting Linux condiviso)

Stesso schema di ACAT: **push su `main` → GitHub Actions → test → FTPS verso Aruba**. In più, un passo finale esegue le migrazioni del database.
Finché i secrets FTP non sono impostati, il workflow esegue soltanto i test e non pubblica nulla.

> Nulla di questa procedura è stato ancora eseguito su un server reale: richiede il repository GitHub e le credenziali, entrambi in attesa della tua autorizzazione. L'intera sequenza (Apache con `.htaccess`, migrazioni via `/api/system/deploy`, cron via URL, configurazione in cache) è stata provata in un contenitore Apache + PHP 8.3 + MySQL 8.0 con la stessa struttura di cartelle dell'hosting.

## 1. Sul pannello Aruba

1. **PHP:** per il dominio scegli **PHP 8.3 o superiore**. Servono le estensioni `pdo_mysql`, `mbstring`, `zip`, `xmlreader` e, consigliata, `intl`.
2. **Database:** crea un database **MySQL 8**. Prendi nota di host, nome, utente e password.
   Serve MySQL ≥ 8.0.16 (vincoli CHECK). MariaDB non è supportato.
3. **HTTPS:** attiva il certificato SSL del dominio. Il cookie di sessione in produzione viaggia solo su HTTPS, e il `.htaccess` reindirizza da HTTP a HTTPS.
4. **FTP:** prendi nota di server, utente e password, e della cartella del sito (per esempio `/www.tuodominio.it/`).

## 2. Secrets e variabili su GitHub

In *Settings → Secrets and variables → Actions*.

**Secrets:**

| Nome | Valore |
|---|---|
| `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD` | accesso FTP |
| `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS` | database Aruba |
| `APP_KEY` | chiave dell'applicazione (vedi sotto) |
| `CRON_KEY` | stringa casuale di almeno 24 caratteri |
| `DEPLOY_KEY` | un'altra stringa casuale di almeno 24 caratteri |
| `SMTP_USER`, `SMTP_PASS` | facoltativi: casella del dominio che invia inviti e recupero password (`smtps.aruba.it`, porta 465). Senza di essi il link di invito viene mostrato all'amministratore, che lo inoltra |

**Variabili:**

| Nome | Valore |
|---|---|
| `APP_URL` | **obbligatoria**, per esempio `https://foodcost.tuodominio.it` |
| `FTP_DIR` | cartella del sito sul server (predefinita `/`) |
| `FTP_PROTOCOL` | `ftps` (predefinito) oppure `ftp` |
| `SMTP_HOST` | predefinito `smtps.aruba.it` |

Per generare i valori in locale (PowerShell, con l'ambiente Docker avviato):

```powershell
docker compose exec app php artisan key:generate --show        # → APP_KEY (base64:...)
docker compose exec app php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"   # → CRON_KEY, poi di nuovo → DEPLOY_KEY
```

Il file `.env` di produzione è **creato dal workflow** a ogni pubblicazione, con queste impostazioni:
- `APP_ENV=production`, `APP_DEBUG=false`;
- `COOKIE_SECURE=true`;
- `ALLOWED_ORIGINS=APP_URL`;
- link di sviluppo disattivati.

Non va caricato né modificato a mano.

## 3. Prima pubblicazione

1. Esegui un push su `main`, oppure *Actions → Verifica e pubblica → Run workflow*.
2. Il workflow esegue, nell'ordine:
   - test PHP (MySQL di prova) e controllo dei tipi dell'interfaccia;
   - `composer install --no-dev`;
   - compilazione Vite;
   - generazione di `.env`;
   - upload FTPS, solo dei file modificati;
   - `POST /api/system/deploy`, che crea le cartelle di lavoro, esegue le migrazioni e mette in cache la configurazione;
   - controllo di `/api/health`.
3. **Primo superadmin.** Scegli **uno** dei due modi.
   - **Con SSH:**
     ```bash
     cd <cartella del sito>
     php artisan foodcost:create-admin --email=tu@tuodominio.it --name="Nome Cognome"
     ```
   - **Senza SSH:** chiama una sola volta (PowerShell):
     ```powershell
     Invoke-RestMethod -Method Post -Uri "https://foodcost.tuodominio.it/api/system/first-admin" `
       -Headers @{ "X-Requested-With"="foodcost"; "X-Deploy-Key"="<DEPLOY_KEY>" } `
       -ContentType "application/json" -Body '{"email":"tu@tuodominio.it","name":"Nome Cognome"}'
     ```
     La risposta contiene `setPasswordLink`: aprilo entro 60 minuti e scegli la password. Dopo il primo superadmin l'indirizzo non funziona più.
4. **Primo cliente.** Accedi, vai in *Piattaforma → Aziende → Nuova azienda* e indica il nome dell'azienda e l'email del suo amministratore. L'invito parte per email se SMTP è configurato; altrimenti copia il link mostrato e inoltralo.

## 4. Cron

Nel pannello Aruba (*Cron job*), oppure con `crontab -e` via SSH, chiama ogni 5 minuti:

```
*/5 * * * *  curl -fsS "https://foodcost.tuodominio.it/api/cron?k=<CRON_KEY>" > /dev/null
```

Il cron completa le importazioni rimaste a metà e pulisce sessioni scadute e file di importazione più vecchi di 30 giorni. L'app funziona anche senza cron, perché le importazioni avanzano mentre la pagina è aperta, ma con il cron la pulizia è regolare.

## 5. Verifiche dopo la pubblicazione

| Indirizzo | Atteso |
|---|---|
| `https://…/api/health` | `{"ok":true}` |
| `https://…/` | pagina di accesso |
| `https://…/.env`, `/composer.json`, `/.git/config` | **403** |
| `https://…/vendor/autoload.php`, `/app/…`, `/artisan` | pagina dell'app (nessun codice servito) |
| `http://…/` | reindirizzamento a `https://` |

## 6. Aggiornamenti, ritorno indietro, backup

- **Aggiornare:** basta un push su `main`. Vengono caricati solo i file cambiati; le migrazioni nuove partono da sole.
- **Tornare indietro:** `git revert` del commit e push. Le migrazioni vanno solo in avanti: prima di pubblicare una modifica allo schema fai un backup del database.
- **Backup:** usa i backup del database dal pannello Aruba, oppure un'esportazione con phpMyAdmin. I file caricati per le importazioni sono temporanei (30 giorni) e non serve salvarli.

## 7. Problemi frequenti

| Sintomo | Causa probabile |
|---|---|
| Errore 500 subito | versione PHP < 8.3, oppure manca un'estensione. Controlla `storage/logs/laravel-AAAA-MM-GG.log` via FTP |
| Il passo "Migrazioni" fallisce con un errore sui vincoli CHECK | MySQL più vecchio di 8.0.16, oppure MariaDB |
| Non si resta collegati | il sito non è in HTTPS (cookie Secure), oppure `APP_URL` è diverso dall'indirizzo usato |
| 403 "Origine della richiesta non ammessa" | si usa un indirizzo diverso da `APP_URL` (per esempio con e senza `www`): usa sempre lo stesso |
| Importazioni ferme a "in corso" | si sbloccano riaprendo la pagina dell'importazione o con il cron (§4) |
| Gli inviti non arrivano | SMTP non configurato: il link è mostrato all'amministratore, che lo inoltra |
