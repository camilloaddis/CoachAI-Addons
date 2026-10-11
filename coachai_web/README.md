# Coach AI Web 1.0.0

Versione candidata per Home Assistant: allenamento, libreria workout Intervals.icu, diario alimentare e trend 7/30 giorni.

## Novità rispetto alla 0.9.1

- Selezione prioritaria degli allenamenti dalla libreria Intervals.icu sincronizzata in cache, con fallback statico dichiarato.
- Rigenera propone alternative compatibili anche tra sessioni/browser.
- Stato della libreria e sincronizzazione manuale nelle Impostazioni. Aggiornamento automatico ogni 6 ore solo quando `intervals_library_sync_enabled` è abilitata; default `false`.
- Consigli di allenamento AI quando disponibili, con comportamento di fallback.
- Trend 7/30 giorni con grafici, copertura dei dati, sintesi AI memorizzata e fallback locale.
- Il bilancio energetico non viene stimato senza TDEE affidabile.

La connessione Intervals.icu resta in sola lettura. Non sono previste modifiche allo schema SQLite per i trend.

## Prima di aggiornare dalla 0.9.1

1. Verificare che la release 1.0.0 abbia superato test completi, typecheck, build, controlli di distribuzione e smoke test di aggiornamento.
2. Creare e scaricare un backup Home Assistant che includa Coach AI Web, dati e configurazione. Non pubblicare token o backup.
3. Conservare una copia del database e annotare la versione installata e le opzioni attive.
4. Pubblicare il pacchetto nel repository di distribuzione `CoachAI-Addons` solo dopo approvazione esplicita.

Non disinstallare l'add-on per aggiornare: la disinstallazione può eliminare dati persistenti.

## Ripristino

In caso di problemi, arrestare l'add-on e ripristinare il backup Home Assistant precedente completo di dati e configurazione. Non avviare una versione precedente su un database con migrazioni incompatibili. Un ripristino comporta la perdita delle modifiche successive al backup.

## Stato della release

Questa PR prepara la versione nel repository sorgente. **Non pubblica la release, non aggiorna `CoachAI-Addons` e non effettua deploy.** Le verifiche finali e la pubblicazione richiedono un passaggio separato.
