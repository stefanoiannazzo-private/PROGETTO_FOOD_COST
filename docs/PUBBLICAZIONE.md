# Pubblicare Food Cost su un dominio

Guida per mettere l’applicazione online su un server Linux con Docker. Con il file `deploy/docker-compose.yml` vengono avviati insieme:

| Servizio | Cosa fa |
|---|---|
| `caddy` | riceve il traffico del dominio e gestisce da solo il certificato HTTPS (Let’s Encrypt, gratuito, rinnovo automatico) |
| `web` | interfaccia |
| `api` | API; all’avvio aggiorna lo schema del database |
| `worker` | esegue le importazioni in background |
| `db` | PostgreSQL 17, non esposto su internet |
| `backup` | copia del database ogni 24 ore in `deploy/backups/` (tiene le ultime 14) |

Tempo stimato: circa un’ora la prima volta.

## 1. Cosa procurarsi

1. **Un server VPS Linux**, per esempio da Hetzner, OVH, Aruba Cloud o simili.
   - Sistema: **Ubuntu 24.04 LTS**.
   - Taglio: 2 vCPU, **4 GB di RAM**, 40 GB di disco. Con 2 GB funziona, ma la prima costruzione delle immagini è lenta.
   - Il fornitore ti dà un **indirizzo IP** (es. `203.0.113.10`) e l’accesso SSH come `root`.
2. **Il dominio**, per esempio `foodcost.it`, oppure un sottodominio di un dominio che avete già, come `foodcost.cometoweb.it`.
3. Facoltativo ma consigliato: **una casella SMTP** per inviti e recupero password (host, porta, utente, password). Va bene quella del vostro provider di posta.

> L’hosting condiviso tradizionale (quello per WordPress/PHP) non va bene: serve un server dove si possa installare Docker.

## 2. Collegare il dominio al server

Nel pannello del registrar del dominio, sezione **DNS**, crea:

| Tipo | Nome | Valore |
|---|---|---|
| A | `@`, oppure il sottodominio (es. `foodcost`) | l’IP del server |
| A | `www` (facoltativo) | l’IP del server |

La propagazione richiede da pochi minuti a qualche ora. Per verificare, da un terminale del tuo PC: `ping foodcost.esempio.it` deve rispondere con l’IP del server.

## 3. Entrare nel server

Da Windows apri **PowerShell** e scrivi (con l’IP del tuo server):

```
ssh root@203.0.113.10
```

Alla prima connessione rispondi `yes` e inserisci la password ricevuta dal fornitore. Tutti i comandi seguenti si scrivono **nella finestra collegata al server**.

## 4. Preparare il server (una sola volta)

```bash
# aggiornamenti di sistema
apt update && apt upgrade -y

# Docker (script ufficiale)
curl -fsSL https://get.docker.com | sh

# firewall: solo SSH, HTTP e HTTPS
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
```

## 5. Scaricare il codice

Con il repository **privato**, GitHub richiede un token:

1. Su GitHub: foto profilo → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Accesso solo al repository `PROGETTO_FOOD_COST`, permesso **Contents: Read-only**, scadenza a scelta.
3. Copia il token e sul server esegui:

```bash
git clone https://github.com/stefanoiannazzo-private/PROGETTO_FOOD_COST.git /opt/foodcost
```

Come nome utente indica il tuo utente GitHub, come password il token.

## 6. Configurare

```bash
cd /opt/foodcost/deploy
cp .env.example .env
openssl rand -base64 32 | tr -d '/+='     # copia il risultato: sarà la password del database
nano .env
```

Compila almeno:

```
DOMAIN=foodcost.esempio.it
ACME_EMAIL=tua-email@esempio.it
POSTGRES_PASSWORD=la-password-generata-sopra
```

Se hai l’SMTP, compila anche `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` e `MAIL_FROM`. Per salvare in nano: `Ctrl+O`, Invio, poi `Ctrl+X` per uscire.

## 7. Avviare

```bash
cd /opt/foodcost/deploy
docker compose up -d --build
```

La prima volta servono alcuni minuti per costruire le immagini. Controlla lo stato con:

```bash
docker compose ps
```

Quando `api` risulta `healthy`, apri **https://il-tuo-dominio** nel browser. Il certificato viene emesso al primo accesso e può richiedere qualche secondo.

## 8. Creare il primo amministratore

```bash
docker compose exec api node --import tsx src/db/create-admin.ts \
  --email tua-email@esempio.it --name "Nome Cognome" --company "Nome dell'azienda cliente"
```

La password viene chiesta due volte e non compare a schermo. Poi accedi al sito con quell’email: da **Utenti** inviti gli altri, da **Impostazioni** crei altre aziende clienti.

Per reimpostare la password di un utente:

```bash
docker compose exec api node --import tsx src/db/create-admin.ts --email utente@esempio.it --reset-password
```

> I dati dimostrativi (`seed:demo`) sono solo per il PC locale: in produzione il comando si rifiuta di partire.

## 9. Aggiornare a una nuova versione

```bash
cd /opt/foodcost && git pull
cd deploy && docker compose up -d --build
```

Le modifiche al database si applicano da sole all’avvio dell’API. I dati restano nei volumi Docker.

## 10. Copie di sicurezza

- Le copie automatiche sono in `/opt/foodcost/deploy/backups/` (una al giorno, ultime 14).
- **Scaricale regolarmente anche fuori dal server**, per esempio dal tuo PC: `scp root@203.0.113.10:/opt/foodcost/deploy/backups/*.dump .`
- Copia manuale immediata:
  ```bash
  docker compose exec -T db pg_dump -U foodcost -d foodcost -Fc > backups/manuale-$(date +%F).dump
  ```
- Ripristino (sostituisce i dati attuali):
  ```bash
  docker compose stop api worker
  docker compose exec -T db pg_restore -U foodcost -d foodcost --clean --if-exists < backups/NOME-FILE.dump
  docker compose start api worker
  ```

I file caricati per le importazioni stanno nel volume `storage` e vengono eliminati comunque dopo 30 giorni: non serve salvarli.

## 11. Controlli e problemi comuni

| Comando | A cosa serve |
|---|---|
| `docker compose ps` | stato dei servizi |
| `docker compose logs -f api` | log dell’API (anche `web`, `worker`, `caddy`) |
| `docker compose restart api` | riavvio di un servizio |

- **Il sito non si apre / certificato non valido**: il DNS non punta ancora al server oppure le porte 80/443 sono chiuse. Controlla `docker compose logs caddy`.
- **L’API non parte e i log dicono “Configurazione di produzione non valida”**: manca o è errato un valore nel file `.env`. Il messaggio indica quale.
- **Gli inviti non arrivano per email**: senza SMTP è normale. L’amministratore vede il link d’invito nel pannello e lo consegna a mano. Con l’SMTP configurato, controlla `docker compose logs api | grep email`.

## Sicurezza: cosa è già impostato

- HTTPS obbligatorio con HSTS; cookie di sessione `Secure`, `HttpOnly`, `SameSite=Lax`.
- L’API rifiuta di partire con impostazioni insicure (database locale, cookie non sicuri, dominio non https).
- Database e API non esposti su internet: passa tutto da Caddy.
- Protezione CSRF, limiti di tentativi sul login, password con scrypt, token salvati solo come hash.
- Il file `.env` con le password resta sul server e non va mai su GitHub.
