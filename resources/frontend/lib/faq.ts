/**
 * NUOVO — Domande frequenti dell'assistenza. Ogni voce è legata a un'area (la stessa della select
 * «Pagina» del modulo di richiesta), così il modulo può proporre le risposte pertinenti.
 */
export interface Faq {
  id: string
  area: string
  q: string
  a: string[]
}

export const FAQ_AREAS: Record<string, string> = {
  primi: 'Primi passi',
  ricette: 'Ricette e semilavorati',
  ingredienti: 'Ingredienti e prodotti',
  importazioni: 'Fatture XML ed Excel',
  utenze: 'Utenze e bollette',
  strumenti: 'Strumenti e attrezzature',
  dipendenti: 'Dipendenti e costo del lavoro',
  redditivita: 'Redditività e prezzi in menu',
  utenti: 'Utenti e permessi',
  app: 'App sul telefono',
  account: 'Accesso e account',
}

export const FAQ: Faq[] = [
  // ------------------------------------------------------------------ primi passi
  {
    id: 'ordine',
    area: 'primi',
    q: 'Da dove comincio?',
    a: [
      'Conviene inserire i dati nell’ordine in cui servono al calcolo: prima le utenze (luce e gas), poi gli strumenti (forni, piastre, frigoriferi), poi il personale, infine i prodotti con i prezzi. A quel punto le ricette si costruiscono in pochi minuti.',
      'La guida del primo accesso ti accompagna in questo percorso: puoi riaprirla quando vuoi con il pulsante «Guida» in alto.',
    ],
  },
  {
    id: 'costo-composto',
    area: 'primi',
    q: 'Da cosa è composto il costo di una ricetta?',
    a: [
      'Dalla somma di tre parti: gli ingredienti (al netto della resa, cioè degli scarti), l’energia degli strumenti usati (in base alla potenza, al tempo e al prezzo della tua bolletta) e la manodopera (minuti di lavoro × costo orario del dipendente).',
      'Nella scheda della ricetta trovi il dettaglio di ogni voce e il costo totale, al kg e a porzione.',
    ],
  },
  {
    id: 'iva',
    area: 'primi',
    q: 'I prezzi vanno inseriti con o senza IVA?',
    a: [
      'I prezzi dei prodotti si inseriscono senza IVA, come compaiono in fattura. Le bollette invece si registrano con tutto compreso (IVA, canone, quote fisse): è il costo reale che sostieni.',
      'Il prezzo in menu dei piatti, nella pagina Redditività, si indica con IVA inclusa, come lo vede il cliente.',
    ],
  },
  // ------------------------------------------------------------------ ricette
  {
    id: 'peso',
    area: 'ricette',
    q: 'Devo indicare il peso finale della ricetta?',
    a: [
      'Non è obbligatorio: il peso totale degli ingredienti si calcola da solo e lo trovi sotto la lista degli ingredienti.',
      'Indica il «Peso finale dopo la cottura» solo se la cottura lo cambia (un ragù che cala, un pane che perde acqua): così il costo al kg e il peso della porzione sono corretti, e vedi anche il calo in cottura in percentuale.',
    ],
  },
  {
    id: 'peso-incompleto',
    area: 'ricette',
    q: 'Perché il peso degli ingredienti risulta «incompleto»?',
    a: [
      'Succede quando un ingrediente è a pezzi (uova, limoni) senza il peso del singolo pezzo, oppure a litri senza la densità. Il programma ti dice quale ingrediente manca.',
      'Aprilo dalla scheda prodotto e indica il peso al pezzo o la densità in «Altri dettagli», oppure scrivi direttamente il peso finale della ricetta.',
    ],
  },
  {
    id: 'semilavorati',
    area: 'ricette',
    q: 'Come uso una ricetta dentro un’altra (semilavorato)?',
    a: [
      'Nella ricetta, sotto gli ingredienti, usa «+ Aggiungi semilavorato» e scegli la ricetta di base (un impasto, un fondo, un ragù). Puoi dosarla a peso (es. 250 g) o a porzioni.',
      'Il costo del semilavorato entra in proporzione. Se ha tempi di preparazione lunghi (lievitazioni, riposi), la ricetta che lo usa ti avvisa che va preparato in anticipo.',
    ],
  },
  {
    id: 'fasi',
    area: 'ricette',
    q: 'A cosa servono le fasi e le fasi «di attesa»?',
    a: [
      'Le fasi dividono la preparazione (impasto, lievitazione, cottura…) e dentro ognuna indichi strumenti e persone usati e la durata. Il tempo totale si calcola da solo.',
      'Una fase di attesa (lievitazione, maturazione, riposo) non ha manodopera: puoi indicare solo un frigorifero o una cella con la quota di spazio occupata, così ne paghi una parte del consumo.',
    ],
  },
  {
    id: 'avvisi',
    area: 'ricette',
    q: 'Cosa vuol dire «Costo variato» accanto a una ricetta?',
    a: [
      'Che il costo di oggi è cambiato dall’ultima volta che l’hai aperta: un nuovo prezzo di un ingrediente, una nuova bolletta, un costo del personale aggiornato o un semilavorato modificato.',
      'Aprendo la ricetta vedi prima → adesso, il motivo e la fonte. L’avviso poi sparisce, solo per te: i colleghi lo vedono finché non la aprono anche loro.',
    ],
  },
  {
    id: 'snapshot',
    area: 'ricette',
    q: 'A cosa serve «Salva snapshot»?',
    a: [
      'Fissa il costo della ricetta in quel momento, con tutti i prezzi del giorno, e non cambia più. Serve quando fai un menu o un listino: sai su quale costo hai deciso i prezzi.',
      'In cima alla scheda trovi il confronto «Rispetto all’ultimo snapshot», utile per capire quando è il momento di ritoccare il prezzo in menu.',
    ],
  },
  // ------------------------------------------------------------------ ingredienti
  {
    id: 'come-paghi',
    area: 'ingredienti',
    q: 'Come scelgo tra «al kg», «al litro», «al pezzo» e «a confezione»?',
    a: [
      'Scegli come lo compri: al kg o al litro se il prezzo in fattura è per kg o litro; al pezzo per uova, limoni, bottiglie singole (indicando il peso di un pezzo); a confezione per cartoni, vaschette, latte (indicando quanto contiene la confezione).',
      'Il programma converte tutto in prezzo al kg, al litro o al pezzo, così le ricette si confrontano sempre allo stesso modo.',
    ],
  },
  {
    id: 'resa',
    area: 'ingredienti',
    q: 'Cos’è la «resa» di un prodotto?',
    a: [
      'La parte che usi davvero dopo la pulizia: per le carote all’80% significa che su 1 kg compri 200 g di scarto. Il costo nelle ricette tiene conto della resa, quindi un prodotto con molto scarto costa di più per grammo usato.',
    ],
  },
  {
    id: 'storico',
    area: 'ingredienti',
    q: 'Dove vedo come è cambiato un prezzo nel tempo?',
    a: [
      'Nella scheda del prodotto, sezione «Storico prezzi»: grafico dell’andamento, prezzo minimo, massimo e medio, variazione rispetto al prezzo precedente e il fornitore. Se il prezzo arriva da una fattura XML, la fonte apre la fattura.',
    ],
  },
  // ------------------------------------------------------------------ importazioni
  {
    id: 'fatture-xml',
    area: 'importazioni',
    q: 'Come importo i prezzi dalle fatture dei fornitori?',
    a: [
      'In Importazioni scegli «Fatture dei fornitori (XML)» e carica i file .xml o .xml.p7m (anche più insieme) oppure lo .zip scaricato dal cassetto fiscale o dal tuo programma di fatturazione.',
      'Per ogni riga decidi se è un prodotto nuovo (con categoria e modalità di acquisto), uno che hai già o da ignorare. Le scelte vengono ricordate: dalla fattura successiva dello stesso fornitore le righe sono già abbinate.',
    ],
  },
  {
    id: 'metadati',
    area: 'importazioni',
    q: 'Mi dice «Questo è il file dei metadati dello SDI». Cosa devo caricare?',
    a: [
      'Il file dei metadati accompagna la fattura ma non la contiene. Il messaggio ti indica il nome del file giusto: di solito termina con .xml.p7m (o .xml) ed è nella stessa cartella o nello stesso .zip.',
    ],
  },
  {
    id: 'excel',
    area: 'importazioni',
    q: 'Posso caricare i prodotti da Excel?',
    a: [
      'Sì: in Importazioni scegli «Ingredienti e prezzi», scarica il modello, compilalo e caricalo. Prima di salvare vedi l’anteprima con gli eventuali errori riga per riga; i dati vengono scritti tutti insieme solo dopo la tua conferma.',
    ],
  },
  // ------------------------------------------------------------------ utenze
  {
    id: 'bolletta',
    area: 'utenze',
    q: 'Come inserisco una bolletta?',
    a: [
      'Apri l’utenza (luce o gas) e carica il PDF della bolletta: il programma legge consumo e totale e ti propone il prezzo, che confermi o correggi. Funziona anche con una foto, che però va compilata a mano.',
      'Il prezzo è il totale pagato (IVA, canone e quote fisse comprese) diviso il consumo: è il costo reale di ogni kWh o Smc.',
    ],
  },
  // ------------------------------------------------------------------ strumenti
  {
    id: 'coefficienti',
    area: 'strumenti',
    q: 'Cosa sono i coefficienti degli strumenti? Devo per forza compilarli?',
    a: [
      'Indicano quanta potenza lo strumento usa davvero rispetto a quella di targa (un forno non lavora sempre al massimo). Sono facoltativi: se li lasci vuoti il programma usa valori tipici riconosciuti dal nome (forno, fry top, fuochi a gas…).',
      'Se hai i dati del costruttore o vuoi essere più preciso, puoi modificarli in qualsiasi momento.',
    ],
  },
  // ------------------------------------------------------------------ dipendenti
  {
    id: 'costo-dipendente',
    area: 'dipendenti',
    q: 'Che cifra inserisco per il costo di un dipendente?',
    a: [
      'Un unico importo mensile tutto compreso: lordo, contributi e TFR. È la cifra che ti dà il consulente del lavoro. Indica poi quante mensilità paghi in un anno (12 se tredicesima e quattordicesima sono già spalmate) ed eventuali altri costi mensili (buoni pasto, divise).',
      'Il programma calcola il costo orario dalle ore effettivamente lavorate.',
    ],
  },
  // ------------------------------------------------------------------ redditività
  {
    id: 'redditivita',
    area: 'redditivita',
    q: 'Come funziona la pagina Redditività?',
    a: [
      'Risponde alla domanda «quanti piatti devo vendere a settimana per andare in pari?». Scegli il piatto, indica il prezzo in menu (IVA inclusa) e vedi food cost %, margine a porzione e il numero di piatti necessari, tenendo conto dei giorni di chiusura.',
      'È visibile solo agli amministratori dell’azienda.',
    ],
  },
  // ------------------------------------------------------------------ utenti
  {
    id: 'utenti',
    area: 'utenti',
    q: 'Come aggiungo un collaboratore e cosa può vedere?',
    a: [
      'Da «Utenti» invii un invito via email scegliendo il ruolo: Amministratore (tutto), Responsabile o Operatore. Ogni ruolo ha i suoi permessi (per esempio i costi e gli stipendi non sono visibili a tutti) e puoi aggiungere permessi in più alla singola persona.',
    ],
  },
  // ------------------------------------------------------------------ app
  {
    id: 'installa',
    area: 'app',
    q: 'Come installo l’app sul telefono?',
    a: [
      'iPhone: apri ricettaquadra.it con Safari, tocca Condividi e poi «Aggiungi alla schermata Home». Android: tocca «Installa l’app» (nella barra laterale o nell’invito sulla dashboard) oppure dal menu ⋮ di Chrome scegli «Installa app».',
      'Trovi le istruzioni complete nella pagina ricettaquadra.it/installa.',
    ],
  },
  {
    id: 'aggiornamenti',
    area: 'app',
    q: 'Come ricevo gli aggiornamenti dell’app?',
    a: [
      'Da soli: quando esce una nuova versione compare la barra «È disponibile una nuova versione»; tocca «Aggiorna». Salva prima eventuali modifiche in corso.',
    ],
  },
  {
    id: 'offline',
    area: 'app',
    q: 'L’app funziona senza internet?',
    a: [
      'No: ricette, prezzi e costi arrivano sempre dal server, così sono aggiornati e al sicuro. Senza connessione compare l’avviso «Sei offline» e l’app si ricarica da sola quando la rete torna.',
    ],
  },
  // ------------------------------------------------------------------ account
  {
    id: 'password',
    area: 'account',
    q: 'Ho dimenticato la password.',
    a: ['Nella pagina di accesso tocca «Password dimenticata?»: ricevi via email un link valido 60 minuti per sceglierne una nuova. Se l’email non arriva, controlla nella posta indesiderata.'],
  },
  {
    id: 'dati',
    area: 'account',
    q: 'I miei dati sono al sicuro? Gli altri ristoranti li vedono?',
    a: [
      'Ogni azienda vede solo i propri dati: ricette, prezzi e costi non sono mai visibili ad altri clienti. Il collegamento è sempre cifrato (HTTPS) e sul telefono non restano copie dei dati.',
      'Se chiedi aiuto all’assistenza, possiamo entrare nel tuo account solo in modalità assistenza, e ogni accesso viene registrato.',
    ],
  },
]

/** Le aree del modulo di richiesta corrispondenti alle sezioni delle FAQ. */
export const AREA_TO_FAQ: Record<string, string[]> = {
  dashboard: ['primi'],
  ricette: ['ricette', 'primi'],
  ingredienti: ['ingredienti'],
  strumenti: ['strumenti'],
  utenze: ['utenze'],
  dipendenti: ['dipendenti'],
  redditivita: ['redditivita'],
  importazioni: ['importazioni'],
  utenti: ['utenti'],
  impostazioni: ['account'],
  app: ['app'],
  account: ['account'],
  altro: ['primi'],
}

/** Dalla pagina di provenienza all'area del modulo. */
export function areaFromPath(path: string): string {
  const seg = path.split('?')[0]!.split('/').filter(Boolean)[0] ?? ''
  const map: Record<string, string> = {
    '': 'dashboard',
    ricette: 'ricette',
    ingredienti: 'ingredienti',
    strumenti: 'strumenti',
    utenze: 'utenze',
    dipendenti: 'dipendenti',
    redditivita: 'redditivita',
    importazioni: 'importazioni',
    utenti: 'utenti',
    impostazioni: 'impostazioni',
    installa: 'app',
  }
  return map[seg] ?? 'altro'
}
