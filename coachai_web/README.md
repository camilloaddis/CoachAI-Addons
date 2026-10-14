# Coach AI Web 1.4.1

Coach web per Home Assistant OS amd64, Node.js 24, Fastify, React e SQLite.

## Changelog 1.4.1 dalla 1.4.0

- Corretto il blocco della selezione manuale quando manca il target giornaliero o il carico è fuori dalla banda ideale.
- La selezione automatica ordina per vicinanza al carico ideale, senza escludere per la sola banda; conserva il tetto di capacità osservata e considera categorie inferiori quando la categoria prevista non offre candidati sicuri.
- Durata predefinita di 60 minuti esplicita, tolleranza ±10 minuti e limiti fisiologici conservati. Nessuna nuova dipendenza, opzione o migrazione.

## Changelog 1.4.0 dalla 1.3.0

- Supporto Intervals `power.target: "3s"` conservando i range FTP. La durata degli step validati prevale su `moving_time`; le differenze vengono segnalate senza tagliare gli step.
- Readiness v4: CTL/ATL/TSB condividono il contributo carico; qualità/durata del sonno condividono il contributo sonno. Baseline personali per HRV e durata; dati mancanti esclusi, Confidence separata.
- Target giornaliero deterministico da carico recente, recupero, obiettivo e fase, con banda indicativa. Ranking per `icu_training_load`, durata entro ±10 minuti inclusivi e AI limitata alla rosa validata.
- Cache precedente rivalutata alla prossima sincronizzazione, rispettando cooldown/backoff. Nessun workout sintetico: assenza di carico, dati o candidati produce motivi espliciti.
- Classificazione, limiti dei picchi, SQL001–006, dipendenze e opzioni invariati. La preparazione 1.4.0 aggiorna solo metadati e documentazione del codice già mergiato.

### Verifica sul NUC dopo l'aggiornamento

1. Verificare **1.4.1** nell'interfaccia, accesso Ingress/LAN e persistenza di configurazione, pasti e storico. Conservare un backup completo HA; aggiornare senza disinstallare né reimportare.
2. In **Impostazioni → Libreria workout Intervals**, sincronizzare la libreria dell'account già configurato (opzione `intervals_library_sync_enabled`). Non serve sqlite3. Controllare ultima sincronizzazione, compatibili/incompatibili e diagnostica dei rifiuti. Se la libreria contiene ancora gli stessi 55 workout, verificare che i 55 siano compatibili col parser; eventuali rifiuti vanno analizzati per codice/percorso, non nascosti.
3. Compatibile col parser non significa selezionabile: categoria, sport, durata, picchi, fase e carico possono escludere un workout. Per i quattro workout con differenze `moving_time`, scegliere il workout nella diagnostica e scaricare l’esempio dopo conferma: `cached.warnings` e `observed.warnings` devono riportare `duration_mismatch`; la proposta deve mantenere la durata integrale degli step e i range FTP.
4. Aggiornare la sincronizzazione attività/wellness già configurata e impostare obiettivo, piano e durata. Per il target servono copertura dei 14 giorni precedenti e almeno tre giornate con carico/durata validi. In Training generare una nuova proposta e aprire **INSIGHT** e leggere **Training Load ideale**: verificare target/banda, `icu_training_load`, differenza, durata entro ±10 min e motivazioni. Consultare la diagnostica selezione per esclusioni di carico assente o oltre la capacità osservata.
5. Con recupero ridotto o fase scarico verificare target ridotto e limiti fisiologici; nessun candidato deve mostrare il motivo. Rigenera deve usare solo alternative compatibili. AI disabilitata/non disponibile mantiene una scelta locale reale; quando attiva sceglie nella rosa validata. Nessuna pubblicazione sul calendario è necessaria per questi controlli.

Lo storico precedente resta distinto dal modello readiness-v4. Il carico del workout proviene solo da `icu_training_load`: assente/invalido è null, non viene stimato. I 55 workout reali vanno verificati sul NUC: i test di sviluppo modellano lo schema noto, non il loro export completo.

