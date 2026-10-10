export type Keyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};
export type Envelope = {
  text: string;
  parse_mode: "HTML";
  reply_markup?: Keyboard;
};
export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const labels: Record<string, string> = {
  home: "Menu",
  training: "Allenamenti",
  nutrition: "Diario",
  today: "Oggi",
  yesterday: "Ieri",
  week: "Settimana",
  weight: "Peso",
  meals: "Pasti",
  accept: "Accetta",
  regen: "Rigenera",
  light: "Leggero",
  hard: "Intenso",
  ss: "Sweet Spot",
  vo2: "VO2max",
  endurance: "Endurance",
  force: "Forza",
  confirm: "Conferma",
  edit: "Modifica",
  cancel: "Annulla",
  diag: "Dettagli tecnici",
};
export function keyboard(id: number, kind: string): Keyboard {
  const rows =
    kind === "workout" || kind === "plan"
      ? [
          ["accept", "regen"],
          ["light", "hard"],
          ["ss", "vo2"],
          ["endurance", "force"],
          ["diag", "home"],
        ]
      : kind === "nutrition"
        ? [["confirm", "edit", "cancel"], ["home"]]
        : [
            ["training", "nutrition"],
            ["today", "yesterday"],
            ["week", "weight"],
            ["meals", "home"],
          ];
  return {
    inline_keyboard: rows.map((row) =>
      row.map((action) => ({
        text: labels[action],
        callback_data: `c|${id}|${action}`,
      })),
    ),
  };
}
export function callbackAction(
  data: unknown,
): { id: number; action: string; command: string } | null {
  if (typeof data !== "string" || Buffer.byteLength(data) > 64) return null;
  const m = /^c\|(0|[1-9]\d*)\|([a-z0-9]+)$/.exec(data);
  if (!m || !Number.isSafeInteger(Number(m[1])) || !Object.hasOwn(labels, m[2]))
    return null;
  const commands: Record<string, string> = {
    home: "home",
    training: "allenamento",
    nutrition: "pasto",
    today: "oggi",
    yesterday: "ieri",
    week: "settimana",
    weight: "peso",
    meals: "pasti oggi",
    accept: `accetta allenamento ${m[1]}`,
    regen: "rigenera",
    light: "leggero",
    hard: "intenso",
    ss: "ss",
    vo2: "vo2",
    endurance: "endurance",
    force: "forza",
    confirm: "accetta pasto",
    edit: "modifica bozza",
    cancel: "annulla",
    diag: "diagnostica",
  };
  return { id: Number(m[1]), action: m[2], command: commands[m[2]] };
}
// Chunk source text before escaping. Never slices an HTML entity or workout technical block.
export function present(reply: string, id: number, kind: string): Envelope[] {
  const title =
    kind === "workout" || kind === "plan"
      ? "Allenamento"
      : kind === "nutrition"
        ? "Diario · stima da confermare"
        : kind === "diagnostics"
          ? "Diagnostica"
          : "Coach AI";
  const start = reply.lastIndexOf("[WORKOUT_START]\n");
  const technical =
    (kind === "workout" || kind === "plan") && start >= 0
      ? /\[WORKOUT_START\]\n([\s\S]*?)\n\[WORKOUT_END\]/.exec(
          reply.slice(start),
        )
      : null;
  if (technical) technical.index += start;
  const blocks: { text: string; pre?: boolean }[] = technical
    ? [
        { text: reply.slice(0, technical.index) },
        { text: technical[1], pre: true },
        { text: reply.slice(technical.index + technical[0].length) },
      ]
    : [{ text: reply }];
  const output: Envelope[] = [];
  let current = `<b>${escapeHtml(title)}</b>\n\n`;
  const flush = () => {
    if (current.trim()) output.push({ text: current, parse_mode: "HTML" });
    current = "";
  };
  for (const block of blocks) {
    if (!block.text.trim()) continue;
    if (block.pre) {
      const code = `<pre>${escapeHtml(block.text)}</pre>`;
      if (code.length > 3800) throw new Error("workout_output_too_long");
      if (current.length + code.length + 2 > 3800) flush();
      current += code + "\n\n";
      continue;
    }
    // Small source pieces bound worst-case escaping (six characters per code point).
    const points = Array.from(block.text);
    for (let start = 0; start < points.length; start += 500) {
      const part = escapeHtml(points.slice(start, start + 500).join(""));
      if (current.length + part.length > 3800) flush();
      current += part;
    }
  }
  flush();
  if (!output.length) output.push({ text: "Coach AI", parse_mode: "HTML" });
  output.at(-1)!.reply_markup = keyboard(id, kind);
  return output;
}
