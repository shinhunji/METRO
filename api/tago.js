const TAGO_BASE = "https://apis.data.go.kr/1613000/SubwayInfo";

const ALLOWED_ENDPOINTS = new Set([
  "GetKwrdFndSubwaySttnList",
  "GetSubwaySttnExitAcctoBusRouteList",
  "GetSubwaySttnExitAcctoCfrFcltyList",
  "GetSubwaySttnAcctoSchdulList"
]);

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Only GET requests are supported." });
  }

  if (!process.env.TAGO_SERVICE_KEY) {
    return response.status(500).json({ error: "TAGO_SERVICE_KEY is not configured." });
  }

  const endpoint = Array.isArray(request.query.endpoint) ? request.query.endpoint[0] : request.query.endpoint;
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return response.status(400).json({ error: "Unsupported TAGO endpoint." });
  }

  const tagoUrl = new URL(`${TAGO_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(request.query)) {
    if (key !== "endpoint" && key !== "serviceKey" && typeof value === "string") tagoUrl.searchParams.set(key, value);
  }
  tagoUrl.searchParams.set("serviceKey", process.env.TAGO_SERVICE_KEY);
  tagoUrl.searchParams.set("_type", "json");

  try {
    const tagoResponse = await fetch(tagoUrl);
    const body = await tagoResponse.text();
    response.setHeader("Content-Type", tagoResponse.headers.get("content-type") || "application/json; charset=utf-8");
    return response.status(tagoResponse.status).send(body);
  } catch (error) {
    console.error("TAGO request failed", error);
    return response.status(502).json({ error: "TAGO API request failed." });
  }
}
