import React, { useState } from "react";
import type { TrainingIntent } from "../server/readiness/types.js";

const choices = [
  ["tempo", "Tempo", "tempo"],
  ["ss", "SweetSpot", "sweet_spot"],
  ["soglia", "Soglia", "threshold"],
  ["vo2max", "VO2 Max", "vo2max"],
  ["endurance", "Endurance", "endurance"],
  ["forza", "Forza", "strength"],
  ["recupero", "Recupero", "recovery"],
  ["riposo", "Riposo", "rest"],
] as const;

export function TrainingMode({ busy, onGenerate, onAccept, canAccept, scheduled }: {
  busy: boolean;
  onGenerate: (request: string, intent: TrainingIntent) => void;
  onAccept: () => void;
  canAccept: boolean;
  scheduled: boolean;
}) {
  const [mode, setMode] = useState("automatic");
  function generate() {
    const choice = choices.find(([, , category]) => category === mode);
    if (choice) onGenerate(choice[0], { mode: "manual", category: choice[2] });
    else onGenerate("allenamento", { mode: "automatic", preference: "recommended" });
  }
  return <>
    <h3 className="eyebrow card-heading">ALLENAMENTO</h3>
    <label className="training-mode-options">
      <span>Modalità</span>
      <select value={mode} onChange={e => setMode(e.target.value)} disabled={busy}>
        <option value="automatic">AI COACH</option>
        {choices.map(([, label, category]) => <option key={category} value={category}>{label}</option>)}
      </select>
    </label>
    <div className="actions training-controls">
      <button type="button" className="training-generate" disabled={busy} onClick={generate}>{busy ? "ATTENDI…" : "GENERA"}</button>
      <button type="button" disabled={busy || !canAccept} onClick={onAccept}>{scheduled ? "PROGRAMMATO" : "ACCETTA"}</button>
    </div>
  </>;
}
