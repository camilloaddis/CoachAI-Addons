export type Activity = {
  id: string;
  date: string;
  load: number | null;
  intensity: number | null;
  duration: number | null;
  name?: string | null;
  type?: string | null;
  commute?: boolean | null;
  rpe?: number | null;
};
export type Wellness = {
  date: string;
  ctl: number | null;
  atl: number | null;
  hrv: number | null;
  restingHR: number | null;
  sleepScore: number | null;
};
export type Feedback = {
  activityDate: string;
  updatedAt: string | null; // Last update instant, never claimed to be first insertion.
  updatedDate: string | null; // Europe/Rome date of that instant.
  sensationDate: null; // Telegram stores no observation date.
  legs: number;
};
export type IntensityAssessment = {
  id: string;
  date: string;
  status: "confermata" | "probabile" | "non_determinabile";
  reasons: string[];
};
export type Input = {
  date: string;
  wellness: Wellness[];
  activities: Activity[];
  feedback: Feedback[];
  historyComplete: boolean;
  issues: string[];
};
export type Recommendation =
  | "riposo"
  | "recupero"
  | "endurance"
  | "tempo"
  | "sweet spot/soglia"
  | "VO2max";
export type Result = {
  date: string;
  score: number | null;
  confidence: number;
  status: string;
  assessmentState: "missing_data" | "insufficient_recovery" | "available";
  recommendation: Recommendation;
  reasons: string[];
  missing: string[];
  metrics: {
    ctl: number | null;
    atl: number | null;
    tsb: number | null;
    load7: number | null;
    consecutiveIntensityDays: number;
    intensityAssessments: IntensityAssessment[];
    feedback: Feedback[];
  };
  profile: { ftp: number; day: string };
};
export function number(value: unknown, min = 0, max = Infinity): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function shift(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// SQLite CURRENT_TIMESTAMP is UTC. No machine-local parsing of timezone-less dates.
export function feedbackTimestamp(value: unknown): {
  updatedAt: string | null;
  updatedDate: string | null;
} {
  const missing = { updatedAt: null, updatedDate: null };
  if (typeof value !== "string") return missing;
  const sql = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const iso = sql ? value.replace(" ", "T") + "Z" : value;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      iso,
    );
  if (
    !match ||
    !validDate(match[1]) ||
    +match[2] > 23 ||
    +match[3] > 59 ||
    +match[4] > 59
  )
    return missing;
  const instant = new Date(iso);
  return Number.isNaN(instant.valueOf())
    ? missing
    : { updatedAt: instant.toISOString(), updatedDate: today(instant) };
}
