import React, { useState } from "react";
import type { Publication } from "../server/coach/calendar-publication.js";
import type { Proposal } from "../server/coach/training.js";
import { categoryLabels } from "../server/coach/intent.js";
import {
  ConstraintTrace,
  FactorGroups,
  recommendationLabel,
  scoreLabel,
} from "./DecisionExplanation.js";
function SelectionDiagnostics({p}: {p: Proposal}) {
  const d=p.selectionDiagnostics;
  if(!d) return null;
  return <details><summary>Diagnostica selezione</summary>
    <p>Disponibili {d.available} · compatibili {d.compatible} · classificati {d.classified} · candidati finali {d.eligible} · rosa AI {d.shortlist} (massimo 8).</p>
    <p>Esclusioni: normalizzazione {d.excluded.normalization}; classificazione/sport {d.excluded.classificationOrSport}; categoria {d.excluded.category}; durata {d.excluded.duration}; intensità {d.excluded.intensity}; fase {d.excluded.phase}; strutture duplicate {d.excluded.duplicate}; proposta precedente {d.excluded.previous}.</p>
    <p>Le esclusioni sono conteggiate in ordine di filtro, una volta per workout. La categoria principale non sostituisce il controllo dei picchi.</p>
  </details>;
}
export function TrainingProposal({
  proposal: p,
  publication,
  enabled,
  sending,
  onRegenerate,
  onPublish,
}: {
  proposal: Proposal;
  publication: Publication | null;
  enabled: boolean;
  sending: boolean;
  onRegenerate: () => void;
  onPublish: (verify: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const status = sending || publication?.status === "sending" ? "Invio in corso" : publication?.status === "scheduled" ? "Programmato" : publication ? "Errore" : "Proposto";
  const manual = p.decision?.intent.mode === "manual";
  const warnings = p.decision?.warnings ?? [];
  if (!p.workout) return <article className="training-proposal" aria-label="Proposta di allenamento">
    <h3>{p.status === 'rest' ? 'Riposo' : 'Nessun workout compatibile'}</h3>
    <p role="status">{p.noWorkoutReason}</p>
    <p>Planner: {recommendationLabel(p.plannerRecommendation ?? p.recommendation)}. Categoria ammessa/richiesta: {recommendationLabel(p.recommendation)}.</p>
    <p>Modifica la richiesta con i comandi sopra oppure sincronizza la libreria da Impostazioni. Nessun workout sintetico viene generato.</p>
    <button type="button" onClick={onRegenerate}>Rivaluta la richiesta</button>
    <SelectionDiagnostics p={p} /><ConstraintTrace constraints={p.constraints} />
  </article>;
  return (
    <article className="training-proposal" aria-label="Proposta di allenamento">
      <p className="eyebrow">
        {manual ? "MODALITÀ MANUALE" : "MODALITÀ COACH AUTOMATICA"}
      </p>
      <h3>{p.workout.name}</h3>
      {p.advisor && <section aria-label="Motivo della scelta">
        <strong>{p.advisor.mode === "ai" ? "Scelta AI verificata" : "Consiglio locale"}</strong>
        <p>{p.advisor.explanation}</p>
      </section>}
      <p>Planner: {recommendationLabel(p.plannerRecommendation ?? p.recommendation)} · Proposta: {p.proposedCategory ? categoryLabels[p.proposedCategory] : recommendationLabel(p.recommendation)}</p>
      <p className="muted">{p.catalogNote ?? "Proposta storica dal catalogo Coach."}</p>
      {p.workout.library && <p className="muted">Cache aggiornata: {new Date(p.workout.library.syncedAt).toLocaleString("it-IT", { timeZone: "Europe/Rome" })}. Disponibile anche senza collegamento a Intervals.</p>}
      <p>
        {p.requestSatisfied
          ? "Richiesta soddisfatta"
          : "Proposta alternativa: richiesta limitata"}{" "}
        · {p.duration} min · {recommendationLabel(p.recommendation)}
      </p>
      <p>
        {p.decision?.intent.mode === "manual"
          ? `Richiesta manuale: ${categoryLabels[p.decision.intent.category]}. Consiglio automatico: ${recommendationLabel(p.decision.automaticRecommendation)}.`
          : "Proposta automatica secondo recupero e piano."}
      </p>
      <dl className="proposal-metrics">
        <div>
          <dt>Readiness alla generazione</dt>
          <dd>{scoreLabel(p.readiness)}</dd>
        </div>
        <div>
          <dt>Confidence alla generazione</dt>
          <dd>{scoreLabel(p.confidence)}</dd>
        </div>
      </dl>
      {manual && p.decision.exceedsRecommendation && (
        <p className="notice manual-warning" role="status">
          La categoria richiesta supera il consiglio automatico. La richiesta è
          rispettata; gli avvisi restano validi.
        </p>
      )}
      {warnings.length > 0 && (
        <section aria-label="Avvisi della proposta">
          <h4>Avvisi · non sostituiscono la richiesta</h4>
          <FactorGroups factors={warnings} />
        </section>
      )}
      {p.limitingFactors.length > 0 && (
        <section aria-label="Limiti determinanti della proposta">
          <h4>Motivi della proposta alternativa</h4>
          <FactorGroups factors={p.limitingFactors} />
        </section>
      )}
      <details><summary>Dettagli allenamento</summary>
      <pre
        className="workout-structure"
        aria-label="Struttura tecnica allenamento"
      >
        {p.workout.structure}
      </pre></details>
      <div className="actions">
        <button type="button" onClick={onRegenerate}>
          Rigenera
        </button>
        <button type="button" disabled={!p.workout.library || !enabled || sending || p.duration <= 0 || (!!publication && !publication.retryable)} onClick={() => setConfirming(true)}>Aggiungi a Intervals</button>
        {publication?.status === "unknown" && <button type="button" onClick={() => onPublish(true)}>Verifica esito</button>}
      </div>
      <p role="status">{status} · Data della proposta: {p.date}</p>
      {!enabled && <p className="muted">Abilita intervals_calendar_write_enabled nelle opzioni dell’add-on per programmare allenamenti.</p>}
      {publication?.status === "scheduled" && <p>Allenamento programmato per {publication.date} · ID Intervals: {publication.remoteId}. Non risulta eseguito.</p>}
      {publication?.status === "error" && <p role="alert">Intervals ha rifiutato la richiesta. Controlla credenziali e permesso calendario; puoi confermare un nuovo tentativo.</p>}
      {publication?.status === "unknown" && <p role="alert">Esito non verificato: l’allenamento potrebbe essere già programmato. Nessun reinvio è consentito. Usa Verifica esito o controlla manualmente il calendario Intervals.</p>}
      {confirming && <section aria-label="Conferma pubblicazione">
        <p>Aggiungere «{p.workout.name}» al calendario Intervals per il giorno {p.date}?</p>

        <button type="button" onClick={() => { setConfirming(false); onPublish(false); }}>Conferma aggiunta</button>
        <button type="button" onClick={() => setConfirming(false)}>Annulla</button>
      </section>}
      <SelectionDiagnostics p={p} />
      <details>
        <summary>Spiegazione tecnica completa</summary>
        <h4>
          {manual
            ? "Consiglio automatico non applicato alla richiesta manuale"
            : "Regole applicate alla proposta automatica"}
        </h4>
        <ConstraintTrace
          constraints={manual ? p.decision.advisoryConstraints : p.constraints}
          advisory={manual}
        />
        <details>
          <summary>Dati strutturati della decisione</summary>
          <pre>
            {JSON.stringify(
              { plannerRecommendation: p.plannerRecommendation, proposedCategory: p.proposedCategory, substitutionReason: p.substitutionReason, selection: p.selectionDiagnostics, constraints: p.constraints, decision: p.decision },
              null,
              2,
            )}
          </pre>
        </details>
      </details>
    </article>
  );
}
