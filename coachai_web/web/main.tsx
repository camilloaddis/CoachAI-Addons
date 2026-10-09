import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Activity = {activity_date:string;name:string;category:string;duration_min:number|null;training_load:number|null;avg_power:number|null};
type Meal = {date:string;meal_type:string;description:string;calories:number|null;protein_g:number|null;carbs_g:number|null;fat_g:number|null};
type Daily = {date:string;weight:number|null;calories_in:number|null;protein_g:number|null;carbs_g:number|null;fat_g:number|null;exercise_kcal:number|null;training_load:number|null};
type Overview = {status:string;snapshotUpdatedAt:string|null;activities:Activity[];meals:Meal[];daily:Daily[];readiness:{score:number|null;confidence:number;status:string;recommendation:string;reasons:string[];missing:string[];date:string;metrics:{ctl:number|null;atl:number|null;tsb:number|null}}};
const nf = (value:number|null|undefined,suffix='') => value === null || value === undefined ? '—' : Math.round(value).toLocaleString('it-IT')+suffix;
const date = (s:string) => {const d=new Date(s+'T12:00:00');return Number.isNaN(d.valueOf())?s:d.toLocaleDateString('it-IT',{day:'2-digit',month:'short'})};
function App(){
  const [data,setData]=useState<Overview|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const refresh=async()=>{setLoading(true);try{const r=await fetch('/api/overview',{cache:'no-store'});if(!r.ok)throw new Error('Errore HTTP '+r.status);setData(await r.json());setError('')}catch(e){setError(String(e))}finally{setLoading(false)}};
  useEffect(()=>{void refresh()},[]);
  const last=data?.daily[0];
  return <div className="shell">
    <header><div className="brand"><span className="brandmark">C</span><div><strong>Coach AI</strong><small>Performance & Nutrition</small></div></div><span className="tag">MVP · sola lettura</span></header>
    <main>
      <div className="heading"><div><p className="eyebrow">DASHBOARD</p><h1>Il tuo quadro generale</h1><p className="muted">Dati provenienti da uno snapshot SQLite. Nessuna modifica al Coach attivo.</p></div><button onClick={()=>void refresh()} disabled={loading}>{loading?'Caricamento…':'Aggiorna'}</button></div>
      {error && <div className="error" role="alert">{error}</div>}
      {data?.status==='waiting_for_snapshot' && <div className="notice">Database non ancora disponibile. Copia uno snapshot in <code>/share/coachai/cycling_coach.db</code> e aggiorna questa pagina.</div>}
      {data?.snapshotUpdatedAt && <div className="notice">Snapshot aggiornato: {new Date(data.snapshotUpdatedAt).toLocaleString('it-IT')}. Il contenuto non viene sincronizzato automaticamente.</div>}
      <section className="metrics">
        <div className="stat"><span>Readiness</span><b>{nf(data?.readiness.score,'/100')}</b><small>Confidence {nf(data?.readiness.confidence,'/100')} · {data?.readiness.status ?? 'Caricamento'}</small></div>
        <div className="stat"><span>Calorie ultimo giorno registrato</span><b>{nf(last?.calories_in,' kcal')}</b><small>{last?date(last.date):'Nessun dato'}</small></div>
        <div className="stat"><span>Attività recenti</span><b>{data?.activities.length ?? '—'}</b><small>Massimo 12 mostrate</small></div>
        <div className="stat"><span>Peso ultimo giorno registrato</span><b>{nf(last?.weight,' kg')}</b><small>Dal riepilogo giornaliero</small></div>
      </section>
      <section className="panel" aria-label="Readiness e raccomandazione">
        <h2>{data?.readiness.recommendation ?? 'Valutazione in corso'}</h2>
        <p>FTP operativa 220 W · Valutazione {data?.readiness.date ?? '—'} (Europe/Rome)</p>
        <p>CTL {nf(data?.readiness.metrics.ctl)} · ATL {nf(data?.readiness.metrics.atl)} · TSB {nf(data?.readiness.metrics.tsb)}</p>
        <ul>{data?.readiness.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul>
        {!!data?.readiness.missing.length && <details><summary>Dati mancanti e limiti della valutazione</summary><ul>{data.readiness.missing.map((r,i)=><li key={i}>{r}</li>)}</ul></details>}
      </section>
      <section className="split">
        <article className="panel"><div className="panel-title"><h2>Attività recenti</h2><span>Intervals.icu via SQLite</span></div>
          <div className="entries">{data?.activities.length ? data.activities.map((a,i)=><div className="entry" key={i}><div><strong>{a.name||'Attività'}</strong><small>{date(a.activity_date)} · {a.category||'—'}</small></div><div className="right"><strong>{nf(a.duration_min,' min')}</strong><small>{nf(a.training_load,' load')} · {nf(a.avg_power,' W')}</small></div></div>) : <p className="muted empty">Nessuna attività presente nello snapshot.</p>}</div>
        </article>
        <article className="panel"><div className="panel-title"><h2>Diario alimentare</h2><span>Ultimi pasti</span></div>
          <div className="entries">{data?.meals.length ? data.meals.map((m,i)=><div className="entry" key={i}><div><strong>{m.meal_type||'Pasto'}</strong><small>{date(m.date)} · {m.description||'—'}</small></div><div className="right"><strong>{nf(m.calories,' kcal')}</strong><small>P {nf(m.protein_g,'g')} · C {nf(m.carbs_g,'g')} · F {nf(m.fat_g,'g')}</small></div></div>) : <p className="muted empty">Nessun pasto presente nello snapshot.</p>}</div>
        </article>
      </section>
      <section className="panel"><div className="panel-title"><h2>Ultimi riepiloghi</h2><span>Fino a 30 giorni</span></div>
        <div className="tablewrap"><table><thead><tr><th>Data</th><th>Calorie introdotte</th><th>Proteine</th><th>Attività kcal</th><th>Carico</th><th>Peso</th></tr></thead><tbody>{(data?.daily||[]).map(d=><tr key={d.date}><td>{date(d.date)}</td><td>{nf(d.calories_in)}</td><td>{nf(d.protein_g,' g')}</td><td>{nf(d.exercise_kcal)}</td><td>{nf(d.training_load)}</td><td>{nf(d.weight,' kg')}</td></tr>)}</tbody></table>{!data?.daily.length&&<p className="muted empty">Nessun riepilogo giornaliero disponibile.</p>}</div>
      </section>
      <footer>Coach AI Web 0.2 · Snapshot SQLite in sola lettura · Intervals opzionale, solo GET</footer>
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
