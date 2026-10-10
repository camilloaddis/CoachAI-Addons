# Coach AI Web 0.5.0

Dashboard React/Fastify con Readiness Engine, diario alimentare e servizi persistenti. Home Assistant OS amd64, Node.js 24, porta 8099. Home Assistant costruisce l'immagine dal Dockerfile e dal lockfile inclusi; nessun database o credenziale è distribuito.

Per default legge soltanto lo snapshot consistente `/share/coachai/cycling_coach.db` con mount read-only. Il nuovo database `/data/coachai.db` è separato e persistente; storico Readiness conservato senza ricostruire punteggi passati. Dashboard senza login: soltanto rete LAN fidata, senza port forwarding. API diagnostiche richiedono Bearer amministrativo >=32 caratteri, nessun endpoint di scrittura HTTP.

Telegram, Groq, acquisizione automatica e scrittura Intervals sono **disabilitati per default**. L'installazione non sostituisce Node-RED né avvia il bot. Le GET Readiness Intervals preesistenti restano opzionali quando si configurano athlete ID e API key.

Per un futuro passaggio seguire la guida privata: schema/conteggi reali, importazione preliminare, arresto verificato del vecchio consumer e delle scritture, snapshot finale Online Backup API, importazione definitiva verificata, cursore update_id inizializzato offline e modalità local. Non copiare un SQLite in uso e non avviare due consumer Telegram. Non modificare il database sorgente. `node_red_stopped` è una dichiarazione amministrativa, non un rilevatore del bot esterno.

Credenziali solo nelle opzioni password: `intervals_api_key`, `telegram_bot_token`, `groq_api_key`, `admin_api_token`. `groq_model` default openai/gpt-oss-120b. `groq_enabled`, `intervals_sync_enabled`, `intervals_write_enabled`, `telegram_enabled`: false; polling default 900 secondi. Il worker Intervals e Telegram richiedono importazione definitiva, modalità local e vecchio consumer fermo. La chiave Groq non arriva al frontend.

Il diario produce stime da confermare con `accetta pasto`, gestisce `annulla`, `pasti DATA`, correzioni e cancellazioni. `settimana` termina a ieri. `allenamento` seleziona strutture deterministiche con FTP configurabile (220 W di riferimento), otto settimane e guardrail conservativi; AI spiega la decisione, non cambia il workout. `accetta` carica un evento solo con scrittura Intervals esplicitamente abilitata.

Richieste gambe per Ride/VirtualRide recenti non commuting, anche senza evento pianificato. Gli invii incerti e i flag storici non provano consegna: richiedono verifica manuale e non vengono duplicati automaticamente. I feedback retrospettivi non sono misure fisiologiche odierne. Menù testuali, piano futuro condizionale e assenza di verifica Garmin sono limiti espliciti; non si dichiara parità perfetta con ogni interazione Node-RED.
