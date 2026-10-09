# Coach AI Web

Dashboard React/Fastify con Readiness Engine, porta 8099. Richiede Home Assistant OS amd64 e uno snapshot SQLite consistente in `/share/coachai/cycling_coach.db`. Il mount e l'accesso SQLite sono in sola lettura. Lo snapshot non è incluso nel pacchetto.

Per Intervals.icu configura `intervals_athlete_id` e `intervals_api_key` nel campo password dell'add-on. L'integrazione è opzionale ed esegue solo GET. Non inserire credenziali in questo repository. Lo schema dei feedback non conserva la data della sensazione; le limitazioni dei dati sono mostrate nella dashboard.

La sostituzione atomica dello snapshot viene rilevata senza riavvio. La dashboard non ha login: usa soltanto una rete locale fidata, senza port forwarding. Nessun Telegram, scheduler o scrittura su Intervals o database di allenamento. Lo storico delle valutazioni è separato in /data/coachai/readiness-history.sqlite.

L'immagine viene costruita localmente da Home Assistant usando il Dockerfile incluso, Node.js 24 e il lockfile delle dipendenze. `dist`, `build` e `node_modules` sono generati nell'immagine, non distribuiti nel repository.

## Coach AI Web 0.4.0

Crea `/data/coachai.db` persistente separato dallo snapshot e conserva lo storico Readiness. Per default `data_source: snapshot`, `telegram_enabled: false`, `node_red_stopped: false`, credenziali vuote. Nessun bot, sincronizzazione Node-RED o endpoint HTTP di scrittura viene attivato automaticamente. Il mount `/share` rimane in sola lettura.

Le opzioni Telegram vanno configurate solo al passaggio amministrativo: importazione definitiva validata, vecchio consumer fermo, modalità local, cursore update_id inizializzato offline e chat privata autorizzata. `telegram_bot_token` e `admin_api_token` sono password nelle opzioni Home Assistant; non inserirli nel repository o nei log. Le API diagnostiche richiedono un token amministrativo di almeno 32 caratteri.

La versione prepara i servizi persistenti; non replica ancora parsing nutrizionale AI, scheduler attività o ricalcolo dei nuovi riepiloghi del vecchio Coach. Importazione reale e passaggio richiedono la guida privata del repository sorgente e la verifica dello schema/conteggi reali. Mai avviare due consumer Telegram sullo stesso token.
