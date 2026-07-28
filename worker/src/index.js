const TAGO_BASE = "https://apis.data.go.kr/1613000/SubwayInfo";

const ALLOWED_ENDPOINTS = new Set([
  "GetKwrdFndSubwaySttnList",
  "GetSubwaySttnExitAcctoBusRouteList",
  "GetSubwaySttnExitAcctoCfrFcltyList",
  "GetSubwaySttnAcctoSchdulList"
]);

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigin = env.ALLOWED_ORIGIN || requestOrigin || "";
  const isAllowed = !requestOrigin || requestOrigin === allowedOrigin;

  return {
    "Access-Control-Allow-Origin": isAllowed ? allowedOrigin : "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return Response.json({ error: "Only GET requests are supported." }, { status: 405, headers: cors });
    }

    if (!env.TAGO_SERVICE_KEY) {
      return Response.json({ error: "TAGO_SERVICE_KEY is not configured." }, { status: 500, headers: cors });
    }

    const incomingUrl = new URL(request.url);
    const endpoint = incomingUrl.searchParams.get("endpoint");
    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
      return Response.json({ error: "Unsupported TAGO endpoint." }, { status: 400, headers: cors });
    }

    const tagoUrl = new URL(`${TAGO_BASE}/${endpoint}`);
    for (const [key, value] of incomingUrl.searchParams) {
      if (key !== "endpoint" && key !== "serviceKey") tagoUrl.searchParams.set(key, value);
    }
    tagoUrl.searchParams.set("serviceKey", env.TAGO_SERVICE_KEY);
    tagoUrl.searchParams.set("_type", "json");

    try {
      const response = await fetch(tagoUrl);
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: { ...cors, "Content-Type": response.headers.get("Content-Type") || "application/json; charset=utf-8" }
      });
    } catch (error) {
      console.error("TAGO request failed", error);
      return Response.json({ error: "TAGO API request failed." }, { status: 502, headers: cors });
    }
  }
};
