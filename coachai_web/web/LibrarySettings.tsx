import React, { useEffect, useState } from 'react';
import { apiFetch } from './api.js';
type Status = { enabled: boolean; configured: boolean; classifiable?: number; compatible?: number; incompatible?: number; lastSuccess: string | null; error?: string | null; countsCurrent?: boolean };
export function LibrarySettings({ active }: { active: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(sync = false) {
    setBusy(true);
    try {
      const response = await apiFetch('/api/workout-library/' + (sync ? 'sync' : 'status'), { method: sync ? 'POST' : 'GET' });
      if (!response.ok) throw Error('Sincronizzazione non disponibile. Riprova più tardi o controlla la configurazione.');
      const data = await response.json();
      setStatus(data); setError(data.error ? 'Ultimo tentativo non riuscito; i workout già acquisiti restano disponibili.' : '');
    } catch { setError('Libreria non disponibile. Controlla il collegamento Intervals nelle opzioni dell’add-on.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (active) void load(); }, [active]);
  return <section className="panel" aria-label="Libreria Intervals">
    <h2>Libreria workout Intervals</h2>
    <p>{status?.configured ? 'Collegamento configurato' : 'Collegamento da configurare nelle opzioni sicure dell’add-on'}</p>
    <p>{status?.enabled ? 'Aggiornamento automatico ogni 6 ore, con gestione degli errori.' : 'Sincronizzazione disabilitata: abilita intervals_library_sync_enabled nelle opzioni dell’add-on.'}</p>
    <p>Ultimo aggiornamento: {status?.lastSuccess ? new Date(status.lastSuccess).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : 'non disponibile'}.</p>
    <p>Formati compatibili: {status?.countsCurrent ? status.compatible : '—'} · non compatibili: {status?.countsCurrent ? status.incompatible : '—'}. Workout ciclistici classificabili: {status?.classifiable ?? "—"}. La selezione verifica anche durata e potenza.</p>
    <button type="button" disabled={busy || !status?.enabled || !status?.configured} onClick={() => void load(true)}>{busy ? 'Aggiornamento…' : 'Sincronizza libreria'}</button>
    {error && <p role="status">{error}</p>}
  </section>;
}
