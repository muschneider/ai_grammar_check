import { NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/auth";

// Protege todas as rotas (exceto /login e /api/auth/*). Se não houver sessão
// válida, redireciona para /login preservando o destino original.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Rotas públicas.
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/")
  ) {
    return;
  }

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  const email = await verifyToken(cookie);

  if (email) return;

  // Em requests para API (exceto auth), retorna 401 em vez de redirecionar.
  if (pathname.startsWith("/api/")) {
    return new Response("Não autenticado", { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", pathname + req.nextUrl.search);
  return Response.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};