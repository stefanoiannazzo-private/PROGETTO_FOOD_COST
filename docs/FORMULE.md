# Formule di calcolo

Tutte le formule sono in `packages/domain` (motore puro, senza database), usato da anteprima, salvataggio, API, snapshot e importazioni. Aritmetica decimale a 40 cifre significative (`decimal.js`): nessun arrotondamento intermedio, si arrotonda solo in visualizzazione. Importi netti IVA, come inseriti.

## Ingredienti

| Grandezza | Formula |
|---|---|
| Prezzo normalizzato | prezzo confezione ÷ contenuto confezione nell’unità base (€/kg, €/l, €/pz) |
| Quantità netta | quantità di ricetta convertita nella grandezza della confezione |
| Quantità acquistata equivalente | quantità netta ÷ resa edibile |
| Costo riga | quantità acquistata equivalente × prezzo normalizzato |

- La quantità in ricetta è **netta**; la resa edibile (0 < resa ≤ 100%) si applica una sola volta e lo scarto non viene riaddebitato altrove.
- Conversioni ammesse: kg/g, l/cl/ml, pezzi. Volume ↔ peso solo con **densità** (kg/l); pezzi ↔ peso solo con **peso medio unitario**. Senza questi dati la riga è segnalata come incompleta, mai convertita “a occhio”.
- Prezzo valido: l’ultima voce di storico con data di validità ≤ data di valorizzazione; le date future non si applicano prima del tempo; non possono esistere due prezzi con la stessa data per lo stesso articolo.
- Prezzo mancante ≠ prezzo zero: il primo rende la valorizzazione incompleta, il secondo è un costo valido (segnalato).

Esempio (verifica A): confezione 5 kg a 30 € → 6 €/kg; 150 g → 0,15 kg × 6 = **0,90 €**.

## Energia

| Fonte | Formula |
|---|---|
| Elettrica stimata | kWh = kW × minuti ÷ 60 × coefficiente di utilizzo; costo = kWh × €/kWh |
| Gas da portata | consumo = portata oraria × minuti ÷ 60 [× fattore di carico, una sola volta]; costo = consumo × tariffa nella stessa unità |
| Gas da potenza | kWh = kW × minuti ÷ 60 [× fattore di carico]; tariffa in €/kWh o conversione esplicita |
| Consumo misurato | sostituisce la stima (non si somma) |
| Quota condivisa | costo imputato = costo dell’uso × quota dichiarata (0 < quota ≤ 100%) |

- kW è potenza, kWh energia: l’elettricità si paga in €/kWh.
- m³ e Smc non sono equivalenti. Conversioni gas solo con coefficienti configurati sulla tariffa: m³→Smc e potere calorifico kWh/Smc. Senza coefficiente, una tariffa €/Smc con consumi in m³ è **rifiutata** (costo incompleto con spiegazione).
- Preriscaldamento, lavorazione e mantenimento sono segmenti distinti, ciascuno con il proprio coefficiente se configurato: non si sommano due volte.
- Alimentazione mista: si calcolano separatamente le fonti effettivamente usate. Strumento manuale: costo energetico esplicitamente zero.
- Parametri mancanti (potenza, coefficiente, tariffa): costo incompleto, mai consumi inventati.

Verifiche C e D: 3 kW × 40 min × 0,8 = **1,6 kWh** × 0,30 = **0,48 €**; 2 m³/h × 15 min = **0,5 m³** × 1,20 €/m³ = **0,60 €**.

### Tariffa media da bolletta

prezzo medio = somma delle voci selezionate ÷ consumo del periodo. Voci variabili e quote fisse sono distinte; le quote fisse si includono solo per scelta esplicita (con avviso a non reimputarle altrove). Il consumo deve essere nell’unità della tariffa.

## Manodopera

| Grandezza | Formula |
|---|---|
| Costo orario sul solo lordo | lordo mensile ÷ ore mensili produttive |
| Costo aziendale mensile | lordo + oneri + altri costi |
| Oneri | importo mensile **oppure** percentuale × lordo ÷ 100 (una sola modalità) |
| Costo orario aziendale | costo aziendale mensile ÷ ore produttive |
| Costo al minuto | costo orario ÷ 60 |
| Costo assegnazione | minuti attivi × costo al minuto × quota |

- Nessun numero universale di ore, mensilità o maggiorazione contributiva: si usano solo i dati inseriti.
- Se mancano oneri e altri costi, il costo è “solo lordo” e viene segnalato.
- I minuti sono di lavoro **attivo**: 60 minuti di forno possono richiedere 10 minuti di persona.

Verifica B: 2.400 € ÷ 160 h = **15 €/h**, **0,25 €/min**; 12 min = **3 €** (solo lordo).

## Ricetta e lotto

| Voce | Formula |
|---|---|
| Ingredienti diretti | Σ costi delle righe ingrediente |
| Semilavorati | Σ quantità prelevata × costo unitario della sottoricetta |
| Energia | Σ costi imputati degli usi strumento |
| Manodopera | Σ costi delle assegnazioni |
| **Costo di produzione** | ingredienti diretti + semilavorati + energia + manodopera |
| Costo/kg | totale ÷ peso finale netto (kg) |
| Costo/porzione | totale ÷ numero di porzioni |
| Peso porzione | peso finale netto ÷ porzioni |

- La resa finale è **dichiarata**: non è la somma degli ingredienti. Dopo averla usata come denominatore non si applicano ulteriori perdite.
- Costo unitario della sottoricetta: totale ÷ peso finale netto se dosata a peso, altrimenti totale ÷ resa dichiarata se l’unità è della stessa grandezza; dosaggi in grandezze diverse richiedono dati espliciti.
- Il costo del semilavorato entra nel padre **solo come subtotale di riga**; la sua scomposizione è informativa. Il riepilogo “con semilavorati espansi” sostituisce il subtotale con le sue componenti (× frazione prelevata), senza aggiungerle.
- Una sottoricetta usata in due righe è costata due volte (fabbisogni sommati); la memoizzazione evita solo di ricalcolarla.
- Durata complessiva dichiarata, minuti macchina e minuti-persona sono mostrati separatamente: le attività possono sovrapporsi.
- Se manca un dato, il totale delle voci valorizzate è mostrato come **subtotale incompleto** con l’elenco delle mancanze e il percorso (es. Lasagna → Ragù → Carne).

Verifica E: ragù 20 + 2 + 12 = **34 €**, 5 kg → **6,80 €/kg**; lasagna 600 g di ragù = **4,08 €** + 8 + 1 + 6 = **19,08 €**; 2,4 kg → **7,95 €/kg**; 8 porzioni → **2,385 €** (visualizzato 2,39 €).
