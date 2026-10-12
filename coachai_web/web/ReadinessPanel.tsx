import React from "react";
import type { Constraint, Result } from "../server/readiness/types.js";
import {
  ConstraintTrace,
  FactorGroups,
  recommendationLabel,
  scoreLabel,
} from "./DecisionExplanation.js";

type Prescription = {
  recommendation: string;
  constraints: Constraint[];
  limitingFactors: Constraint[];
};
const availabilityLabels = [
  "Riposo",
  "Recupero",
  "Endurance",
  "Tempo",
  "Sweet Spot / soglia",
  "VO2max",
];
const metric = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString("it-IT", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
export function ReadinessPanel({
  readiness: r,
  prescription,
}: {
  readiness: Result | null;
  prescription?: Prescription;
}) {
  const constraints = prescription?.constraints ?? r?.constraints ?? [];
  const availability = r?.physiology?.availability;
  const quality = (r?.factors ?? []).filter((f) =>
    f.code.startsWith("confidence_"),
  );
  const completeness = {
    complete: "Valutazione completa",
    provisional: "Valutazione provvisoria",
    unavailable: "Non valutabile",
  }[r?.completeness ?? "unavailable"];
  const physiologicalText =
    !r || r.score === null
      ? "Dati insufficienti per valutare la disponibilità"
      : r.assessmentState === "insufficient_recovery"
        ? "Segnali di recupero insufficiente: privilegiare il recupero."
        : r.completeness !== "complete"
          ? "Valutazione parziale: dati mancanti o incerti, senza affaticamento presunto."
          : "Valutazione completa.";
  return (
    <section
      className="panel readiness"
      aria-label="Readiness, Confidence e Planner"
    >
      <p className="eyebrow">OGGI · {r?.date ?? "valutazione in corso"}</p>
      <div className="decision-overview">
        <section aria-label="Recupero fisiologico">
          <h2>Readiness</h2>
          <div className="score">
            {r?.score == null ? "—" : Math.round(r.score)}
            <span>/100</span>
          </div>
          <p className="muted">{physiologicalText}</p>
          <div className="metrics">
        {(
          [
            ["ctl", "CTL · forma"],
            ["atl", "ATL · fatica"],
            ["tsb", "TSB · equilibrio"],
          ] as const
        ).map(([key, label]) => (
          <div className="stat" key={key}>
            <span>{label}</span>
            <b>{metric(r?.metrics[key])}</b>
          </div>
        ))}
      </div>  
          <p>
            Disponibilità fisiologica:{" "}
            <strong>
              {availability == null
                ? "Non valutabile"
                : availabilityLabels[availability]}
            </strong>
          </p>
          <p>Confidence:{" "}
            <strong>
              {scoreLabel(r?.confidence)}
            </strong>
          </p>
          <p>Allenamento:{" "}
            <strong>
                {r
                ? recommendationLabel(
                    prescription?.recommendation ?? r.recommendation,
                  )
                : "Valutazione in corso"}
            </strong>
          </p>
          <details>
            <summary>Motivazioni</summary>

                  <FactorGroups
          factors={constraints.filter((c) => c.applied || c.blocksRequested)}
        />
        {!constraints.some((c) => c.applied || c.blocksRequested) && (
          <p className="muted">
            Nessun limite aggiuntivo rilevato rispetto al punteggio.
          </p>
        )}
        </details>
              <details>
        <summary>Spiegazione tecnica completa e dati mancanti</summary>
        <h3>Fattori osservati</h3>
        <FactorGroups factors={r?.factors ?? []} technical />
        <h3>Correzioni fisiologiche del punteggio</h3>
        <p>
          Prima delle correzioni: {scoreLabel(r?.physiology?.rawScore)} ·
          Readiness finale: {scoreLabel(r?.score)}
        </p>
        <ul>
          {r?.physiology?.adjustments.map((a, i) => (
            <li key={a.code + i}>
              {a.reason}
              <small className="technical-code">
                {a.code} · massimo {a.maximum} · {a.before ?? "—"} →{" "}
                {a.after ?? "—"}
                {a.applied
                  ? " · correzione applicata"
                  : " · nessuna ulteriore correzione"}
              </small>
            </li>
          ))}
        </ul>
        <h3>Regole automatiche, in ordine</h3>
        <ConstraintTrace constraints={constraints} />
      </details>
        </section>
      </div>
    </section>
  );
}
