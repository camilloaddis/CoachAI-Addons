# Coach AI Web 0.9.1

Libreria workout Intervals: normalizzatore, cache SQLite (migrazione 006), sincronizzazione manuale GET autenticata. Il catalogo importato non viene ancora usato per generare proposte. Readiness, Confidence, Planner e Rigenera restano invariati.

La nuova opzione `intervals_library_sync_enabled` è **false** per default. Nessuna nuova scrittura su Intervals. Accesso Home Assistant Ingress oppure autenticazione amministrativa per accesso diretto.

## Aggiornamento dalla 0.9.0

Prima di aggiornare, creare un backup Home Assistant che includa Coach AI Web e scaricarlo su un altro dispositivo. Annotare la versione 0.9.0 e conservare le opzioni tramite il backup, senza pubblicare token.

Al primo avvio 0.9.1, prima di applicare 006, l'app verifica l'integrità del database originale, crea uno snapshot tramite SQLite Online Backup API in `/data/backups/pre-006-*/coachai.db` e ne verifica l'integrità. Il backup è privato e persistente, separato dall'immagine aggiornata. In caso di errore l'avvio si interrompe prima della migrazione e dei worker. Non disinstallare l'add-on: la disinstallazione può cancellare /data.

## Ripristino

Per tornare alla 0.9.0, arrestare Coach AI e ripristinare il backup Home Assistant precedente comprensivo dell'add-on e dei suoi dati/configurazione. Non avviare la vecchia versione sul database già migrato a 006. Le modifiche successive al backup non saranno nel ripristino. Conservare una copia anche dello stato più recente prima di un rollback.

I backup SQLite locali sono una seconda protezione: devono essere recuperati con strumenti amministrativi ad add-on arrestato e verificati prima del ripristino. Non copiare il file SQLite mentre è aperto e non lasciare file WAL/SHM appartenenti al database sostituito. Non cancellare manualmente righe dal registro delle migrazioni.
