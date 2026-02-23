const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*", // TODO Phase 3: lock down origin
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Content-Type": "application/json",
  };
}

export function success(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: corsHeaders(),
  });
}

export function error(message: string, code: string, status = 400): Response {
  return new Response(
    JSON.stringify({ data: null, error: { message, code } }),
    {
      status,
      headers: corsHeaders(),
    },
  );
}

export function getUserId(req: Request): string {
  const authHeader = req.headers.get("Authorization") ?? "";
  const [, rawToken = ""] = authHeader.match(/^Bearer\s+(.+)$/i) ?? [];
  const token = rawToken.trim();

  if (token && UUID_REGEX.test(token)) {
    return token;
  }

  // TODO Phase 3: replace with real JWT validation and subject extraction.
  return TEST_USER_ID;
}
