# Coach AI Web

Dashboard React/Fastify con Readiness Engine, porta 8099. Richiede Home Assistant OS amd64 e uno snapshot SQLite consistente in `/share/coachai/cycling_coach.db`. Il mount e l'accesso SQLite sono in sola lettura. Lo snapshot non è incluso nel pacchetto.

Per Intervals.icu configura `intervals_athlete_id` e `intervals_api_key` nel campo password dell'add-on. L'integrazione è opzionale ed esegue solo GET. Non inserire credenziali in questo repository. Lo schema dei feedback non conserva la data della sensazione; le limitazioni dei dati sono mostrate nella dashboard.

La sostituzione atomica dello snapshot viene rilevata senza riavvio. La dashboard non ha login: usa soltanto una rete locale fidata, senza port forwarding. Nessun Telegram, scheduler o scrittura su Intervals o database di allenamento. Lo storico delle valutazioni è separato in /data/coachai/readiness-history.sqlite.

L'immagine viene costruita localmente da Home Assistant usando il Dockerfile incluso, Node.js 24 e il lockfile delle dipendenze. `dist`, `build` e `node_modules` sono generati nell'immagine, non distribuiti nel repository.
