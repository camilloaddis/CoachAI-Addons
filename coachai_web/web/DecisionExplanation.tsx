import React from "react";
import type { Constraint, Factor } from "../server/readiness/types.js";

const groups: { key: Factor["category"]; label: string }[] = [
  { key: "physiology", label: "Recupero fisiologico" },
  { key: "load", label: "Carico misurato" },
  { key: "activity", label: "Attività eseguite" },
  { key: "feedback", label: "Feedback e contesto temporale" },
  { key: "data", label: "Qualità e disponibilità dei dati" },
  { key: "schedule", label: "Calendario" },
  { key: "plan", label: "Piano e distribuzione degli stimoli" },
  { key: "request", label: "Richiesta" },
];
const markers: Record<Factor["polarity"], string> = {
  positive: "✓ Positivo",
  negative: "! Negativo",
  neutral: "• Neutro",
  uncertain: "? Incerto",
};
export const recommendationLabel = (value: string | null | undefined) =>
  ({
    riposo: "Riposo",
    recupero: "Recupero",
    endurance: "Endurance",
    tempo: "Tempo",
    "sweet spot/soglia": "Sweet Spot / soglia",
    VO2max: "VO2max",
  })[value ?? ""] ??
  value ??
  "Non valutabile";
export const scoreLabel = (value: number | null | undefined) =>
  value == null ? "—" : `${Math.round(value)}/100`;

/** Presentation only: category, polarity and evidence come from structured fields. */
export function FactorGroups({
  factors,
  technical = false,
}: {
  factors: Factor[];
  technical?: boolean;
}) {
  const unique = [
    ...new Map(factors.map((f) => [`${f.code}:${f.text}`, f])).values(),
  ];
  return (
    <div className="factor-groups">
      {groups.map((group) => {
        const items = unique.filter((f) => f.category === group.key);
        return items.length ? (
          <section key={group.key} aria-label={group.label}>
            <h4>{group.label}</h4>
            <ul>
              {items.map((f, i) => (
                <li key={f.code + i} data-factor-code={f.code}>
                  <span className={`factor-marker ${f.polarity}`}>
                    {markers[f.polarity]}
                  </span>
                  {f.text}
                  {technical && (
                    <small className="technical-code">
                      {f.code} · {f.evidence}
                    </small>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null;
      })}
    </div>
  );
}

export function ConstraintTrace({
  constraints,
  advisory = false,
}: {
  constraints: Constraint[];
  advisory?: boolean;
}) {
  return (
    <ol className="constraint-trace">
      {constraints.map((c, i) => (
        <li key={c.code + i} data-rule-code={c.code}>
          {c.text}
          <small>
            {c.source} · {c.code} · plafond {c.ceiling} · {c.before} → {c.after}
            {advisory
              ? " · solo consiglio automatico, non applicato alla richiesta manuale"
              : c.blocksRequested
                ? " · determinante per la richiesta"
                : c.applied
                  ? " · riduzione applicata"
                  : " · nessuna ulteriore riduzione"}
            {advisory &&
              (c.applied
                ? " · riduzione nel calcolo automatico"
                : " · nessuna ulteriore riduzione nel calcolo automatico")}
          </small>
        </li>
      ))}
    </ol>
  );
}
