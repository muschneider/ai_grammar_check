import { NextRequest, NextResponse } from "next/server";
import {
  getUsers,
  sessionCookieOptions,
  signToken,
  isAuthConfigured,
  SESSION_COOKIE,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isAuthConfigured()) {
    return new Response(
      "Autenticação não configurada no servidor (AUTH_USERS / AUTH_SECRET).",
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  const { email, password } = (body ?? {}) as {
    email?: string;
    password?: string;
  };

  if (typeof email !== "string" || typeof password !== "string") {
    return new Response("Credenciais ausentes", { status: 400 });
  }

  const users = getUsers();
  const key = email.toLowerCase().trim();
  const expected = users.get(key);

  if (!expected || expected !== password) {
    return new Response("Email ou senha inválidos", { status: 401 });
  }

  const token = await signToken(key);
  const res = NextResponse.json({ ok: true, email: key });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return res;
}