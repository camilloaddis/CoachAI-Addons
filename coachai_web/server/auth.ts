import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

// Supervisor Ingress has a fixed peer address. Never trust forwarded IP headers,
// a LAN subnet, localhost, or X-Ingress-Path without this actual socket peer.
export function accessMethod(
  request: FastifyRequest,
  token: string,
): "ingress" | "bearer" | null {
  const peer = request.raw.socket.remoteAddress;
  const path = request.headers["x-ingress-path"];
  if (
    (peer === "172.30.32.2" || peer === "::ffff:172.30.32.2") &&
    typeof path === "string" &&
    /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/.test(path)
  )
    return "ingress";
  const supplied = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : "";
  const left = Buffer.from(token),
    right = Buffer.from(supplied);
  return token.length >= 32 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
    ? "bearer"
    : null;
}
export function safeIngressWrite(request: FastifyRequest): boolean {
  // A custom header requires a same-origin fetch (no CORS is enabled). HTML
  // forms cannot provide it. Fetch Metadata adds a second cross-site guard.
  return (
    request.headers["x-coachai-request"] === "1" &&
    request.headers["sec-fetch-site"] !== "cross-site"
  );
}