## Changelog 1.3.0 dalla 1.2.1

- Diagnostica della libreria: motivi di incompatibilità salvati, conteggi per codice/percorso e campioni selezionabili per ID/nome.
- Export diagnostico di un singolo workout, dopo conferma della nuova lettura Intervals, con dati personali e note mascherati e confronto fra rifiuto live e payload sanitizzato.
- Nessuna modifica al normalizzatore, alla classificazione o ai limiti fisiologici. Nessuna nuova migrazione o dipendenza; gli allenamenti remoti non vengono modificati.

### Diagnostica dei workout incompatibili

In **Impostazioni → Libreria workout Intervals → Mostra motivi di incompatibilità**, leggere i rifiuti già salvati senza chiamate API. Scegliere un workout, autorizzare la nuova lettura e premere **Scarica esempio diagnostico**. Non serve sqlite3 sulla NUC.

L'export usa una nuova GET folders e scarica solo il workout scelto, con account, URL, segreti e note mascherati; il raw non viene salvato o registrato nei log. Le letture esplicite sono limitate e non avviano una sincronizzazione. Controllare `redaction.reproducesIssues: true` prima di usare il JSON come fixture. Il parser può fermarsi al primo errore: i conteggi descrivono i rifiuti osservati, non tutti i difetti del documento.

La 1.3.0 aggiungeva la raccolta delle evidenze, senza correggere il parser. La 1.4.0 include la correzione di `power.target: "3s"`; usare la diagnostica per eventuali altri formati rifiutati.

## Changelog 1.2.1 dalla 1.2.0

- LAN senza login quando abilitata: `lan_auth_required: false` predefinito; origine facoltativa. Password/sessioni precedenti restano opt-in con `lan_auth_required: true`.
- Corretto il 400 `invalid_request` di GENERA al cambio modalità/categoria: nuova generazione per intento diverso, rigenerazione solo per lo stesso intento.
- Nessuna modifica ad algoritmi, database, migrazioni o dipendenze.

Se nella 1.2.0 era già impostato `lan_enabled: true`, dopo l'aggiornamento
l'accesso LAN è aperto per default, anche con una vecchia password salvata.
Per conservare il login impostare esplicitamente `lan_auth_required: true`.
Con `lan_enabled: false`, Ingress e autenticazione diretta restano invariati.

## Modifiche della 1.2.0 rispetto alla 1.1.0

- Accesso LAN opzionale con password dedicata e sessione HttpOnly nella 1.2.0; Ingress resta supportato sulla stessa installazione e sugli stessi database.
- Host e porta espliciti per avvio autonomo, API `/api/v1` compatibili con `/api` e health minimale `/healthz`. Porta host disabilitata per default nell'add-on.
- Navigazione a quattro tab con icone e schede allenamento, selezione automatica/manuale e grafico workout verificato.
- Tab Pasto riorganizzato in riepilogo giornaliero, registrazione/anteprima e diario per data con modifica/cancellazione dei pasti.
- RPE sincronizzato con Intervals.icu; diario sempre modificabile, senza chiusura/riapertura, totali letti dai pasti correnti.
- Pacchetto completo dei componenti frontend e della licenza delle icone; controlli su import locali, sicurezza, persistenza e aggiornamento.

Nessuna nuova migrazione: SQL001–006 e storico readiness invariati. Il campo
legacy `food_complete` rimane nel database per compatibilità ma non blocca più
le modifiche del diario. L'aggiornamento non abilita sync, Groq o calendario.

## Accesso Home Assistant Ingress

Aprire **Coach AI Web → Apri interfaccia web** da Home Assistant. Il pannello
è riservato agli amministratori HA e usa la sessione Ingress, senza password
web o token API. `ingress_port: 8099` resta invariato e funziona anche quando
il mapping della porta host è disabilitato. Non aggiungere permessi Supervisor,
`host_network`, modalità privilegiata o accesso in scrittura alla share.

