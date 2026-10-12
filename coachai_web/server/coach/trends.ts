import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { today, shift } from '../readiness/types.js';
import { groqClient } from './groq.js';
import type { RuntimeConfig } from '../config.js';

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const round = (value: number) => Math.round(value * 10) / 10;
export function trendReport(db: DatabaseSync, days: 7 | 30, now: Date) {
  const end = shift(today(now), -1), start = shift(end, 1 - days);
  const summary = db.prepare('SELECT * FROM daily_summary WHERE date BETWEEN ? AND ? ORDER BY date').all(start, end);
  const meals = db.prepare('SELECT date,calories,protein_g FROM meals WHERE date BETWEEN ? AND ?').all(start, end);
  const activities = db.prepare('SELECT a.activity_date,a.duration_min,p.payload FROM training_activities a LEFT JOIN activity_processing p USING(activity_id) WHERE a.activity_date BETWEEN ? AND ?').all(start, end);
  const coverage = db.prepare('SELECT date,refreshed_at FROM activity_coverage WHERE complete=1 AND date BETWEEN ? AND ?').all(start, end);
  const rows = Array.from({ length: days }, (_, i) => {
    const date = shift(start, i), stored = summary.find(r => r.date === date);
    const food = meals.filter(r => r.date === date), rides = activities.filter(r => r.activity_date === date);
    const covered = coverage.find(r => r.date === date);
    const foodTotal = (key: string) => food.length && food.every(r => number(r[key]) !== null) ? food.reduce((sum, r) => sum + Number(r[key]), 0) : null;
    const telemetry = rides.map(r => { try { return JSON.parse(String(r.payload)); } catch { return null; } });
    const activityTotal = (key: string) => covered && telemetry.every(r => r && number(r[key]) !== null) ? telemetry.reduce((sum, r) => sum + r[key], 0) : null;
    const weight = number(stored?.weight);
    return { date, calories: foodTotal('calories'), protein: foodTotal('protein_g'), recordedMeals: food.length,
      weight: weight !== null && weight > 0 && weight <= 500 ? weight : null,
      activities: covered ? rides.length : null, recordedActivities: rides.length,
      minutes: activityTotal('moving_time') === null ? null : round(activityTotal('moving_time')! / 60),
      exerciseKcal: activityTotal('calories'), activitySyncedAt: covered?.refreshed_at as string | undefined ?? null,
      balanceKcal: null };
  });
  const stats = (key: 'calories' | 'protein' | 'weight' | 'minutes' | 'exerciseKcal') => {
    const values = rows.map(r => r[key]).filter((v): v is number => v !== null);
    const total = values.reduce((a, b) => a + b, 0);
    return { observedDays: values.length, total: values.length ? round(total) : null, average: values.length ? round(total / values.length) : null };
  };
  const metrics = { calories: stats('calories'), protein: stats('protein'), weight: stats('weight'), minutes: stats('minutes'), exerciseKcal: stats('exerciseKcal') };
  const weightRows = rows.filter(r => r.weight !== null);
  const weightChange = weightRows.length >= 2 ? round(weightRows.at(-1)!.weight! - weightRows[0].weight!) : null;
  const activityDays = rows.filter(r => r.activities !== null).length;
  const facts = [
    { id: 'food', text: metrics.calories.average === null ? 'Nessun apporto alimentare registrato nel periodo.' : `Apporto registrato medio: ${metrics.calories.average} kcal su ${metrics.calories.observedDays}/${days} giorni. I pasti mancanti possono sottostimare l’apporto.` },
    { id: 'protein', text: metrics.protein.average === null ? 'Proteine non disponibili.' : `Proteine registrate: media ${metrics.protein.average} g su ${metrics.protein.observedDays}/${days} giorni, senza dedurre adeguatezza nutrizionale.` },
    { id: 'weight', text: weightChange === null ? `Andamento del peso non determinabile: ${weightRows.length} misure disponibili.` : `Peso: differenza fra prima e ultima misura ${weightChange > 0 ? '+' : ''}${weightChange} kg su ${weightRows.length} misure. Non equivale a una variazione di massa grassa.` },
    { id: 'activity', text: `Attività registrate: ${rows.reduce((n,r) => n + r.recordedActivities,0)}. Copertura sincronizzata ${activityDays}/${days} giorni; durata disponibile ${metrics.minutes.total ?? 'n/d'} minuti, energia delle attività ${metrics.exerciseKcal.total ?? 'n/d'} kcal (${metrics.exerciseKcal.observedDays}/${days} giorni).` },
    { id: 'balance', text: 'Bilancio energetico non stimabile: manca un dispendio totale giornaliero verificato. Le calorie delle attività non includono metabolismo basale e attività quotidiane; i valori alimentari registrati possono essere parziali e stimati.' },
  ];
  return { days, start, end, todayExcluded: true, rows, metrics, activityDays, weightChange, facts,
    sources: { food: 'Pasti SQLite; stime o valori inseriti', weight: 'Peso giornaliero conservato in SQLite (Intervals/import storico)', activity: 'Payload attività Intervals e copertura locale', balance: 'Non disponibile: TDEE non verificato' } };
}
export type TrendReport = ReturnType<typeof trendReport>;
export type TrendSummary = { mode: 'ai' | 'local'; status: 'selected' | 'disabled' | 'insufficient_data' | 'provider_unavailable' | 'context_changed'; highlights: string[]; generatedAt: string };
export function trendService(db: DatabaseSync, config: RuntimeConfig, fetcher: typeof fetch = fetch, clock: () => Date = () => new Date()) {
  const pending = new Map<number, Promise<TrendSummary>>();
  const ai = groqClient(config, fetcher);
  const report = (days: 7 | 30) => trendReport(db, days, clock());
  async function summarize(days: 7 | 30): Promise<TrendSummary> {
    if (pending.has(days)) return pending.get(days)!;
    const job = (async () => {
      const data = report(days), fingerprint = (r: TrendReport) => createHash('sha256').update(JSON.stringify(r)).digest('hex');
      const hash = fingerprint(data), key = `trend_summary:v1:${days}`;
      const fallback = (status: TrendSummary['status']): TrendSummary => ({ mode: 'local', status, highlights: data.facts.filter(f => ['food','weight','activity'].includes(f.id)).map(f => f.text), generatedAt: clock().toISOString() });
      if (!config.groqEnabled || !config.groqKey) return fallback('disabled');
      if (!data.rows.some(r => r.calories !== null || r.weight !== null || r.recordedActivities > 0)) return fallback('insufficient_data');
      let cached;
      try { cached = JSON.parse(String(db.prepare('SELECT value FROM app_state WHERE key=?').get(key)?.value)); } catch { /* absent or old cache */ }
      if (cached?.hash === hash && cached.expires > clock().getTime()) return cached.result;
      // Persist cooldown before HTTP; it survives process interruption without changing user records.
      const save = (result: TrendSummary, ttl: number) => db.prepare('INSERT INTO app_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify({ hash, expires: clock().getTime() + ttl, result }));
      save(fallback('provider_unavailable'), 300000);
      let result: TrendSummary;
      try {
        const ids = await ai.trends(data.facts);
        if (fingerprint(report(days)) !== hash) return { ...fallback('context_changed'), highlights: report(days).facts.filter(f => ['food','weight','activity'].includes(f.id)).map(f => f.text) };
        result = { mode: 'ai', status: 'selected', highlights: ids.map(id => data.facts.find(f => f.id === id)!.text), generatedAt: clock().toISOString() };
      } catch { result = fallback('provider_unavailable'); }
      const fresh = report(days);
      if (fingerprint(fresh) !== hash) return { ...fallback('context_changed'), highlights: fresh.facts.filter(f => ['food','weight','activity'].includes(f.id)).map(f => f.text) };
      save(result, result.mode === 'ai' ? 86400000 : 300000);
      return result;
    })();
    pending.set(days, job);
    try { return await job; } finally { pending.delete(days); }
  }
  return { report, summarize };
}
