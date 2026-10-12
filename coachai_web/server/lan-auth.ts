import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "./config.js";
import { safeIngressWrite } from "./auth.js";

const cookieName = "coachai_session";
const lifetime = 8 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest();

// One process, one store, no additional database or persistent browser token.
// Sessions expire on restart; the configured password is never sent to clients.
export function lanAccess(app: FastifyInstance, runtime: RuntimeConfig, clock = () => new Date()) {
  const enabled = runtime.lanEnabled === true;
  let origin: URL | null = null;
  if (enabled) {
    const password = runtime.lanWebPassword ?? "";
    if (password.length < 24 || password.length > 256 || /[\x00-\x1f\x7f]/.test(password))
      throw new Error("LAN requires a dedicated web password of 24 to 256 characters");
    if (password === runtime.adminToken)
      throw new Error("LAN requires a web password distinct from the API token");
    try {
      origin = new URL(runtime.lanWebOrigin ?? "");
      if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
          origin.pathname !== "/" || origin.search || origin.hash || origin.origin === "null")
        throw new Error();
    } catch {
      throw new Error("LAN requires an explicit HTTP(S) web origin without a path");
    }
  }
  const passwordHash = digest(runtime.lanWebPassword ?? "");
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  let globalAttempts = { count: 0, until: 0 };
  const now = () => clock().getTime();
  function prune() {
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
    for (const [key, limit] of attempts) if (limit.until <= now()) attempts.delete(key);
  }
  function sessionKey(request: FastifyRequest): string | null {
    const cookies = (request.headers.cookie ?? "").split(";").map(c => c.trim())
      .filter(c => c.startsWith(cookieName + "="));
    if (cookies.length !== 1) return null;
    const value = cookies[0].slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? digest(value).toString("hex") : null;
  }
  function hostMatches(request: FastifyRequest) {
    // Ignore Forwarded/X-Forwarded-*; proxies cannot grant authentication.
    return enabled && request.headers.host === origin!.host &&
      request.headers["sec-fetch-site"] !== "cross-site";
  }
  function safeWrite(request: FastifyRequest) {
    return hostMatches(request) && safeIngressWrite(request) &&
      request.headers.origin === origin!.origin;
  }
  function authenticated(request: FastifyRequest) {
    prune();
    const key = sessionKey(request);
    return hostMatches(request) && key !== null && sessions.has(key);
  }
  const cookie = (value: string, age: number) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}` +
    (origin?.protocol === "https:" ? "; Secure" : "");
  app.get("/auth/config", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({ lanEnabled: enabled }));
  app.post<{ Body: { password?: unknown } }>("/auth/session", { bodyLimit: 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!enabled) return reply.code(404).send({ error: "not_found" });
    if (!safeWrite(request)) return reply.code(403).send({ error: "same_origin_request_required" });
    prune();
    const peer = request.raw.socket.remoteAddress ?? "unknown";
    if (globalAttempts.until <= now()) globalAttempts = { count: 0, until: now() + 60_000 };
    const limit = attempts.get(peer) ?? { count: 0, until: now() + 15 * 60_000 };
    if (limit.count >= 5 || globalAttempts.count >= 100 || (!attempts.has(peer) && attempts.size >= 256))
      return reply.header("Retry-After", "900").code(429).send({ error: "try_later" });
    limit.count++; globalAttempts.count++; attempts.set(peer, limit);
    const password = request.body?.password;
    if (typeof password !== "string" || password.length > 256 ||
        !timingSafeEqual(passwordHash, digest(password)))
      return reply.code(401).send({ error: "unauthorized" });
    if (sessions.size >= 256) return reply.code(429).send({ error: "try_later" });
    // Successful login rotates any previous browser session.
    const previous = sessionKey(request);
    if (previous) sessions.delete(previous);
    const token = randomBytes(32).toString("hex");
    sessions.set(digest(token).toString("hex"), now() + lifetime);
    return reply.header("Set-Cookie", cookie(token, lifetime / 1000)).send({ authenticated: true });
  });
  app.delete("/auth/session", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!enabled) return reply.code(404).send({ error: "not_found" });
    if (!safeWrite(request)) return reply.code(403).send({ error: "same_origin_request_required" });
    const key = sessionKey(request);
    if (key) sessions.delete(key);
    return reply.header("Set-Cookie", cookie("", 0)).send({ authenticated: false });
  });
  app.addHook("onClose", async () => { sessions.clear(); attempts.clear(); });
  return { authenticated, safeWrite };
}