## LAN opzionale, senza password

Impostare `lan_enabled: true` e `lan_auth_required: false` (default), abilitare
la porta host **8099** per `8099/tcp` nella sezione Rete e riavviare.
CoachAI è raggiungibile su `http://IP-NUC:8099/`, le API su
`http://IP-NUC:8099/api/v1/...`, senza login o token. Ingress resta disponibile
tramite HA sulla porta 8123, usando lo stesso backend e database.

`lan_web_password` può restare vuota. `lan_web_origin` è facoltativa: vuota
per accesso semplice, oppure origine esatta come `http://192.168.0.100:8099`
per vincolare l'host browser. I client locali senza Origin non richiedono
header browser speciali; validazione, idempotenza e protezione delle scritture
cross-origin restano attive.

L'accesso aperto autorizza tutti i peer socket privati/loopback che raggiungono
il servizio, senza fiducia negli IP inoltrati. Non esporre questa modalità
tramite port forwarding o tunnel Internet. Nessun nuovo permesso HA è richiesto.
Mapping salvati in precedenza possono restare attivi: verificarli dopo upgrade.

Il login precedente resta disponibile se si imposta `lan_auth_required: true`,
con password casuale 24–256 caratteri e origine esatta. Con LAN disabilitata
rimangono Bearer e Ingress. `/healthz` è sempre minimale e pubblico.

## Persistenza e aggiornamento dalla 1.1.0

Prima dell'aggiornamento scaricare un backup completo HA che includa dati e
configurazione. Aggiornare l'add-on esistente, senza disinstallarlo:

- `/data/coachai.db`: database applicativo, con ledger/checksum delle migrazioni.
- `/data/coachai/readiness-history.sqlite`: storico readiness osservato.
- `/data/options.json`: opzioni e credenziali, da mantenere private.
- `/data/backups/`: eventuali backup di upgrade precedenti.
- `/share/coachai/cycling_coach.db`: snapshot sorgente in sola lettura.

I file SQLite, WAL/SHM e backup non sono parte del pacchetto sorgente pubblico.
Fare copie consistenti tramite SQLite Backup API o con servizio fermo; non
rimuovere WAL, ledger o dati per aggiornare. `data_source: local` richiede
l'importazione finale già completata e non viene impostato dall'upgrade.

Dopo l'aggiornamento controllare versione 1.4.1, pasti/RPE/allenamenti,
configurazione, storico e Ingress. Attivare LAN solo se desiderato. La
pubblicazione sul calendario resta opt-in tramite
`intervals_calendar_write_enabled` e richiede conferma di data e allenamento.

Per rollback arrestare l'add-on e ripristinare il backup completo precedente;
le modifiche successive al backup andranno perse. Non reinstallare né
sovrascrivere un database con una copia incoerente.

## Avvio autonomo fuori HA

Dalla directory applicativa eseguire `npm ci`, `npm run build` e `npm start`
con Node.js 24. Il default è `127.0.0.1:8099`. Per LAN configurare
`COACHAI_HOST`, `COACHAI_PORT`, `COACHAI_LAN_ENABLED=true`,
`COACHAI_LAN_AUTH_REQUIRED=false` e opzionalmente `COACHAI_LAN_WEB_ORIGIN`, oltre ai percorsi
persistenti `COACHAI_APP_DB`, `COACHAI_HISTORY`, `COACHAI_DB` e alla sorgente
attuale. Il file opzioni può essere indicato con `COACHAI_OPTIONS_FILE`.
Host LAN specifico preferibile a tutte le interfacce; segreti in file protetti,
mai nel checkout. Un processo esterno a HA non viene registrato automaticamente
come Ingress: per entrambi gli accessi usare la stessa istanza add-on.

Le icone Lucide mantengono la licenza in `web/lucide-LICENSE.txt`.
