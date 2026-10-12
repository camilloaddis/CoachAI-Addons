import React, { useEffect, useState } from 'react';
import { apiFetch } from './api.js';
import type { TrendReport, TrendSummary } from '../server/coach/trends.js';
const value = (n: number | null, unit = '') => n === null ? 'n/d' : `${Math.round(n * 10) / 10}${unit}`;
function MetricChart({ data, metric, label, unit }: { data: TrendReport; metric: 'calories' | 'protein' | 'weight'; label: string; unit: string }) {
  const values = data.rows.map(r => r[metric]);
  const present = values.filter((n): n is number => n !== null);
  if (!present.length) return <p>{label}: nessun dato nel periodo.</p>;
  const max = Math.max(...present, 1), width = 600 / data.days;
  return <figure className="trend-chart"><figcaption>{label} · {unit} · spazi vuoti = dati mancanti</figcaption>
    <svg viewBox="0 0 600 120" role="img" aria-label={`${label}, valori giornalieri disponibili nella tabella`}>
      {values.map((n,i) => n === null ? null : <rect key={i} x={i * width + 2} y={110 - n / max * 100} width={Math.max(1,width-4)} height={Math.max(1,n/max*100)} fill="currentColor"><title>{data.rows[i].date}: {value(n, ` ${unit}`)}</title></rect>)}
    </svg>
  </figure>;
}
export function TrendsPanel({ active, revision }: { active: boolean; revision: unknown }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<TrendReport | null>(null);
  const [summary, setSummary] = useState<TrendSummary | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = React.useRef(0);
  useEffect(() => {
    if (!active) return;
    const version = ++generation.current, controller = new AbortController();
    setData(null); setSummary(null); setError(''); setBusy(false);
    void (async () => {
      try {
        const response = await apiFetch(`/api/trends?days=${days}`, { signal: controller.signal });
        if (!response.ok) throw Error();
        const report = await response.json();
        if (generation.current === version) setData(report);
      } catch { if (!controller.signal.aborted && generation.current === version) setError('Trend non disponibili. Riprova riaprendo questa sezione.'); }
    })();
    return () => { controller.abort(); generation.current++; };
  }, [active, days, revision]);
  async function summarize() {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/trends/summary?days=${days}`, { method: 'POST' });
      if (!response.ok) throw Error();
      const result = await response.json();
      if (version === generation.current) setSummary(result);
    } catch { if (version === generation.current) setError('Sintesi AI non disponibile. Il riepilogo locale resta consultabile.'); }
    finally { if (version === generation.current) setBusy(false); }
  }
  return <section id="workspace-trends" hidden={!active} aria-label="Trend del periodo">
    <h2>Il tuo andamento</h2>
    <div className="actions" role="group" aria-label="Periodo dei trend">
      {([7,30] as const).map(n => <button key={n} aria-pressed={days === n} onClick={() => setDays(n)}>{n} giorni</button>)}
    </div>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Caricamento trend…</p>}
    {data && <>
      <p>{data.start} → {data.end} · oggi escluso: i dati alimentari possono essere ancora parziali.</p>
      <div className="trend-cards">
        <article><h3>Calorie registrate</h3><strong>{value(data.metrics.calories.average, ' kcal/giorno')}</strong><p>{data.metrics.calories.observedDays}/{days} giorni con dati</p></article>
        <article><h3>Proteine</h3><strong>{value(data.metrics.protein.average, ' g/giorno')}</strong><p>{data.metrics.protein.observedDays}/{days} giorni con dati</p></article>
        <article><h3>Peso medio</h3><strong>{value(data.metrics.weight.average, ' kg')}</strong><p>{data.metrics.weight.observedDays} misure · prima/ultima: {value(data.weightChange, ' kg')}</p></article>
        <article><h3>Attività</h3><strong>{value(data.metrics.minutes.total, ' minuti')}</strong><p>{value(data.metrics.exerciseKcal.total, ' kcal')} registrate · copertura {data.activityDays}/{days} giorni</p></article>
      </div>
      <p className="muted">Le medie usano solo giorni con dati: n/d non significa zero. Pasti non registrati e stime nutrizionali rendono l’apporto incerto.</p>
      <div className="trend-charts"><MetricChart data={data} metric="calories" label="Calorie registrate" unit="kcal" /><MetricChart data={data} metric="protein" label="Proteine registrate" unit="g" /><MetricChart data={data} metric="weight" label="Peso misurato" unit="kg" /></div>
      <h3>Bilancio energetico</h3><p>{data.facts.find(f => f.id === 'balance')?.text}</p>
      <h3>{summary?.mode === 'ai' ? 'Sintesi AI · fatti verificati' : 'Sintesi del periodo'}</h3>
      <ul>{(summary?.highlights ?? data.facts.filter(f => ['food','weight','activity'].includes(f.id)).map(f => f.text)).map((text,i) => <li key={i}>{text}</li>)}</ul>
      {summary && <p className="muted">{summary.mode === 'ai' ? 'L’AI ha selezionato i punti salienti; valori e spiegazioni sono verificati dal server.' : 'Riepilogo locale: AI disabilitata, dati insufficienti o risposta non disponibile.'}</p>}
      <button onClick={() => void summarize()} disabled={busy}>{busy ? 'Preparazione sintesi…' : 'Sintesi AI del periodo'}</button>
      <details><summary>Dati giornalieri e fonti</summary>
        <p>{Object.values(data.sources).join(' · ')}</p>
        <div className="trend-table"><table><caption>Dati registrati · ultimi {days} giorni precedenti</caption>
          <thead><tr><th>Giorno</th><th>kcal</th><th>Proteine g</th><th>Peso kg</th><th>Attività min</th><th>Attività kcal</th><th>Pasti registrati</th></tr></thead>
          <tbody>{data.rows.map(r => <tr key={r.date}><th scope="row">{r.date}</th><td>{value(r.calories)}</td><td>{value(r.protein)}</td><td>{value(r.weight)}</td><td>{value(r.minutes)}</td><td>{value(r.exerciseKcal)}</td><td>{r.recordedMeals}</td></tr>)}</tbody>
        </table></div>
        <p>La copertura attività indica un’enumerazione riuscita, non garantisce che calorie o potenza siano misurate. Nessuna interpolazione del peso e nessuna stima di TDEE da dati legacy non verificati.</p>
      </details>
    </>}
  </section>;
}
