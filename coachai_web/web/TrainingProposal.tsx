import React from "react";
import type { Proposal } from "../server/coach/training.js";
import { WorkoutChart } from "./WorkoutChart.js";
import { categoryLabels } from "../server/coach/intent.js";
import {
  ConstraintTrace,
  FactorGroups,
  recommendationLabel,
  scoreLabel,
} from "./DecisionExplanation.js";
function LoadExplanation({p}: {p: Proposal}) {
  const t=p.loadTarget;
  if (!t) return null;
  const load=p.workout?.library?.trainingLoad;
  return <section aria-label="Carico giornaliero">
    <p>Training Load ideale: {t.target ?? 'non determinabile'}{t.target !== null && ` · banda ${t.minimum}–${t.maximum}`} · dati {t.confidence === 'measured' ? 'misurati' : 'insufficienti'}.</p>
    {load != null && <p>Workout Intervals: icu_training_load {load} · differenza dal target {t.target === null ? 'n/d' : (load-t.target).toFixed(1)} · durata {p.duration} min rispetto ai {p.config.duration} min selezionati (±10 min).</p>}
    <ul>{t.reasons.map(r=><li key={r}>{r}</li>)}</ul>
  </section>;
}
function SelectionDiagnostics({p}: {p: Proposal}) {
  const d=p.selectionDiagnostics;
  if(!d) return null;
  return <details><summary>Diagnostica selezione</summary>
    <p>Disponibili {d.available} · compatibili {d.compatible} · classificati {d.classified} · candidati finali {d.eligible} · rosa AI {d.shortlist} (massimo 8).</p>
    <p>Esclusioni: normalizzazione {d.excluded.normalization}; classificazione/sport {d.excluded.classificationOrSport}; categoria {d.excluded.category}; durata {d.excluded.duration}; intensità {d.excluded.intensity}; fase {d.excluded.phase}; carico assente {d.excluded.loadMissing ?? 0}; banda carico {d.excluded.loadBand ?? 0}; strutture duplicate {d.excluded.duplicate}; proposta precedente {d.excluded.previous}.</p>
    <p>Le esclusioni sono conteggiate in ordine di filtro, una volta per workout. La categoria principale non sostituisce il controllo dei picchi.</p>
  </details>;
}
export function TrainingProposal({ proposal: p }: { proposal: Proposal }) {
  if (!p.workout) return <article className="training-proposal" aria-label="Proposta di allenamento">
    <h3>{p.status === 'rest' ? 'Riposo' : 'Nessun workout compatibile'}</h3>
    <p role="status">{p.noWorkoutReason}</p>
    <p>Planner: {recommendationLabel(p.plannerRecommendation ?? p.recommendation)}. Categoria ammessa/richiesta: {recommendationLabel(p.recommendation)}.</p>
    <p>Modifica la richiesta con i comandi sopra oppure sincronizza la libreria da Impostazioni. Nessun workout sintetico viene generato.</p>
    <LoadExplanation p={p} /><SelectionDiagnostics p={p} /><ConstraintTrace constraints={p.constraints} />
  </article>;
  return (
    <article className="training-proposal" aria-label="Proposta di allenamento">
      <h3>{p.workout.name}</h3>
      <p className="workout-subtitle">{p.duration} min • {p.proposedCategory ? categoryLabels[p.proposedCategory] : recommendationLabel(p.recommendation)}</p>
      <WorkoutChart workout={p.workout.library?.normalized} />
      <pre className="workout-structure" aria-label="Struttura tecnica allenamento">{p.workout.structure}</pre>
    </article>
  );
}


export function TrainingInsight({ proposal: p }: { proposal: Proposal | null }) {
  if (!p) return <details className="training-insight panel collapsible-card" aria-label="Insight allenamento">
    <summary className="eyebrow card-heading">INSIGHT</summary><p className="muted">Genera una proposta per vedere le regole e i motivi della scelta.</p>
  </details>;
  const manual = p.decision?.intent.mode === "manual";
  const constraints = manual ? p.decision.advisoryConstraints : p.constraints;
  return <details className="training-insight panel collapsible-card" aria-label="Insight allenamento">
    <summary className="eyebrow card-heading">INSIGHT</summary>
    <p className="eyebrow">{manual ? "MODALITÀ MANUALE" : "MODALITÀ COACH AUTOMATICA"}</p>
    {p.advisor && <section aria-label="Motivo della scelta">
      <strong>{p.advisor.mode === "ai" ? "Scelta AI verificata" : "Consiglio locale"}</strong>
      <p>{p.advisor.explanation}</p>
    </section>}
    <p>Planner: {recommendationLabel(p.plannerRecommendation ?? p.recommendation)} · Proposta: {p.proposedCategory ? categoryLabels[p.proposedCategory] : recommendationLabel(p.recommendation)}</p>
    <p className="muted">{p.catalogNote ?? "Proposta storica dal catalogo Coach."}</p>
    <p>{p.requestSatisfied ? "Richiesta soddisfatta" : "Proposta alternativa: richiesta limitata"}</p>
    <dl className="proposal-metrics">
      <div><dt>Readiness alla generazione</dt><dd>{scoreLabel(p.readiness)}</dd></div>
      <div><dt>Confidence alla generazione</dt><dd>{scoreLabel(p.confidence)}</dd></div>
    </dl>
    <LoadExplanation p={p} />
    <h4>{manual ? "Consiglio automatico non applicato alla richiesta manuale" : "Regole applicate alla proposta automatica"}</h4>
    {constraints?.length ? <ul>{constraints.map((c, i) => <li key={c.code + i} data-rule-code={c.code}>{c.text}</li>)}</ul> : <p>Nessuna regola aggiuntiva limita questa proposta.</p>}
    {!manual && (p.decision?.warnings.length ?? 0) > 0 && <FactorGroups factors={p.decision.warnings} />}
    {p.limitingFactors.length > 0 && <section aria-label="Limiti determinanti della proposta"><h4>Motivi della proposta alternativa</h4><FactorGroups factors={p.limitingFactors} /></section>}
    <details><summary>Spiegazione tecnica completa</summary>
      <ConstraintTrace constraints={constraints ?? []} advisory={manual} />
      <SelectionDiagnostics p={p} />
      <details><summary>Dati strutturati della decisione</summary><pre>{JSON.stringify({ plannerRecommendation: p.plannerRecommendation, proposedCategory: p.proposedCategory, substitutionReason: p.substitutionReason, selection: p.selectionDiagnostics, constraints: p.constraints, decision: p.decision }, null, 2)}</pre></details>
    </details>
  </details>;
}

export function TrainingAlert({ proposal: p }: { proposal: Proposal | null }) {
  const manual = p?.decision?.intent.mode === "manual";
  const warnings = p?.decision?.warnings ?? [];
  return <details className="training-alert panel collapsible-card" aria-label="Avvisi della proposta">
    <summary className="eyebrow card-heading">ALERT</summary>
    {manual && <p>Richiesta manuale: {categoryLabels[p.decision.intent.mode === "manual" ? p.decision.intent.category : "endurance"]}. Consiglio automatico: {recommendationLabel(p.decision.automaticRecommendation)}.</p>}
    {manual && p.decision.exceedsRecommendation && <p className="notice manual-warning" role="status">La categoria richiesta supera il consiglio automatico. La richiesta è rispettata; gli avvisi restano validi.</p>}
    {warnings.length ? <FactorGroups factors={warnings} /> : <p className="muted">{p ? "Nessun avviso aggiuntivo per questa proposta." : "Genera una proposta per vedere gli avvisi del coach."}</p>}
  </details>;
}
