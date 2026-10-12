import React, { useState } from "react";
import { apiFetch } from "./api.js";

export function LanLogin({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <section className="panel">
    <h1>Accedi a Coach AI</h1>
    <p>Usa la password web configurata per questa installazione.</p>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError("");
      try {
        const response = await apiFetch("/auth/session", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (response.ok) onLogin();
        else setError(response.status === 429 ? "Troppi tentativi. Riprova tra 15 minuti." : "Accesso non riuscito. Verifica password e indirizzo della pagina.");
      } catch { setError("Connessione non disponibile."); }
      finally { setPassword(""); setBusy(false); }
    }}>
      <label>Password web
        <input type="password" name="password" autoComplete="current-password" required
          maxLength={256} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
      </label>
      <button type="submit" disabled={busy}>{busy ? "Accesso…" : "Accedi"}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  </section>;
}
