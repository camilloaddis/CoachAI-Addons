/** Pure, offline parser of verified library targets. Never classifies execution. */
export const WORKOUT_NORMALIZER_VERSION = "1" as const;

export type PowerTarget =
  | { kind: "constant"; units: "%ftp"; value: number }
  | { kind: "range"; units: "%ftp"; start: number; end: number }
  | { kind: "ramp"; units: "%ftp"; start: number; end: number };
export type CadenceTarget =
  | { kind: "constant"; units: "rpm"; value: number }
  | { kind: "range"; units: "rpm"; start: number; end: number };
export type WorkoutNode =
  | { kind: "segment"; durationSeconds: number; power: PowerTarget; cadence?: CadenceTarget; label?: string }
  | { kind: "repeat"; repetitions: number; durationSeconds: number; steps: WorkoutNode[]; label?: string };
export type NormalizedWorkout = {
  steps: WorkoutNode[];
  durationSeconds: number;
  peakPowerPercentFtp: number;
  expandedSegments: number;
};
export type NormalizationIssue = {
  code: "missing_data" | "invalid_value" | "unsupported_format" | "duration_mismatch" | "complexity_limit";
  path: string;
};
export type WorkoutNormalizationResult =
  | { version: typeof WORKOUT_NORMALIZER_VERSION; status: "compatible"; workout: NormalizedWorkout; issues: [] }
  | { version: typeof WORKOUT_NORMALIZER_VERSION; status: "incompatible"; workout: null; issues: NormalizationIssue[] };

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const positiveInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const targetNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

export function normalizeLibraryWorkout(input: unknown): WorkoutNormalizationResult {
  const issues: NormalizationIssue[] = [];
  function fail(code: NormalizationIssue["code"], path: string): never {
    issues.push({ code, path });
    throw new Error("invalid_workout");
  }
  function fields(v: Record<string, unknown>, allowed: string[], path: string) {
    // Do not echo unknown keys or provider values into diagnostics.
    if (Object.keys(v).some(k => !allowed.includes(k))) fail("unsupported_format", path);
  }
  function duration(v: unknown, path: string): number {
    if (v === undefined || v === null) fail("missing_data", path);
    if (!positiveInteger(v)) fail("invalid_value", path);
    return v;
  }
  function checked(n: number, path: string): number {
    if (!Number.isSafeInteger(n) || n > 31_536_000) fail("complexity_limit", path);
    return n;
  }
  function target(v: unknown, units: "%ftp" | "rpm", ramp: boolean, path: string) {
    if (!object(v)) fail(v === undefined || v === null ? "missing_data" : "invalid_value", path);
    fields(v, ["units", "value", "start", "end"], path);
    if (v.units !== units) fail("unsupported_format", path);
    if (Object.hasOwn(v, "value")) {
      if (ramp || Object.hasOwn(v, "start") || Object.hasOwn(v, "end") || !targetNumber(v.value))
        fail("invalid_value", path);
      return { kind: "constant" as const, units, value: v.value };
    }
    if (!targetNumber(v.start) || !targetNumber(v.end)) fail("invalid_value", path);
    return { kind: ramp ? "ramp" as const : "range" as const, units, start: v.start, end: v.end };
  }
  let nodes = 0;
  type Parsed = { steps: WorkoutNode[]; duration: number; peak: number; count: number };
  function parse(v: unknown, path: string, depth: number): Parsed {
    if (depth > 16) fail("complexity_limit", path);
    if (!Array.isArray(v) || !v.length) fail("missing_data", path);
    if (v.length > 2000) fail("complexity_limit", path);
    const out: Parsed = { steps: [], duration: 0, peak: 0, count: 0 };
    for (let i = 0; i < v.length; i++) {
      const s: unknown = v[i], p = `${path}[${i}]`;
      if (++nodes > 2000) fail("complexity_limit", p);
      if (!object(s)) fail("invalid_value", p);
      if (s.text !== undefined && (typeof s.text !== "string" || s.text.length > 2000)) fail("invalid_value", p + ".text");
      const label = typeof s.text === "string" ? { label: s.text } : {};
      if (s.distance !== undefined && s.distance !== 0) fail("unsupported_format", p + ".distance");
      const declared = duration(s.duration, p + ".duration");
      if (Object.hasOwn(s, "steps") || Object.hasOwn(s, "reps")) {
        fields(s, ["steps", "reps", "duration", "distance", "text"], p);
        if (!positiveInteger(s.reps)) fail("invalid_value", p + ".reps");
        const child = parse(s.steps, p + ".steps", depth + 1);
        const total = checked(child.duration * s.reps, p + ".duration");
        if (total !== declared) fail("duration_mismatch", p + ".duration");
        out.steps.push({ kind: "repeat", repetitions: s.reps, durationSeconds: total, steps: child.steps, ...label });
        out.duration = checked(out.duration + total, path);
        out.peak = Math.max(out.peak, child.peak);
        out.count += child.count * s.reps;
      } else {
        fields(s, ["duration", "distance", "text", "power", "cadence", "ramp"], p);
        if (s.ramp !== undefined && typeof s.ramp !== "boolean") fail("invalid_value", p + ".ramp");
        const power = target(s.power, "%ftp", s.ramp === true, p + ".power") as PowerTarget;
        const cadence = s.cadence === undefined ? {} : { cadence: target(s.cadence, "rpm", false, p + ".cadence") as CadenceTarget };
        out.steps.push({ kind: "segment", durationSeconds: declared, power, ...cadence, ...label });
        out.duration = checked(out.duration + declared, path);
        out.peak = Math.max(out.peak, power.kind === "constant" ? power.value : Math.max(power.start, power.end));
        out.count++;
      }
      if (!Number.isSafeInteger(out.count) || out.count > 100_000) fail("complexity_limit", path);
    }
    return out;
  }
  try {
    if (!object(input)) fail("missing_data", "workout");
    if (input.target !== undefined && input.target !== null && input.target !== "AUTO" && input.target !== "POWER") fail("unsupported_format", "target");
    if (input.targets !== undefined && (!Array.isArray(input.targets) || input.targets.some(t => t !== "AUTO" && t !== "POWER"))) fail("unsupported_format", "targets");
    if (!object(input.workout_doc)) fail("missing_data", "workout_doc");
    const doc = input.workout_doc;
    if (doc.distance !== undefined && doc.distance !== 0) fail("unsupported_format", "workout_doc.distance");
    if (doc.options !== undefined && (!object(doc.options) || Object.keys(doc.options).length)) fail("unsupported_format", "workout_doc.options");
    const parsed = parse(doc.steps, "workout_doc.steps", 0);
    for (const [path, value] of [["workout_doc.duration", doc.duration], ["moving_time", input.moving_time]] as const) {
      if (duration(value, path) !== parsed.duration) issues.push({ code: "duration_mismatch", path });
    }
    if (issues.length) return { version: WORKOUT_NORMALIZER_VERSION, status: "incompatible", workout: null, issues };
    return { version: WORKOUT_NORMALIZER_VERSION, status: "compatible", issues: [], workout: {
      steps: parsed.steps, durationSeconds: parsed.duration, peakPowerPercentFtp: parsed.peak, expandedSegments: parsed.count,
    } };
  } catch (error) {
    if (!issues.length) throw error;
    return { version: WORKOUT_NORMALIZER_VERSION, status: "incompatible", workout: null, issues };
  }
}
