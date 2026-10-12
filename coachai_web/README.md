# Coach AI Web 1.2.1

Coach web per Home Assistant OS amd64, Node.js 24, Fastify, React e SQLite.

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

Dopo l'aggiornamento controllare versione 1.2.1, pasti/RPE/allenamenti,
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
