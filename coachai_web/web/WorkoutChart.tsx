import React from "react";
import type { NormalizedWorkout, WorkoutNode } from "../server/coach/workout-normalizer.js";

/** Draw verified library targets; ranges stay ranges and ramps retain their slope. */
export function WorkoutChart({ workout }: { workout: NormalizedWorkout | undefined }) {
  if (!workout?.steps?.length || !workout.durationSeconds) return <p className="muted">Grafico non disponibile per questa proposta storica.</p>;
  const segments: Extract<WorkoutNode, { kind: "segment" }>[] = [];
  function expand(nodes: WorkoutNode[]) {
    for (const node of nodes) {
      if (node.kind === "segment") segments.push(node);
      else for (let i = 0; i < node.repetitions; i++) expand(node.steps);
    }
  }
  expand(workout.steps);
  const width = 800, height = 180, ceiling = Math.max(130, workout.peakPowerPercentFtp);
  const y = (power: number) => height - power / ceiling * (height - 12);
  const color = (power: number) => power <= 55 ? "#8c9aaf" : power <= 75 ? "#65b9ed" : power <= 90 ? "#75d893" : power <= 105 ? "#e7cf67" : "#ef9172";
  let elapsed = 0;
  return <figure className="workout-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Profilo dell’allenamento: potenza in percentuale FTP nel tempo">
      <line x1="0" x2={width} y1={y(100)} y2={y(100)} stroke="#a8b4c4" strokeDasharray="5 5" opacity=".5" />
      {segments.map((segment, i) => {
        const x = elapsed / workout.durationSeconds * width;
        elapsed += segment.durationSeconds;
        const end = elapsed / workout.durationSeconds * width;
        const p = segment.power;
        const low = p.kind === "constant" ? p.value : Math.min(p.start, p.end);
        const high = p.kind === "constant" ? p.value : Math.max(p.start, p.end);
        const points = p.kind === "ramp"
          ? `${x},${height} ${x},${y(p.start)} ${end},${y(p.end)} ${end},${height}`
          : `${x},${height} ${x},${y(low)} ${end},${y(low)} ${end},${height}`;
        return <g key={i}><title>{Math.round(segment.durationSeconds / 60 * 10) / 10} min · {p.kind === "constant" ? p.value : `${p.start}–${p.end}`}% FTP{p.kind === "ramp" ? " · rampa" : ""}</title>
          <polygon points={points} fill={color(high)} stroke="#191f29" strokeWidth="1" />
          {p.kind === "range" && <rect x={x} y={y(high)} width={end - x} height={y(low) - y(high)} fill={color(high)} opacity=".4" />}
        </g>;
      })}
    </svg>
    <figcaption><span>0 min</span><span>{Math.round(workout.durationSeconds / 60)} min</span></figcaption>
  </figure>;
}
