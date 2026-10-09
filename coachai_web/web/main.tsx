import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Activity = {activity_date:string;name:string;category:string;duration_min:number|null;training_load:number|null;avg_power:number|null};
type Meal = {date:string;meal_type:string;description:string;calories:number|null;protein_g:number|null;carbs_g:number|null;fat_g:number|null};
type Daily = {date:string;weight:number|null;calories_in:number|null;protein_g:number|null;carbs_g:number|null;fat_g:number|null;exercise_kcal:number|null;training_load:number|null};
type Overview = {status:string;snapshotUpdatedAt:string|null;snapshotVerified:boolean;history:{available:boolean;limitation:string;entries:{date:string;observed_at:string;score:number|null;confidence:number;recommendation:string}[]};activities:Activity[];meals:Meal[];daily:Daily[];readiness:{score:number|null;confidence:number;status:string;assessmentState:string;recommendation:string;reasons:string[];missing:string[];date:string;metrics:{ctl:number|null;atl:number|null;tsb:number|null}}};
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
    <header><div className="brand"><span className="brandmark">C</span><div><strong>Coach AI</strong><small>Performance & Nutrition</small></div></div><span className="tag">Il tuo coach quotidiano</span></header>
    <main>
      <div className="heading"><div><p className="eyebrow">DASHBOARD</p><h1>Come allenarti oggi</h1><p className="muted">Recupero e carico guidano la proposta. I dati mancanti riducono l’affidabilità.</p></div><button onClick={()=>void refresh()} disabled={loading}>{loading?'Caricamento…':'Aggiorna'}</button></div>
      {error && <div className="error" role="alert">{error}</div>}
      {data?.status==='waiting_for_snapshot' && <div className="notice">Snapshot non ancora disponibile. La valutazione resta prudente finché la sincronizzazione non è configurata.</div>}
      {data?.snapshotUpdatedAt && <div className="notice">Ultimo snapshot: {new Date(data.snapshotUpdatedAt).toLocaleString('it-IT',{timeZone:'Europe/Rome'})} (Europe/Rome). {data.snapshotVerified ? 'Sincronizzazione verificata.' : 'Data del file; sincronizzazione non verificata.'}</div>}
      <section className="panel readiness" aria-label="Readiness e raccomandazione">
        <div className="readiness-top"><div><p className="eyebrow">READINESS · {data?.readiness.date ?? 'oggi'}</p><div className="score">{nf(data?.readiness.score)}<span>/100</span></div><p className="muted">{!data || data.readiness.assessmentState === 'missing_data' ? 'Dati insufficienti per valutare la disponibilità' : data.readiness.assessmentState === 'insufficient_recovery' ? 'Recupero da privilegiare · valutazione prudenziale' : 'Allenamento possibile entro i limiti indicati'}</p></div>
        <div className="recommendation"><p className="eyebrow">PROPOSTA DI OGGI</p><h2>{data?.readiness.recommendation ?? 'Valutazione in corso'}</h2><p>Affidabilità (confidence) <strong>{nf(data?.readiness.confidence,'/100')}</strong></p><p className="muted">{data?.readiness.status} · FTP operativa 220 W</p></div></div>
        <div className="metrics"><div className="stat"><span>CTL · forma</span><b>{nf(data?.readiness.metrics.ctl)}</b></div><div className="stat"><span>ATL · fatica</span><b>{nf(data?.readiness.metrics.atl)}</b></div><div className="stat"><span>TSB · equilibrio</span><b>{nf(data?.readiness.metrics.tsb)}</b></div></div>
        <p className="muted">La raccomandazione tiene conto di carico, recupero e copertura dei dati. Un punteggio alto con confidence bassa non autorizza allenamenti intensi.</p>
        <details><summary>Motivazioni, dati mancanti e diagnostica</summary><ul>{data?.readiness.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul><h3>Dati mancanti e limiti</h3><ul>{data?.readiness.missing.map((r,i)=><li key={i}>{r}</li>)}</ul></details>
      </section>
      <section className="panel history"><h2>Andamento Readiness</h2><p className="muted">{data?.history.limitation ?? 'Caricamento delle valutazioni registrate…'}</p>
        {!data?.history.available || (data.history.entries.filter(e=>e.score!==null).length < 2) ? <p>Storico non ancora sufficiente per mostrare un andamento. Sono registrate solo le valutazioni effettuate da questa versione.</p> : <div className="tablewrap"><table><thead><tr><th>Giorno</th><th>Readiness</th><th>Confidence</th><th>Proposta</th></tr></thead><tbody>{data.history.entries.map(e=><tr key={e.date}><td>{date(e.date)}</td><td><span className="trend-bar" style={{width:`${e.score ?? 0}%`}} />{nf(e.score,'/100')}</td><td>{nf(e.confidence,'/100')}</td><td>{e.recommendation}</td></tr>)}</tbody></table></div>}
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
      <footer>Coach AI Web 0.3.0 · Snapshot SQLite in sola lettura · Intervals opzionale, solo GET</footer>
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
