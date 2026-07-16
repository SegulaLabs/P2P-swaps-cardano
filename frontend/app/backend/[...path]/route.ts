import type { NextRequest } from "next/server";

/**
 * Same-origin API proxy: the browser calls /backend/* on this site and we
 * forward to the backend server-side. This is a route handler (not a
 * next.config rewrite) ON PURPOSE: rewrites get baked into the build
 * manifest at `next build` time, but BACKEND_INTERNAL_URL must be honored
 * at RUNTIME — in docker compose it's http://backend:3001, on a bare host
 * it defaults to http://localhost:3001. Keeps the site working under any
 * hostname/IP with no CORS and no per-host rebuild.
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function proxy(req: NextRequest, ctx: Ctx): Promise<Response> {
  const base = process.env.BACKEND_INTERNAL_URL || "http://localhost:3001";
  const { path } = await ctx.params;
  const url = `${base}/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
      },
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.text(),
      cache: "no-store",
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return Response.json(
      {
        error: "backend_unreachable",
        detail: `The frontend could not reach the backend at ${base} (BACKEND_INTERNAL_URL). Is it running?`,
      },
      { status: 502 }
    );
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
