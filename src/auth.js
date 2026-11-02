import { col } from "./db.js";
import { unauthorized } from "./errors.js";

// The front end signs users in via Better Auth (Next.js route handlers) and
// stores the session token in a cookie named `better-auth.session_token`
// (optionally the `__Secure-` prefixed variant over https). The value format
// is `<token>.<signature>`; we strip the signature and look the token up in
// Better Auth's own `session` collection, which is the source of truth.
export function parseCookieHeader(header) {
  const cookies = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    try {
      cookies[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      cookies[key] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

const SESSION_COOKIE_PATTERNS = ["session_token", "session_data"];

export async function getSessionUser(req) {
  const cookies = parseCookieHeader(req.headers.cookie);

  for (const pattern of SESSION_COOKIE_PATTERNS) {
    const key = Object.keys(cookies).find((k) => k.includes(pattern));
    if (key === undefined) continue;

    // `better-auth.session_token` = `<token>.<hmac>`; older `session_data`
    // variants embed the token differently, but taking the first segment
    // before "." covers both.
    const token = cookies[key].split(".")[0];
    if (!token) continue;

    const session = await col("session").findOne({
      token,
      expiresAt: { $gt: new Date() },
    });
    if (!session) continue;

    const user = await col("user").findOne({ _id: session.userId });
    if (!user) continue;

    return {
      id: String(user._id),
      email: user.email,
      name: user.name,
      image: user.image ?? null,
      createdAt: user.createdAt,
    };
  }

  return null;
}

/** Route middleware that attaches `req.user` or replies 401. */
export async function requireUser(req, res, next) {
  const user = await getSessionUser(req);
  if (!user) {
    next(unauthorized());
    return;
  }
  req.user = user;
  next();
}
