# Coach AI Web 0.9.0 — Adaptive Training Engine

Coach web autonomo per allenamento, Readiness e alimentazione.
Aprire l’interfaccia **da Home Assistant Ingress**: usa la sessione autenticata,
senza inserimento di token. Pannello amministratori, quattro tab responsive:
Riepilogo, Allenamento, Alimentazione, Debug.

Accesso diretto 8099: la pagina mostra le istruzioni per Ingress, le API richiedono
il Bearer `admin_api_token` esistente (minimo 32 caratteri). Nessuna eccezione per
la LAN. Non inoltrare header Ingress tramite altri proxy né abilitare host_network.
Tutte le API, comprese letture e diagnostica, sono autenticate; scritture Ingress
protette anche contro richieste browser cross-site. Non inserire token nel browser.

Database `/data/coachai.db`, storico e opzioni rimangono persistenti. SQL001–005
immutati; nessuna nuova migrazione nell’aggiornamento 0.8.0 → 0.9.0, nessuna nuova
importazione. Non disinstallare cancellando `/data`. Snapshot `/share` readonly.
Conservare un backup Home Assistant valido prima di aggiornare.

Wellness mancante non diventa zero: Readiness completa, provvisoria o non
valutabile; valori obsoleti sono riferimenti visivi, esclusi dal punteggio.
Alimentazione e configurazione restano utilizzabili. Form conservati durante
la navigazione; modifiche non salvate restano soltanto in memoria.

Il Riepilogo separa Readiness fisiologica, Confidence (affidabilità senza limiti
di intensità) e consiglio automatico del Planner. In Allenamento, **Coach** usa
Readiness, piano e attività recenti; Genera, Leggero e Intenso rimangono automatici.
**Manuale** rispetta la categoria esplicita, anche oltre il consiglio, conservando
punteggi e avvisi: Tempo, Sweet Spot, Soglia, VO2max, Endurance, Forza, Recupero,
Riposo. Rigenera conserva la modalità. La selezione resta locale. I fattori
incerti non sono presentati come fatica; la spiegazione tecnica conserva la
catena automatica, consultiva per le richieste manuali. Feedback storico e
ambiguo non limitano il recupero attuale; il recupero esplicitamente datato sì.

Credenziali solo opzioni password: intervals_api_key, groq_api_key, admin_api_token.
Integrazioni esistenti conservate; nuove installazioni Groq, sync e dettagli
Intervals disabilitati per default. Nessuno stream o scrittura verso Intervals.
Debug offre proiezioni numeriche sanificate, timestamp disponibili e limiti,
senza token, nomi/ID attività o payload grezzi completi. L’istante di misurazione
originale e i grezzi non conservati nelle vecchie cache restano non disponibili.
Telegram assente; dati storici legacy preservati.
