# Coach AI Web 0.7.0

Applicazione web autonoma per allenamento, Readiness, feedback e diario alimentare.
Telegram rimosso; i dati storici sono preservati. Porta dashboard: 8099.

Database persistente /data/coachai.db; migrazione SQL005 automatica e additiva.
Non reinstallare cancellando /data. Le installazioni già migrate dalla 0.6.1 non
richiedono una nuova importazione. Snapshot /share/coachai/cycling_coach.db readonly.

Le operazioni web richiedono admin_api_token casuale di almeno 32 caratteri.
Inserirlo nel pannello Coach, usando HTTPS già configurato o rete locale fidata.
Il token resta in memoria nel browser. Nessun token va pubblicato o condiviso.
Credenziali solo opzioni password: intervals_api_key, groq_api_key, admin_api_token.

Groq, sync Intervals e dettagli selettivi restano disabilitati per default.
Le impostazioni esistenti restano operative secondo configurazione. I dettagli
selettivi richiedono intervals_details_enabled; nessuno stream viene scaricato.
La scrittura su Intervals non è implementata. Selezionare un workout lo salva
soltanto localmente. Nessun bot, callback o worker Telegram viene avviato.

Prima dell'aggiornamento conservare un backup Home Assistant oppure SQLite Online
Backup e configurazione sicura. Le migrazioni precedenti e tabelle legacy restano.
Rollback mediante backup compatibile, non modificando manualmente il ledger SQL.
