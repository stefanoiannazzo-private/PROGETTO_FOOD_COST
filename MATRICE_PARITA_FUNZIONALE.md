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
| Modifica di un valore già registrato (riapre il modulo con i dati, ricalcola le ricette; `PUT /tariffs/{id}/versions/{versionId}`) | ➕ | `test_modifica_di_un_valore_registrato`, E `modifica.mjs` |
| Eliminazione di un'utenza creata per errore con valori e bollette (`DELETE /tariffs/{id}`); rifiutata se uno strumento la usa | ➕ | `test_eliminazione_utenza`, E |

## 13. Novità: modulo prodotto semplificato

| Funzionalità | Stato | Prove |
|---|---|---|
| «Come lo paghi?»: al kg, al litro, al pezzo (con il peso del pezzo) o a confezione (tipo e contenuto), tradotto nei campi esistenti (`purchaseUnit`, `packageContent`, `packageUnit`): nessuna modifica al database né alle API | ➕ | E `prodotto.mjs` (girello 45 € / 3,2 kg = 14,0625 €/kg; uova 6 € / 30 pz = 0,20 €/pz) |
| Prezzo senza IVA con anteprima immediata del prezzo al kg/litro/pezzo; esempi sotto ogni campo; campi tecnici in «Altri dettagli» | ➕ | E |
| Categoria e fornitore obbligatori nel modulo, con suggerimenti di quelli già usati (`GET /ingredients/suppliers`) | ➕ | `IngredientSuggestionsTest`, E |
| Agente da tendina, prima quelli del fornitore (`GET /ingredients/agents`), con «nuovo agente» | ➕ | `IngredientSuggestionsTest`, E |
| Nuovo prezzo con lo stesso blocco; le modalità incompatibili con i prezzi registrati (peso/volume/pezzi) sono disattivate | ➕ | E |

## 14. Novità: coefficienti degli strumenti con esempi e valori automatici

| Funzionalità | Stato | Prove |
|---|---|---|
| Esempi sotto i coefficienti elettrici (forno/combi 0,5·1·0,05; fry top 0,6·1·0,25; friggitrice 0,5·1·0,1; induzione 0,6·1·0,2; motori 0,8) con pulsante «Usa»; esempi del fattore di carico gas (fuochi 0,5; fry top 0,6; forno 0,5; friggitrice 0,5) | ➕ | E `strumenti.mjs` |
| Coefficienti facoltativi: se vuoti, al salvataggio vengono compilati con i valori tipici del macchinario riconosciuto da nome/categoria (altrimenti valori medi 0,5·1·0,1 e gas 0,5), con avviso; le API restano invariate | ➕ | E (forno 18,9 kW → 0,5/1/0,05; fuochi a gas → 0,5) |

## 15. Novità: costo del dipendente semplificato con mensilità

| Funzionalità | Stato | Prove |
|---|---|---|
| Un solo importo mensile «tutto compreso» (lordo, contributi, TFR: cifra del consulente); niente oneri a parte nel modulo | ➕ | E `dipendente.mjs` |
| Mensilità pagate in un anno (12–16, predefinite 12) e voce extra con «per quante mensilità» (1…mensilità) | ➕ | `EmployeeMonthsTest` |
| Costo orario = (costo × mensilità + extra × mensilità extra) ÷ 12 + altri costi, diviso le ore produttive; riepilogo con costo annuo | ➕ | `EmployeeMonthsTest` (2700 × 14 + 200 × 12 + 50 × 12 = 40.800 €/anno → 21,25 €/h) |
| Configurazioni esistenti (senza mensilità) calcolate come prima: 12 su 12 | ✅ | suite di parità invariata |

## 16. Novità: stato della ricetta dalla scheda

