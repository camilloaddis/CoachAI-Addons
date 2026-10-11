import React from "react";
import type { Proposal } from "../server/coach/training.js";
import { categoryLabels } from "../server/coach/intent.js";
import {
  ConstraintTrace,
  FactorGroups,
  recommendationLabel,
  scoreLabel,
} from "./DecisionExplanation.js";
export function TrainingProposal({
  proposal: p,
  selected,
  onRegenerate,
  onSelect,
}: {
  proposal: Proposal;
  selected: boolean;
  onRegenerate: () => void;
  onSelect: () => void;
}) {
  const manual = p.decision?.intent.mode === "manual";
  const warnings = p.decision?.warnings ?? [];
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
        <button type="button" onClick={onSelect}>
          {selected ? "Selezionato" : "Seleziona"}
        </button>
      </div>
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
              { constraints: p.constraints, decision: p.decision },
              null,
              2,
            )}
          </pre>
        </details>
      </details>
    </article>
  );
}
