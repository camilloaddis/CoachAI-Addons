# Coach AI Web 1.2.0

Coach web per Home Assistant OS amd64, Node.js 24, Fastify, React e SQLite.

## Changelog dalla 1.1.0

- Accesso LAN opzionale con password dedicata e sessione HttpOnly; Ingress resta supportato sulla stessa installazione e sugli stessi database.
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

## LAN opzionale sulla stessa installazione

1. Scegliere un indirizzo stabile del NUC e una porta host libera.
2. Impostare `lan_enabled: true` nelle opzioni dell'add-on.
3. Impostare `lan_web_password` a un segreto casuale di 24–256 caratteri,
   distinto da `admin_api_token` e dalle chiavi dei provider.
4. Impostare `lan_web_origin` all'origine esatta della pagina, ad esempio
   `http://192.168.1.30:8099`, senza path, query o credenziali.
5. Abilitare volontariamente il mapping host per `8099/tcp` nella sezione rete
   dell'add-on; il default è disabilitato (`null`). Se cambia la porta host,
   aggiornare anche `lan_web_origin`. Riavviare l'add-on.
6. Aprire quella URL e autenticarsi con la password web. Ingress continua a
   funzionare e utilizza lo stesso database; non avviare una seconda istanza.

Durante un upgrade un mapping impostato in precedenza può rimanere attivo:
verificarlo esplicitamente. Limitare la porta ai dispositivi della LAN fidata
con firewall/router. HTTP non cifra password e cookie: su reti condivise usare
HTTPS tramite proxy locale e un'origine HTTPS. Nessun port forwarding pubblico.

Cookie HttpOnly/SameSite Strict, durata assoluta otto ore, revoca al logout o
riavvio e limiti ai tentativi. Nessun token amministrativo viene inserito nel
browser. Le API sensibili richiedono Ingress verificato, sessione valida o
`Authorization: Bearer ...` con il token amministrativo esistente (almeno 32
caratteri). Non passare segreti nella URL. Gli header proxy non autenticano.
`/healthz` è pubblico e mostra solo lo stato HTTP; `/api/v1/health` è diagnostico
e autenticato. Il servizio non implementa Tunnel o autenticazione Cloudflare.

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

Dopo l'aggiornamento controllare versione 1.2.0, pasti/RPE/allenamenti,
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
`COACHAI_LAN_WEB_PASSWORD` e `COACHAI_LAN_WEB_ORIGIN`, oltre ai percorsi
persistenti `COACHAI_APP_DB`, `COACHAI_HISTORY`, `COACHAI_DB` e alla sorgente
attuale. Il file opzioni può essere indicato con `COACHAI_OPTIONS_FILE`.
Host LAN specifico preferibile a tutte le interfacce; segreti in file protetti,
mai nel checkout. Un processo esterno a HA non viene registrato automaticamente
come Ingress: per entrambi gli accessi usare la stessa istanza add-on.

Le icone Lucide mantengono la licenza in `web/lucide-LICENSE.txt`.
