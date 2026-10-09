import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { diagnostic, transaction } from "../storage/database.js";
import { validDate } from "../readiness/types.js";
export class ValidationError extends Error {}
const fail = () => {
  throw new ValidationError("Invalid record");
};
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return fail();
  return value.trim();
}
function numeric(value: unknown, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  )
    return fail();
  return value;
}
export type MealInput = {
  date: string;
  meal_type: string;
  description: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};
export type ActivityInput = {
  activity_id: string;
  activity_date: string;
  name?: string;
  category?: string;
  duration_min?: number;
  training_load?: number;
  intensity?: number;
};
export type FeedbackInput = {
  activity_id: string;
  legs: number;
  sensation_date?: string;
  note?: string;
};
export function recordServices(
  db: DatabaseSync,
  clock: () => Date = () => new Date(),
) {
  function once(kind: string, key: unknown, value: unknown, work: () => void) {
    const request = text(key, 200),
      hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (
      db.prepare("SELECT value FROM app_state WHERE key='import_mode'").get()
        ?.value !== "final"
    )
      throw new ValidationError("Local writes require final import");
    const old = db
      .prepare(
        "SELECT request_hash,kind FROM service_requests WHERE request_key=?",
      )
      .get(request);
    if (old) {
      if (old.request_hash !== hash || old.kind !== kind)
        throw new ValidationError("Idempotency key conflict");
      return { duplicate: true };
    }
    work();
    db.prepare(
      "INSERT INTO app_state VALUES('data_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
    ).run();
    db.prepare("INSERT INTO service_requests VALUES(?,?,?)").run(
      request,
      hash,
      kind,
    );
    return { duplicate: false };
  }
  function nested<T>(work: () => T, inTransaction: boolean) {
    if (inTransaction && !db.isTransaction)
      throw new ValidationError("Active transaction required");
    return inTransaction ? work() : transaction(db, work);
  }
  function meal(input: MealInput, key: string, inTransaction = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const date = text(input.date, 10);
    if (!validDate(date)) fail();
    const value = {
      date,
      meal_type: text(input.meal_type, 80),
      description: text(input.description, 2000),
      calories: numeric(input.calories, 20000),
      protein_g: numeric(input.protein_g, 2000),
      carbs_g: numeric(input.carbs_g, 3000),
      fat_g: numeric(input.fat_g, 2000),
    };
    const work = () =>
      once("meal", key, value, () => {
        db.prepare(
          "INSERT INTO meals(date,meal_type,description,calories,protein_g,carbs_g,fat_g,recorded_at,origin,request_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          value.date,
          value.meal_type,
          value.description,
          value.calories,
          value.protein_g,
          value.carbs_g,
          value.fat_g,
          clock().toISOString(),
          "local",
          key,
        );
        diagnostic(db, "meal_recorded", "saved");
      });
    return nested(work, inTransaction);
  }
  function feedback(input: FeedbackInput, key: string, inTransaction = false) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const id = text(input.activity_id, 200),
      note = input.note === undefined ? null : text(input.note, 2000);
    if (!Number.isInteger(input.legs) || input.legs < 1 || input.legs > 5)
      fail();
    if (
      input.sensation_date !== undefined &&
      (!validDate(input.sensation_date) ||
        input.sensation_date >
          clock().toLocaleDateString("en-CA", { timeZone: "Europe/Rome" }))
    )
      fail();
    const value = {
      activity_id: id,
      legs: input.legs,
      note,
      sensation_date: input.sensation_date ?? null,
    };
    const work = () =>
      once("feedback", key, value, () => {
        if (
          !db
            .prepare(
              "SELECT activity_id FROM training_activities WHERE activity_id=?",
            )
            .get(id)
        )
          throw new ValidationError("Unknown activity");
        db.prepare(
          "INSERT INTO training_feedback(activity_id,legs,note,updated_at,sensation_date,request_key,origin) VALUES(?,?,?,?,?,?,?) ON CONFLICT(activity_id) DO UPDATE SET legs=excluded.legs,note=excluded.note,updated_at=excluded.updated_at,sensation_date=excluded.sensation_date,request_key=excluded.request_key,origin=excluded.origin",
        ).run(
          id,
          value.legs,
          note,
          clock().toISOString(),
          value.sensation_date,
          key,
          "local",
        );
        diagnostic(db, "feedback_received", "saved");
      });
    return nested(work, inTransaction);
  }
  function activity(input: ActivityInput, key: string) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const id = text(input.activity_id, 200),
      date = text(input.activity_date, 10);
    if (!validDate(date)) fail();
    const value = {
      activity_id: id,
      activity_date: date,
      name: input.name === undefined ? null : text(input.name, 500),
      category: input.category === undefined ? null : text(input.category, 80),
      duration_min:
        input.duration_min === undefined
          ? null
          : numeric(input.duration_min, 10080),
      training_load:
        input.training_load === undefined
          ? null
          : numeric(input.training_load, 10000),
      intensity:
        input.intensity === undefined ? null : numeric(input.intensity, 300),
    };
    return transaction(db, () =>
      once("activity", key, value, () => {
        db.prepare(
          "INSERT INTO training_activities(activity_id,activity_date,name,category,duration_min,training_load,intensity) VALUES(?,?,?,?,?,?,?) ON CONFLICT(activity_id) DO UPDATE SET activity_date=excluded.activity_date,name=COALESCE(excluded.name,training_activities.name),category=COALESCE(excluded.category,training_activities.category),duration_min=COALESCE(excluded.duration_min,training_activities.duration_min),training_load=COALESCE(excluded.training_load,training_activities.training_load),intensity=COALESCE(excluded.intensity,training_activities.intensity)",
        ).run(
          id,
          date,
          value.name,
          value.category,
          value.duration_min,
          value.training_load,
          value.intensity,
        );
        diagnostic(db, "activity_detected", "recorded");
      }),
    );
  }
  return { meal, feedback, activity };
}
