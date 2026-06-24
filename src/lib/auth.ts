// Autenticação simples baseada em lista de usuários (email -> senha) definida
// em variáveis de ambiente, com cookie de sessão assinado via HMAC SHA-256.
// Sem dependências externas; usa apenas Web Crypto (disponível em Node e Edge).

export const SESSION_COOKIE = "agc_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

type UsersMap = Map<string, string>;

function parseUsers(envValue: string | undefined): UsersMap {
  const users: UsersMap = new Map();
  if (!envValue) return users;
  try {
    const obj = JSON.parse(envValue) as Record<string, string>;
    for (const [email, password] of Object.entries(obj)) {
      if (typeof email === "string" && typeof password === "string") {
        users.set(email.toLowerCase().trim(), password);
      }
    }
  } catch {
    /* AUTH_USERS mal formatado — ignora */
  }
  return users;
}

export function getUsers(): UsersMap {
  if (typeof process === "undefined") return new Map();
  return parseUsers(process.env.AUTH_USERS);
}

export function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET não configurado. Gere com `openssl rand -hex 32`.",
    );
  }
  return secret;
}

// Garante que a auth está habilitada: exige que AUTH_USERS tenga ao menos 1
// usuário e que AUTH_SECRET esteja definido. Caso contrário, bloqueia acesso.
export function isAuthConfigured(): boolean {
  return getUsers().size > 0 && Boolean(process.env.AUTH_SECRET);
}

function toB64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64Url(value: string): Uint8Array<ArrayBuffer> {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signToken(email: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(getSecret()),
    new TextEncoder().encode(email),
  );
  return `${email}.${toB64Url(sig)}`;
}

export async function verifyToken(
  token: string | undefined | null,
): Promise<string | null> {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.lastIndexOf(".");
  const email = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!email || !sigB64) return null;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(getSecret()),
      fromB64Url(sigB64),
      new TextEncoder().encode(email),
    );
    if (!valid) return null;
  } catch {
    return null;
  }
  // Confirma que o email ainda está na allowlist.
  const users = getUsers();
  if (!users.has(email.toLowerCase())) return null;
  return email;
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: COOKIE_MAX_AGE,
};