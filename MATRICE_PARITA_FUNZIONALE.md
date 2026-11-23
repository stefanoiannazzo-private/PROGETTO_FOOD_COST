# Matrice di parità funzionale

Confronto tra l'originale (`PROGETTO_FOOD_COST`, commit `d17db7c`) e il clone Laravel. Una funzionalità è indicata come equivalente solo se c'è almeno una prova automatica.

## Prove usate

| Sigla | Prova | Risultato |
|---|---|---|
| **G** | `tests/Unit/Domain/GoldenParityTest.php`: casi generati eseguendo il **codice originale** (`tools/golden/generate.ts`) | identici, cifra per cifra: 1.055 ricette in 250 contesti, 625 operazioni decimali, 66 numeri in formato italiano, 120 grafi |
| **U** | test di dominio dell'originale portati: `DominioTest` (27) e `VerificheObbligatorieTest` (10, casi A–E del capitolato) | 37/37 |
| **T** | test API dell'originale portati: `AuthTenancyTest` (17), `CostingFlowTest` (17), `ImportsTest` (15 originali + 4 nuovi), `PerformanceTest` (1) | tutti superati |
| **C** | `tools/parity/compare.mjs`: 66 letture sulle due API avviate in parallelo con gli stessi dati dimostrativi | 64 identiche, 2 differenze spiegate sotto |
| **A** | `tools/parity/actions.mjs`: 56 scritture (archiviazioni, eliminazioni, inviti, password, stati…) eseguite in sequenza su entrambe le API | **56/56 identiche** |
| **E** | test nel browser: `e2e/flusso-ricetta.mjs` (lo script dell'originale, invariato), `e2e/console-saas.mjs` e `e2e/redditivita.mjs` | superati sia con `php artisan serve` sia su Apache + `.htaccess` (Docker) |
| **V** | `tools/parity/screens.mjs`: 18 schermate di originale e clone confrontate pixel per pixel, con due utenti (amministratore e responsabile) | differenze solo negli orari di creazione dei dati e nel badge di sviluppo di Next |

Totale PHPUnit: **369 test, 5.758 verifiche**.

Legenda: ✅ equivalente e provato · 🟡 equivalente con differenze dichiarate · ➕ novità non presente nell'originale · ⛔ assente anche nell'originale.

## 1. Accesso, aziende, ruoli

| Funzionalità | Stato | Prove | Note |
|---|---|---|---|
| Login con messaggio generico; limite di 10 tentativi/minuto | ✅ | T `test_rifiuta_credenziali…`, `test_limita_i_tentativi_di_login`; A | |
| Logout, profilo `/auth/me` | ✅ | T, C | `/auth/me` ha in più il campo `assist` (➕) |
| Sessione: cookie `fc_session`, hash SHA-256, 14 giorni | ✅ | T, E | stessa tabella `sessions` dell'originale |
| Scelta dell'azienda attiva, schermata "Scegli l'azienda" | ✅ | T `test_utente_con_piu_aziende…`, A, E | |
| Isolamento tra aziende (404 sugli ID altrui, `invalid_reference`) | ✅ | T `test_b_non_vede…`, `test_b_non_usa…`; `PlatformTest` | |
| Cambio password (chiude le altre sessioni di quell'utente) | ✅ | A (5 passi) | |
| Recupero e reimpostazione password, link monouso | ✅ | T `test_recupero_password_monouso` | |
| Inviti a nuovi utenti e a utenti già registrati; revoca | ✅ | T, A (7 passi) | |
| Ruoli, permessi aggiuntivi e implicazioni | ✅ | T, C (`/users/catalog`) | |
| Ultimo amministratore protetto | ✅ | T `test_non_si_rimuove_ultimo_admin` | |
| Disattivazione di una membership | ✅ | T `test_invito_accettazione…` | |
| Creazione azienda (amministratore di piattaforma) e rinomina | ✅ | A | |
| CSRF (header + origine) | ✅ | T, C (risposta identica) | |
| Audit senza importi retributivi | ✅ | T `test_audit_senza_importi_retributivi` | in più nasconde la voce extra (➕). Nessuna pagina di consultazione, come nell'originale (⛔) |

## 2. Ingredienti e prezzi

| Funzionalità | Stato | Prove | Note |
|---|---|---|---|
| Elenco con ricerca, filtri (prezzo mancante o zero, archiviati), ordinamenti, paginazione | 🟡 | C (8 letture), T `PerformanceTest` | a parità di categoria l'ordine dipende dall'ID casuale, nell'originale come nel clone (differenza C n. 1) |
| Scheda, creazione, modifica, `lockVersion` | ✅ | C, A, T | |
| Codice automatico `ING-00001`, unicità senza distinzione di maiuscole | ✅ | T `test_ingrediente_al_volo…`, `test_codici_generati_in_sequenza` | |
| Conversioni: densità, peso unitario, incompatibilità | ✅ | T `test_unita_incompatibili`, U | |
| Storico prezzi: una voce per data, prezzi futuri, eliminazione | ✅ | T `test_prezzo_stessa_data_e_futuro`, A | |
| Ricette interessate (anche indirettamente) | ✅ | T `test_snapshot_prezzo_propagazione_confronto` | |
| Archiviazione, ripristino, eliminazione solo se mai usato | ✅ | T, A | |
| Categorie | ✅ | C | |
| **Agente del fornitore sul prezzo** | ➕ | `PlatformTest::test_agente_salvato…` | facoltativo; nel modulo prezzo, nell'importazione e nello storico |

## 3. Utenze e tariffe

| Funzionalità | Stato | Prove | Note |
|---|---|---|---|
| Tariffe elettricità (solo kWh), gas (m³, Smc, kWh), acqua | ✅ | T `test_elettricita_solo_kwh`, C | |
| Versioni dirette e da bolletta; anteprima bolletta | ✅ | T `test_tariffa_da_bolletta`, C | |
| Coefficienti gas m³→Smc; avviso e costo incompleto | ✅ | T `test_gas_m3_senza_coefficiente`, U | |
| Eliminazione versione, archiviazione, ripristino, rinomina | ✅ | A | |
| Consumo d'acqua sugli strumenti | ⛔ | — | assente anche nell'originale |

## 4. Strumenti

| Funzionalità | Stato | Prove | Note |
|---|---|---|---|
| CRUD, archiviazione, eliminazione solo se mai usato | ✅ | A, C | |
| Alimentazione elettrica, gas, mista, manuale; preriscaldamento e mantenimento | ✅ | U, G, C | |
| Avvisi di completezza, controllo del tipo di tariffa | ✅ | T, A | |

## 5. Dipendenti e costo del lavoro

| Funzionalità | Stato | Prove | Note |
|---|---|---|---|
| CRUD, archiviazione, configurazioni con decorrenza, eliminazione | ✅ | A, C | |
| Oneri in una sola modalità (≤ 200%), ore produttive, anteprima | ✅ | U, A, C | |
| Riservatezza delle retribuzioni (campi assenti dal payload) | ✅ | T `test_responsabile_non_vede…`, `test_operatore_non_vede_costi` | |
| Solo numeri normalizzati nell'API | ✅ | T `test_numeri_solo_normalizzati` | |
| **Voce extra mensile** che si somma al lordo | ➕ | `PlatformTest::test_voce_extra_della_retribuzione` | nel modulo, nello storico e nell'importazione. Se assente, i calcoli coincidono con l'originale |

## 6. Ricette

| Funzionalità | Stato | Prove | Note |
|---|---|---|---|
| Motore di costo (ingredienti, semilavorati, energia, manodopera, resa, porzioni) | ✅ | **G**, U, T | |
| Elenco con costi da cache, ordinamenti per costo e €/kg | ✅ | C, T | |
| Editor con anteprima calcolata dal backend | ✅ | E, T `test_ingrediente_al_volo_e_anteprima` | |
| Revisioni immutabili e consultabili | ✅ | T `test_nuova_revisione_non_altera_snapshot`, C | |
| Concorrenza (`stale`) | ✅ | T `test_salvataggi_concorrenti` | |
| Cicli diretti e indiretti, opzioni dei semilavorati | ✅ | T `test_impedisce_cicli`, C, G | il `LIMIT 50` prima dell'esclusione è replicato (anomalia dell'originale) |
| Duplicazione, archiviazione, ripristino (torna in **bozza**), attivazione, eliminazione | ✅ | T, A | il ripristino in bozza è replicato (anomalia dell'originale) |
| Snapshot immutabili, confronto con motivi, valorizzazione a una data | ✅ | T `test_snapshot_…`, C | |
| Fasi: inizio e durata solo nell'API | ⛔ | — | come nell'originale |

## 7. Dashboard

| Funzionalità | Stato | Prove |
|---|---|---|
| Conteggi, ricette incomplete, ingredienti senza prezzo, ultimi prezzi, ultime ricette | ✅ | C, T `test_dashboard`, V |

## 8. Importazioni

| Funzionalità | Stato | Prove | Note |
|---|---|---|---|
| CSV e XLSX fino a 10 MB; `.xls` rifiutato; controllo del contenuto reale | ✅ | T `test_rifiuta_xls…`, `test_xlsx_…` | |
| Rilevamento di separatore, codifica e fogli; abbinamento delle colonne | ✅ | T `test_rileva_separatore…` | |
| Validazione completa prima di scrivere; staging; numeri e date all'italiana; formule rifiutate; duplicati | ✅ | T (6 test) | |
| Conferma atomica, idempotente, che ricontrolla le modifiche dopo l'anteprima | ✅ | T `test_conferma_…`, `test_modifica_dopo_anteprima…`, `test_codici_generati_in_sequenza` | |
| Report CSV protetto da formula injection; modelli CSV/XLSX | ✅ | T `test_report_neutralizza_formule`, `test_modelli_csv_e_xlsx` | |
| Limite di righe, conservazione di 30 giorni | ✅ | T `test_oltre_limite_righe`, `test_pulizia_solo…` | |
| Elaborazione in background | 🟡 | T `test_avanzamento_senza_worker_tramite_polling`, `SystemTest` | nessun worker: avanza con il polling, dopo la risposta e con il cron (ARCHITETTURA §5). Stesso risultato visibile |
| Volumi: 5.000 righe (test) e 20.000 righe (misura) | ✅ | T `test_5000_righe_a_blocchi`; misura HTTP | 20.000 righe: validazione 1,6 s, applicazione 2,9 s (inserimenti) o 7,2 s (aggiornamenti) |
| Campi di importazione in più | ➕ | C (differenza n. 2) | "Agente" (ingredienti) e "Voce extra retribuzione" (dipendenti) |
| Modalità parziale | ⛔ | — | assente anche nell'originale |

## 9. Interfaccia (22 pagine)

| Aspetto | Stato | Prove | Note |
|---|---|---|---|
| Tutte le 22 pagine e gli URL dell'originale, anche come link diretti | ✅ | V, E | stesse pagine e componenti, compilati con Vite |
| Grafica identica | ✅ | V (18 schermate, 2 utenti) | |
| Flusso completo di creazione di una ricetta | ✅ | E (script originale invariato) | |
| Modifiche visibili | ➕ | V | campo "Agente" (riga in più sotto "Fonte" solo se compilato), "Voce extra mensile", menu "Piattaforma" e "Assistenza" solo per il superadmin |

## 10. Novità SaaS

| Funzionalità | Prove |
|---|---|
| Superadmin: console accessibile solo a lui (401/403 per tutti gli altri) | `PlatformTest::test_solo_il_superadmin…` |
| Nuova azienda con invito al suo amministratore | `test_nuovo_tenant_con_invito…`, E |
| Tutte le ricette e tutti i prodotti, fornitori, doppioni segnalati (non unificati) | `test_vede_le_ricette_di_tutti…`, E |
| Confronti tra ricette scelte (statistiche, ripartizione, ingredienti) | `test_vede_le_ricette_di_tutti_e_le_confronta`, E |
| Statistiche prezzi per prodotto, fornitore, agente, azienda | `test_statistiche_prezzi…`, E |
| Modalità assistenza registrata nell'audit | `test_modalita_assistenza_registrata`, E |
| Primo superadmin senza SSH; deploy e cron protetti da chiave | `SystemTest` (4) |

## 11. Novità: coefficiente di redditività

| Funzionalità | Stato | Prove |
|---|---|---|
| Piatti da vendere a settimana, per giorno di apertura e al mese per coprire i costi fissi, con il piatto scelto come unità di misura | ➕ | `BreakEvenTest` (6, compreso l'esempio della pizzeria), `ProfitabilityTest::test_calcolo_completo`, E |
| Costi fissi (affitto, mutuo, finanziamenti, leasing, assicurazioni, servizi, altro) settimanali, mensili o annuali, con data di fine | ➕ | `ProfitabilityTest`, E |
| Personale e quote fisse delle bollette aggiunti in automatico, senza doppi conteggi | ➕ | `test_personale_escludibile_e_quote_fisse_bollette` |
| Giorni di chiusura settimanali | ➕ | `test_calcolo_completo`, E |
| Prezzo in menu con IVA inclusa per ricetta | ➕ | `test_casi_senza_risposta`, E |
| Solo l'amministratore (403 anche al responsabile con permesso sulle retribuzioni), isolamento tra aziende | ➕ | `test_solo_amministratore`, `test_isolamento_tra_aziende`, E |
| Nessun effetto sulle API dell'originale | ✅ | C 64/66 e A 56/56 rieseguiti dopo l'aggiunta, risultati invariati |

## 12. Novità: bollette delle utenze (caricamento e lettura automatica)

| Funzionalità | Stato | Prove |
|---|---|---|
| Caricamento della bolletta in PDF o foto (JPG, PNG, WebP), tipo controllato dal contenuto; HEIC rifiutato con istruzioni | ➕ | `TariffBillsTest::test_tipi_di_file_controllati_dal_contenuto` |
| Lettura con Claude (Anthropic), facoltativa con `ANTHROPIC_API_KEY`: periodo, consumo, voci nette IVA, quote fisse, coefficienti gas; il modulo «Calcola da una bolletta» arriva precompilato e si salva solo dopo la conferma | ➕ | `test_lettura_precompila_e_conferma_collega_la_bolletta`, `test_gas_in_metri_cubi_convertito_e_coefficienti`, E |
| Avvisi: utenza sbagliata, somma voci ≠ imponibile, consumi stimati, doppione, accrediti esclusi | ➕ | `test_avvisi_utenza_sbagliata_e_somma_diversa` |
| Archivio delle bollette per utenza: apertura, download, eliminazione; il file resta anche se il valore generato viene eliminato | ➕ | `test_file_scaricabile_ed_eliminabile`, E |
| **Lettura locale** (predefinita, senza servizi esterni): testo estratto dal PDF sul server (smalot/pdfparser) e diciture standard ARERA (Bolletta 2.0 e bolletta trasparente), luce, gas e acqua; riepilogo «trovato/non trovato» per ogni dato; **tutte le voci incluse (IVA e canone compresi)**, così il prezzo è il totale pagato ÷ consumo, e controllo che le voci sommino il totale da pagare (differenza aggiunta come «Altre voci», accrediti sottratti); sottovoci «di cui» ignorate (formato Iren verificato su una bolletta reale); foto e scansioni archiviate da compilare a mano | ➕ | `test_lettura_locale_luce`, `test_lettura_locale_gas_bolletta_trasparente`, `test_lettura_locale_acqua`, `test_lettura_locale_iren_quote_e_sottovoci`, `test_voci_mancanti_e_accrediti_riconciliati_col_totale`, `test_senza_chiave_foto_archiviata_e_pdf_senza_testo`, E |
| Con il servizio in errore la bolletta si archivia comunque e si compila a mano; limite mensile di letture per azienda (`BILL_AI_MONTHLY_LIMIT`, 40) | ➕ | `test_senza_chiave_archivia_senza_leggere`, `test_errore_del_servizio_non_perde_il_file`, `test_limite_mensile` |
| Permessi (`tariffs.manage` per caricare/eliminare, `tariffs.read` per consultare) e isolamento tra aziende | ➕ | `test_permessi_e_isolamento` |
| Eliminazione di un valore di tariffa o di una configurazione di costo del dipendente inserita per errore (API già presenti nell'originale, mancava il pulsante) | ✅ | E `tariffa.mjs` |

## Differenze rimaste rispetto all'originale

1. **Ordinamento con valori uguali** (`/ingredients?sort=category`). A parità di categoria entrambe le API ordinano per ID interno, cioè per UUID casuali diversi nei due database. Non è una differenza di logica.
2. **Campi di importazione dei dipendenti:** 12 invece di 11, per la voce extra (novità richiesta).
3. **Esecuzione delle importazioni:** senza worker permanente (requisito dell'hosting condiviso). Esiti, stati e messaggi sono gli stessi.
4. **Caricamento dell'interfaccia:** le pagine si caricano tutte all'avvio, come il prefetch di Next. Pesano 172 kB compressi.

## Anomalie dell'originale replicate così come sono

- `PATCH /employees/:id` e `PATCH /tariffs/:id` senza `lockVersion`.
- Il ripristino di una ricetta la riporta sempre in bozza.
- `GET /recipes/options` applica `LIMIT 50` prima di escludere i cicli.
- Le tariffe archiviate restano usate nelle valorizzazioni.

## Difetti trovati e corretti durante la verifica

Erano tutti nel clone, non nell'originale:

- **Modello Excel:** il download falliva.
- **Avanzamento delle importazioni:** il filtro sui lavori non funzionava su MySQL, a causa del JSON normalizzato.
- **Valori di tempo negativi:**
  - la pulizia avrebbe cancellato i file di **tutte** le importazioni;
  - un lavoro in corso poteva essere ripreso da un'altra richiesta.
- **Applicazione di 20.000 righe:** impiegava 30 s, ora 3 s.
- **Interfaccia:**
  - errore dopo il login con le versioni recenti di Chrome;
  - stato intermedio durante la navigazione;
  - intestazioni di sicurezza duplicate.
- **Deploy:** falliva al primo avvio se mancava la cartella delle viste.
- **Parametri doppi:** con un ID non valido il messaggio d'errore era diverso.

## Ancora da verificare (fuori da questo ambiente)

- Pubblicazione reale su Aruba e limiti effettivi del piano (tempo massimo di esecuzione, versione di MySQL). Richiede la tua autorizzazione e le credenziali.
- Invio reale delle email SMTP.
- Docker Desktop su Windows: l'ambiente è stato provato con Docker su Linux, con gli stessi file.