| Funzionalità | Stato | Prove |
|---|---|---|
| Selettore «Stato: Bozza / Attiva» accanto a Modifica nella scheda ricetta (`POST /recipes/{id}/activate` dell'originale e nuovo `POST /recipes/{id}/draft`) | ➕ | `RecipeStatusTest`, E `stato.mjs` |

## 17. Novità: link di invito dalla console del superadmin

| Funzionalità | Stato | Prove |
|---|---|---|
| Creazione azienda: il link di invito viene sempre mostrato con il pulsante «Copia»; l'email parte solo se il superadmin clicca «Invia per email» (`POST /platform/invitations/{id}/send`, con verifica del token) | ➕ | `PlatformTest::test_link_di_invito_sempre_visibile_e_invio_su_richiesta`, E `invito.mjs` |
| «Nuovo link» per un invito in attesa o scaduto: il link precedente smette di valere, il nuovo vale 7 giorni (`POST /platform/invitations/{id}/renew`) | ➕ | stesso test, E |

## 18. Novità: tabelle su smartphone

| Funzionalità | Stato | Prove |
|---|---|---|
| Sotto i 720 px ogni tabella (liste e tabelle delle schede) mostra solo il nome con una freccia; toccando la riga si aprono gli altri dati come «etichetta: valore»; il nome resta il link alla scheda (`components/MobileTables.tsx`, un solo punto per tutte le tabelle) | ➕ | E `mobile.mjs`, `mobile2.mjs` (390 × 844, nessuno scorrimento orizzontale) |
| Ordinamento delle liste con una tendina su smartphone (le intestazioni sono nascoste) | ➕ | E |
| Scheda ricetta su schermi stretti: il riquadro Costi non resta fisso sopra la composizione | ✅ | E |

## 19. Novità: fasi di lavorazione con attese

| Funzionalità | Stato | Prove |
|---|---|---|
| Editor: una scheda per fase con nome, durata (min o ore) e interruttore «Attesa»; strumenti e persone si aggiungono dentro la fase, con subtotale energia/manodopera | ➕ | E `fasi.mjs` |
| Fasi di attesa (lievitazione, maturazione, riposo): nessuna manodopera; frigorifero o cella facoltativo in mantenimento per la durata della fase, con la quota di spazio occupato | ➕ | `RecipePhasesTest` (frigo 0,4 kW × 24 h × 0,4 × 10% = 0,192 €) |
| Tempo totale di preparazione = somma delle durate delle fasi (calcolato dal server), con le ore di attesa | ➕ | `RecipePhasesTest`, E |
| Scheda ricetta: strumenti e persone raggruppati per fase, con durata, attesa e subtotale | ➕ | E |
| Avviso nei piatti che usano un semilavorato: «va preparato almeno N h prima (di cui M h di attesa)» | ➕ | `RecipePhasesTest`, E |

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

## 20. Guida del primo accesso (NUOVO)

| Funzione | Stato |
|---|---|
| Guida a passi che si apre da sola al primo accesso dell'amministratore (non in modalità assistenza, non nella console piattaforma) | ✅ |
| Riquadro evidenziato sul pulsante, vignetta con descrizione, "N di M", pallini di avanzamento, CHIUDI / INDIETRO / SEGUI → / HO CAPITO | ✅ |
| Percorso: benvenuto → Utenze → Strumenti → Dipendenti → Prodotti → Importazioni → Ricette → Redditività → pulsante Guida; passi filtrati per permessi | ✅ |
| Chiusura o completamento registrati sull'utente (`users.tour_completed_at`, `POST /api/auth/tour`, `tourDone` in `/auth/me`) | ✅ |
| Pulsante "Guida" nella barra in alto per riaprirla; Esc chiude, frecce per navigare; su mobile la vignetta sta in basso o in alto | ✅ |

## 21. Fatture elettroniche dei fornitori (NUOVO)

| Funzione | Stato |
|---|---|
| In Importazioni, terza scelta «Fatture dei fornitori (XML)»: più file insieme, .xml, .xml.p7m (anche in base64) e .zip (anche annidati, file di metadati SDI ignorati) | ✅ |
| Lettura sul server senza servizi esterni: fornitore e partita IVA, numero, data, totale, righe con codice articolo, quantità, unità, prezzo netto (totale riga ÷ quantità, sconti di riga compresi), IVA | ✅ |
| Fatture già importate riconosciute (fornitore + numero + data) e saltate | ✅ |
| Per ogni riga: Nuovo prodotto (nome, **categoria obbligatoria**, **come lo paghi** obbligatorio) / Prodotto esistente / Ignora. KG → al kg, LT → al litro, N/NR/PZ/CT → a confezione, con il contenuto letto dalla descrizione (es. 700G, 6X1,5L → 9 l) | ✅ |
| Sconti, abbuoni e righe senza prezzo proposti come «Ignora» | ✅ |
| Prezzi registrati alla data della fattura, senza IVA, con fonte «Fattura N del …» e il fornitore; prezzi già presenti in quella data non toccati | ✅ |
| Memoria degli abbinamenti per fornitore (codice articolo o descrizione): dalla fattura successiva le righe sono «Riconosciute» | ✅ |
| Tutto o niente: con errori su una riga non viene scritto nulla e la riga è evidenziata | ✅ |
| Archivio: elenco delle fatture (da abbinare / importate), XML originale scaricabile, bozze scartabili | ✅ |

## 22. Avvisi di variazione e storico prezzi (NUOVO)

| Funzione | Stato |
|---|---|
| Avviso su prodotto e ricette (anche indirette, tramite semilavorati) quando cambia il costo **di oggi**: nuovo prezzo a mano, fattura XML, importazione Excel, prezzo eliminato, bolletta/valore utenza, costo del personale, strumento, semilavorato modificato | ✅ |
| Nessuna email o notifica push: badge «Costo variato» / «Prezzo variato» negli elenchi, contatore nel menu, riquadro in cima agli elenchi con «Segna tutte come viste» | ✅ |
| Nella scheda: costo totale e a porzione prima → adesso con differenza e %, motivo («Prezzo di Burro: 11,50 → 12,88 € al kg (+12,0%)»), fonte (fattura, bolletta…), chi e quando | ✅ |
| L'avviso sparisce dopo aver aperto la scheda, per quel solo utente; prezzi con data futura non generano avvisi; visibili solo a chi vede i costi; conservati 90 giorni | ✅ |
| Storico prezzi del prodotto: grafico a gradini del prezzo al kg/litro/pezzo con tooltip, variazione dal primo prezzo, minimo, massimo, media, variazione rispetto al prezzo precedente, fornitore, filtro per fornitore, collegamento alla fattura XML di provenienza | ✅ |

## 23. Peso della ricetta dagli ingredienti e file SDI non validi (NUOVO)

| Funzione | Stato |
|---|---|
| Peso totale di ingredienti e semilavorati calcolato in automatico (g, kg; litri con densità; pezzi con peso al pezzo; semilavorati in base alla loro resa) e mostrato sotto la lista degli ingredienti | ✅ |
| Se il peso dopo la cottura non è indicato, vale il peso degli ingredienti: costo al kg, peso porzione e uso come semilavorato a peso funzionano subito. Se manca il peso di qualche ingrediente si dice quale | ✅ |
| Sezione «Peso, resa e porzioni» spostata sotto gli ingredienti: peso dopo cottura (facoltativo) con calo in cottura %, porzioni, peso porzione, quantità ottenuta facoltativa (es. 30 pz), durata, note | ✅ |
| Le verifiche di parità con l'originale girano con il comportamento originale (opzione del motore); i costi già calcolati vengono ricalcolati, gli snapshot no | ✅ |
| Fatture: il file dei metadati SDI (FileMetadati) e le ricevute/notifiche SDI caricati da soli danno un messaggio chiaro con il nome del file della fattura da caricare (prima venivano scartati senza messaggio); messaggio anche quando nei file non c'è nessuna fattura | ✅ |

## 24. Marchio Ricetta Quadra (NUOVO)

| Funzione | Stato |
|---|---|
| Logo completo senza sfondo (occhielli delle lettere trasparenti, bordi sfumati) nella barra laterale e nelle pagine di accesso, invito e recupero password; variante con «Ricetta» chiaro per il tema scuro | ✅ |
| Pittogramma: favicon (.ico 16/32/48 e PNG 32), icona Apple 180, icone 192/512 con manifest, barra in alto su smartphone | ✅ |
| Nome «Ricetta Quadra» nel titolo delle pagine, nelle email (oggetto e mittente) e nella configurazione di produzione | ✅ |

## 25. Web app installabile (PWA) (NUOVO)

| Funzione | Stato |
|---|---|
| Manifest `/manifest.webmanifest` (nome, colori, icone normali e «maskable», scorciatoie Nuova ricetta / Carica fatture XML / Ricette / Prodotti); Chrome la considera installabile senza errori | ✅ |
| Service worker `/sw.js`: le API (`/api/*`) non passano mai dalla cache; file dell'interfaccia e marchio in cache; senza rete la pagina «Sei offline» che si ricarica da sola al ritorno della connessione | ✅ |
| «Installa l'app»: pulsante nella barra laterale, invito chiudibile sulla dashboard degli smartphone, pagina pubblica `/installa` (link dalla pagina di accesso) con istruzioni per iPhone/iPad (Safari → Condividi → Aggiungi alla schermata Home), Android e computer; su Android e computer apre direttamente la richiesta del browser | ✅ |
| App installata: a tutto schermo, rispetto di tacca e barra in basso dell'iPhone, avviso «Sei offline» quando cade la connessione | ✅ |
| `.htaccess`: service worker e manifest senza cache lunga, tipo MIME corretto del manifest | ✅ |

## 26. Filtri delle tabelle su smartphone (NUOVO)

| Funzione | Stato |
|---|---|
| Su smartphone resta la ricerca; tendine di filtro e ordinamento dietro un pulsante di solo testo «Filtri» con icona, numero di filtri attivi e «Azzera filtri»; su computer tutto invariato in fila. Un solo componente (FilterBar) per Ingredienti, Ricette, Strumenti, Dipendenti, Utenze, Redditività e le pagine della piattaforma | ✅ |

## 27. Avviso «nuova versione» (NUOVO)

| Funzione | Stato |
|---|---|
| Ogni build scrive il proprio identificativo nel codice e in `/app/version.txt` (sempre ricontrollato, mai in cache; testo perché la radice blocca i .json); quando l'app torna in primo piano, al ritorno della rete e ogni 10 minuti confronta le due: se sul sito c'è una versione più recente compare la barra «È disponibile una nuova versione» con **Aggiorna** (ricarica) e **Più tardi**; anche il service worker viene ricontrollato | ✅ |

## 28. Assistenza e domande frequenti (NUOVO)

| Funzione | Stato |
|---|---|
| Voce «Assistenza» nel menu per tutti gli utenti: chiamata al numero di supporto (`SUPPORT_PHONE`, predefinito +39 391 732 6882) che su smartphone avvia la telefonata e su computer si mostra con «Copia»; orari facoltativi (`SUPPORT_HOURS`) | ✅ |
| Nuova richiesta: pagina dell'app (select, proposta in automatico dalla pagina da cui si arriva), tipo (Domanda / Problema / Suggerimento), oggetto, messaggio, screenshot o PDF facoltativo, telefono per essere richiamati; risposte frequenti pertinenti proposte sopra il modulo | ✅ |
| Conversazione con l'assistenza, «Nuova risposta» e contatore nel menu finché non la si legge, chiusura «Problema risolto» (un nuovo messaggio la riapre); l'amministratore vede le richieste di tutta l'azienda, gli altri solo le proprie | ✅ |
| Console «Assistenza clienti» del superadmin: richieste di tutte le aziende per stato, contatore delle richieste da rispondere nel menu, dettagli tecnici (pagina precedente, dispositivo), richiamata, «Assisti» per entrare nell'azienda, risposta con allegato, chiusura/riapertura | ✅ |
| Email automatiche: al supporto (amministratori della piattaforma) per nuove richieste e messaggi, al cliente quando arriva una risposta, con il link | ✅ |
| Domande frequenti `/assistenza/faq`: 25 risposte in 11 sezioni, ricerca e filtro per sezione, rimando all'assistenza | ✅ |

## 29. Testata «soluzione C» (NUOVO)

| Funzione | Stato |
|---|---|
| Smartphone: ☰ a sinistra, logo completo al centro della barra, cerchio con le iniziali dell'azienda a destra; niente più nome dell'azienda su due righe né «Guida» nella barra | ✅ |
| Menu delle iniziali: azienda attiva con utente e ruolo, cambio azienda (se più di una), Guida all'uso, Assistenza, Domande frequenti, Installa l'app, Esci; si chiude toccando fuori o con Esc; in modalità assistenza il cerchio è evidenziato | ✅ |
| Computer: barra laterale invariata, a destra nome dell'azienda e iniziali con lo stesso menu; l'ultimo passo della guida indica il cerchio delle iniziali | ✅ |
