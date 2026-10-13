import React, { useEffect, useState } from 'react';
import { apiFetch } from './api.js';
type Status = { enabled: boolean; configured: boolean; classifiable?: number; compatible?: number; incompatible?: number; lastSuccess: string | null; error?: string | null; countsCurrent?: boolean };
type Sample = { workoutId: number; name: string; compatible: boolean; issues: { code: string; path: string }[] };
type Diagnostics = { available: number; compatible: number; incompatible: number; classifiable: number;
  groups: { code: string; workouts: number; occurrences: number; paths: { path: string; workouts: number }[]; sample: Sample | null }[];
  workouts: Sample[]; limitation: string };
const issueLabels: Record<string, string> = { missing_data: 'Dati mancanti', invalid_value: 'Valori non validi', unsupported_format: 'Formato non supportato', duration_mismatch: 'Durate non coerenti', complexity_limit: 'Struttura troppo complessa' };
export function LibrarySettings({ active }: { active: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [confirmRead, setConfirmRead] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState('');
  async function inspect() {
    setDiagnosticBusy(true); setDiagnosticError(''); setConfirmRead(false);
    try {
      const response = await apiFetch('/api/workout-library/diagnostics');
      if (!response.ok) throw Error();
      const data: Diagnostics = await response.json();
      setDiagnostics(data); setSelectedId(String(data.workouts.find(w => !w.compatible)?.workoutId ?? data.workouts[0]?.workoutId ?? ''));
    } catch { setDiagnosticError('Diagnostica non disponibile. Controlla il collegamento Intervals.'); }
    finally { setDiagnosticBusy(false); }
  }
  async function exportSelected() {
    if (!confirmRead || !selectedId) return;
    setDiagnosticBusy(true); setDiagnosticError('');
    try {
      const response = await apiFetch('/api/workout-library/diagnostics/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workoutId: Number(selectedId), confirmRead: true }),
      });
      if (!response.ok) {
        setDiagnosticError(response.status === 429 ? 'Attendi almeno un minuto prima di una nuova lettura.' : 'Export non disponibile. Il workout potrebbe essere cambiato o Intervals non raggiungibile.');
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `workout-diagnostic-${selectedId}.json`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setConfirmRead(false);
    } catch { setDiagnosticError('Export non disponibile. Riprova più tardi.'); }
    finally { setDiagnosticBusy(false); }
  }
  const selected = diagnostics?.workouts.find(w => String(w.workoutId) === selectedId);
  async function load(sync = false) {
    setBusy(true);
    if (sync) { setDiagnostics(null); setConfirmRead(false); }
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
    <button type="button" disabled={busy || diagnosticBusy} onClick={() => void inspect()}>Mostra motivi di incompatibilità</button>
    {diagnostics && <section aria-label="Diagnostica libreria">
      <p>Disponibili: {diagnostics.available} · compatibili: {diagnostics.compatible} · non compatibili: {diagnostics.incompatible} · classificabili: {diagnostics.classifiable}.</p>
      {diagnostics.groups.filter(g => g.workouts > 0).map(g => <div key={g.code}>
        <p>{issueLabels[g.code] ?? g.code} ({g.code}): {g.workouts} workout, {g.occurrences} segnalazioni. Campione: ID {g.sample?.workoutId}, {g.sample?.name}.</p>
        <ul>{g.paths.map(p => <li key={p.path}><code>{p.path}</code>: {p.workouts} workout</li>)}</ul>
      </div>)}
      <p>{diagnostics.limitation}</p>
      {diagnostics.workouts.length > 0 && <>
        <label>Workout da esaminare <select value={selectedId} onChange={event => { setSelectedId(event.target.value); setConfirmRead(false); }}>
          {diagnostics.workouts.map(w => <option key={w.workoutId} value={w.workoutId}>ID {w.workoutId} · {w.name}</option>)}
        </select></label>
        {selected && <p>{selected.issues.length ? selected.issues.map(i => `${i.code}: ${i.path}`).join(' · ') : 'Nessun errore di normalizzazione salvato.'}</p>}
        <p>La copia salvata può essere incompleta. L’export legge di nuovo la libreria Intervals e scarica solo il workout scelto, con dati personali e note mascherati. Non modifica gli allenamenti.</p>
        <label><input type="checkbox" checked={confirmRead} onChange={event => setConfirmRead(event.target.checked)} /> Autorizzo questa nuova lettura da Intervals per il workout scelto.</label>
        <button type="button" disabled={diagnosticBusy || busy || !confirmRead || !selectedId || !status?.configured} onClick={() => void exportSelected()}>Scarica esempio diagnostico</button>
      </>}
    </section>}
    {diagnosticError && <p role="status">{diagnosticError}</p>}
  </section>;
}
