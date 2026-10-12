import { ValidationError } from "../services/records.js";
import type { DatabaseSync } from "node:sqlite";
import { shift, today, validDate } from "../readiness/types.js";
export function recalculate(db: DatabaseSync, date: string) {
  const food = db
    .prepare(
      "SELECT COUNT(*) AS n,SUM(calories) AS calories_in,SUM(protein_g) AS protein_g,SUM(carbs_g) AS carbs_g,SUM(fat_g) AS fat_g FROM meals WHERE date=?",
    )
    .get(date)!;
  const coverage = db
    .prepare("SELECT date FROM activity_coverage WHERE date=? AND complete=1")
    .get(date);
  const raw = db
    .prepare(
      "SELECT payload FROM activity_processing p JOIN training_activities a USING(activity_id) WHERE activity_date=?",
    )
    .all(date)
    .map((r) => JSON.parse(String(r.payload)) as Record<string, unknown>);
  const localCount = Number(
    db
      .prepare(
        "SELECT COUNT(*) n FROM training_activities WHERE activity_date=?",
      )
      .get(date)!.n,
  );
  const total = (key: string) =>
    !coverage ||
    localCount !== raw.length ||
    raw.some(
      (r) =>
        typeof r[key] !== "number" ||
        !Number.isFinite(r[key]) ||
        Number(r[key]) < 0,
    )
      ? null
      : raw.reduce((sum, r) => sum + Number(r[key]), 0);
  db.prepare(
    "INSERT INTO daily_summary(date,calories_in,protein_g,carbs_g,fat_g) VALUES(?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET calories_in=excluded.calories_in,protein_g=excluded.protein_g,carbs_g=excluded.carbs_g,fat_g=excluded.fat_g",
  ).run(
    date,
    food.calories_in ?? null,
    food.protein_g ?? null,
    food.carbs_g ?? null,
    food.fat_g ?? null,
  );
  // Only overwrite activity metrics when a successful GET covers this day.
  if (coverage)
    db.prepare(
      "UPDATE daily_summary SET exercise_kcal=?,activity_duration_sec=?,training_load=? WHERE date=?",
    ).run(
      total("calories"),
      total("moving_time"),
      total("icu_training_load"),
      date,
    );
}
export function commandDate(text: string, now: Date): string {
  const day = today(now),
    value = text.trim().toLowerCase();
  if (!value || value === "oggi") return day;
  if (value === "ieri") return shift(day, -1);
  let date = value;
  const m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/.exec(value);
  if (m)
    date = `${m[3] || day.slice(0, 4)}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (!validDate(date) || date > day) throw new ValidationError("invalid_date");
  return date;
}
const display = (v: unknown) =>
  typeof v === "number" ? Math.round(v * 10) / 10 : "n/d";
// Food is read from current meal records, never from a completion flag or a
// potentially stale cached total. Other historical summary fields stay intact.
export function readDailySummary(db: DatabaseSync, date: string) {
  const stored = db.prepare("SELECT * FROM daily_summary WHERE date=?").get(date);
  const { n, ...food } = db.prepare(
    "SELECT COUNT(*) AS n,SUM(calories) AS calories_in,SUM(protein_g) AS protein_g,SUM(carbs_g) AS carbs_g,SUM(fat_g) AS fat_g FROM meals WHERE date=?",
  ).get(date)!;
  if (!stored && !n) return null;
  const row: Record<string, unknown> = { ...stored, date, ...food };
  // Keep the legacy database column, but do not expose it as diary state.
  delete row.food_complete;
  return row;
}
export function dailyReport(db: DatabaseSync, date: string) {
  const row = readDailySummary(db, date);
  if (!row) return `${date}: nessun dato disponibile. L’assenza di pasti registrati non indica digiuno. TDEE e bilancio: non stimati.`;
  return `${date}: dati alimentari registrati, potenzialmente parziali.\nCalorie registrate: ${display(row.calories_in)} kcal. Proteine ${display(row.protein_g)} g; carboidrati ${display(row.carbs_g)} g; grassi ${display(row.fat_g)} g.\nAttività: ${display(row.activity_duration_sec == null ? null : Number(row.activity_duration_sec) / 60)} min, carico ${display(row.training_load)}, energia ${display(row.exercise_kcal)} kcal. Peso: ${display(row.weight)} kg. TDEE e bilancio: non stimati. L’assenza di pasti registrati non indica digiuno.`;
}
export function weeklyReport(db: DatabaseSync, now: Date) {
  const end = shift(today(now), -1),
    start = shift(end, -6);
  const rows = db
    .prepare(
      "SELECT date FROM daily_summary WHERE date BETWEEN ? AND ? UNION SELECT date FROM meals WHERE date BETWEEN ? AND ? ORDER BY date",
    )
    .all(start, end, start, end)
    .map((r) => readDailySummary(db, String(r.date))!);
  const average = (key: string) => {
    const values = rows
      .map((r) => r[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return values.length
      ? `${display(values.reduce((a, b) => a + b, 0) / values.length)} (${values.length}/7 giorni)`
      : "n/d";
  };
  return `Settimana ${start} → ${end} (oggi escluso)\nGiorni disponibili: ${rows.length}/7.\nMedie dei soli dati registrati: calorie ${average("calories_in")}, proteine ${average("protein_g")}, carboidrati ${average("carbs_g")}, grassi ${average("fat_g")}, peso ${average("weight")}. Carico ${average("training_load")}. I pasti registrati possono non rappresentare l’apporto totale; l’assenza di registrazioni non indica digiuno.`;
}
export function weightReport(db: DatabaseSync, now: Date) {
  const end = shift(today(now), -1),
    rows = db
      .prepare(
        "SELECT date,weight FROM daily_summary WHERE date BETWEEN ? AND ? AND weight > 0 ORDER BY date",
      )
      .all(shift(end, -34), end);
  const mean = (start: string, finish: string) => {
    const v = rows
      .filter((r) => String(r.date) >= start && String(r.date) <= finish)
      .map((r) => Number(r.weight));
    return {
      n: v.length,
      value: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null,
    };
  };
  const last = mean(shift(end, -6), end),
    previous = mean(shift(end, -13), shift(end, -7));
  return `Peso registrato più recente: ${display(rows.at(-1)?.weight)} kg.\nMedie: ${[7, 14, 28].map((n) => `${n} giorni ${display(mean(shift(end, 1 - n), end).value)} kg`).join("; ")}.\nVariazione settimanale: ${last.n >= 5 && previous.n >= 5 ? `${display(last.value! - previous.value!)} kg` : "non determinabile: servono almeno 5 misure in ciascuna settimana"}.`;
}
