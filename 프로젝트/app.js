"use strict";

// Vercel keeps the TAGO key server-side and proxies browser requests.
const API_BASE = "/api/tago";
const CATALOG_FILE = "station_catalog.json";
const WEIGHTED_GRAPH_FILE = "weighted_graph.json";
const DEFAULT_TRAVEL_MINUTES = 3;
const LINE_COLORS = {
  "수도권": { "1호선":"#0052A4", "2호선":"#00A84D", "3호선":"#EF7C1C", "4호선":"#00A5DE", "5호선":"#996CAC", "6호선":"#CD7C2F", "7호선":"#747F00", "8호선":"#E6186C", "9호선":"#BDB092", "GTX-A":"#9A6292", "경강":"#003DA5", "경의중앙":"#77C4A3", "경춘":"#0C8E72", "공항":"#0090D2", "김포골드라인":"#A17800", "서해선":"#8FC31F", "수인분당":"#F5A200", "신림선":"#6789CA", "신분당":"#D4003B", "에버라인":"#6FB245", "우이신설":"#B7C452", "의정부":"#FDA600", "인천1호선":"#6496D8", "인천2호선":"#ED8B00", "자기부상":"#FFCD12" },
  "부산": { "1호선":"#F06A00", "2호선":"#81BF48", "3호선":"#BB8C00", "4호선":"#217DCB", "동해":"#0054A6", "부산김해경전철":"#8652A1" },
  "대구": { "1호선":"#D93F5C", "2호선":"#00AA80", "3호선":"#FFB100", "대경선":"#0054A6" },
  "광주": { "1호선":"#009088" },
  "대전": { "1호선":"#007448" }
};
// API로 받은 전국 역 데이터는 대한민국 -> 지역 -> 노선 -> 역 트리 객체로 변환됩니다.
let NETWORK_TREE = {};

const els = {};
let graph = new Map();
let subwayGraph = { version: 1, generatedAt: null, stationGraph: {} };
let allStations = []; let currentRoute = null; let facilityStation = "origin"; let selectedRegion = ""; let extrasRequestInFlight = false; let stationById = new Map(); let regionStations = []; let catalogReady = false; let routeCalculationInFlight = false; let staticDataError = "";
const selections = { origin: { line: "" }, destination: { line: "" } };
const selectedStationRecords = { origin: null, destination: null };
let favorites = JSON.parse(localStorage.getItem("metro-favorites") || "[]");
let recent = JSON.parse(localStorage.getItem("metro-recent") || "[\"서울역\",\"강남\",\"부산역\"]");
const detailCache = new Map();
const DETAIL_CACHE_LIMIT = 10;
const DETAIL_ROW_LIMIT = 10;
const FACILITY_DISPLAY_LIMIT = 10;
const BUS_ROUTES_PER_EXIT_LIMIT = 6;
const timetableCache = new Map();

const $ = (selector) => document.querySelector(selector);
function escapeHTML(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[char])); }
function lineColor(region, line) { return LINE_COLORS[region]?.[line] || "#0b76d1"; }

// Station IDs, not display names, are graph vertices so equal station names never create transfers.
function buildGraph() {
  graph = new Map();
  stationById = new Map();
  Object.values(NETWORK_TREE).forEach(region => Object.entries(region).forEach(([line, stations]) => {
    stations.forEach(station => { stationById.set(station.id, { ...station, line }); graph.set(station.id, []); });
  }));
  // Use the static graph as-is: each direction has its own timetable-derived weight.
  Object.entries(subwayGraph.stationGraph || {}).forEach(([from, edges]) => {
    if (!graph.has(from)) return;
    Object.entries(edges || {}).forEach(([to, data]) => {
      if (!graph.has(to)) return;
      const weight = Number(data?.minutes) || DEFAULT_TRAVEL_MINUTES;
      graph.get(from).push({ to, line: stationById.get(to)?.line || stationById.get(from)?.line || "노선 정보", weight, transfer: data?.source === "transfer" });
    });
  });
  regionStations = Object.values(NETWORK_TREE[selectedRegion] || {}).flat();
  allStations = [...stationById.values()].map(station => station.name).sort((a, b) => a.localeCompare(b, "ko"));
}

function pickField(item, names) { return names.map(name => item[name]).find(value => value !== undefined && value !== null && String(value).trim() !== "") || ""; }
function regionFromStationId(id, route) {
  if (id.startsWith("MTRB")) return "부산";
  if (route === "동해") return "부산";
  if (id.startsWith("MTRDG") || id.startsWith("MTRKRK7K")) return "대구";
  if (id.startsWith("MTRGJ")) return "광주";
  if (id.startsWith("MTRDJ")) return "대전";
  // The API uses separate ID ranges for 수도권 extension and light-rail segments.
  if (/^(MTRS|MTRARA|MTRGXA|MTRKR|MTRDXD|MTREVE1Y|MTRGMG1G|MTRGU|MTRIAM|MTRIC|MTRNU|MTRUIUIS|MTRULU)/.test(id)) return "수도권";
  return route.includes("부산") ? "부산" : route.includes("대구") ? "대구" : "기타";
}
function buildStationTree(items) {
  const tree = {};
  normaliseItems(items).forEach(item => {
    const id = pickField(item, ["subwayStationId"]); const line = pickField(item, ["subwayRouteName"]); const name = pickField(item, ["subwayStationName"]);
    if (!id || !line || !name) return;
    const region = regionFromStationId(id, line); const stations = ((tree[region] ||= {})[line] ||= []);
    if (!stations.some(station => station.id === id)) stations.push({ id, name, line, region });
  });
  return tree;
}
function regionsToCatalog(regions) {
  const tree = {};
  Object.entries(regions || {}).forEach(([region, data]) => {
    const lines = data?.lines || {};
    tree[region] = {};
    Object.entries(lines).forEach(([line, data]) => {
      tree[region][line] = (data?.stations || []).map(station => ({ id: station.id, name: station.name, line, region }));
    });
  });
  return tree;
}
function setRouteStatus(message, state = "info") {
  els.routeStatus.textContent = message;
  els.routeStatus.dataset.state = state;
}
function setSearchState(state) {
  const button = els.searchButton;
  const label = button.querySelector("span");
  const icon = button.querySelector("i");
  const busy = state === "loading" || state === "calculating";
  button.disabled = busy || state === "error";
  button.setAttribute("aria-disabled", String(button.disabled));
  if (state === "loading") { icon.className = "fa-solid fa-spinner fa-spin"; label.textContent = "역 데이터 준비 중..."; }
  else if (state === "calculating") { icon.className = "fa-solid fa-spinner fa-spin"; label.textContent = "경로 계산 중..."; }
  else if (state === "ready") { icon.className = "fa-solid fa-magnifying-glass"; label.textContent = "길찾기"; }
  else { icon.className = "fa-solid fa-triangle-exclamation"; label.textContent = "역 데이터 오류"; }
}
async function loadStationCatalog() {
  setSearchState("loading");
  setRouteStatus("전국 역과 시간표 그래프를 불러오는 중입니다.");
  els.originSelector.innerHTML = els.destinationSelector.innerHTML = `<p class="selector-loading"><i class="fa-solid fa-spinner fa-spin"></i> 실제 역 목록을 불러오는 중...</p>`;
  try {
    const [catalog, weights] = await Promise.all([fetchStaticJson(CATALOG_FILE), fetchStaticJson(WEIGHTED_GRAPH_FILE)]);
    NETWORK_TREE = regionsToCatalog(catalog?.regions);
    subwayGraph = weights?.stationGraph ? weights : subwayGraph;
    if (!Object.keys(NETWORK_TREE).length) {
      const stationItems = await fetchTago("GetKwrdFndSubwaySttnList", { subwayStationName: "", numOfRows: "10000", pageNo: "1" });
      NETWORK_TREE = buildStationTree(stationItems);
    }
  } catch (error) { console.error("Could not initialize station data", error); }
  if (!Object.keys(NETWORK_TREE).length) {
    const message = staticDataError || "실제 역 목록을 불러오지 못했습니다. TAGO 역 조회 API 주소와 요청 항목을 확인해주세요.";
    els.region.innerHTML = `<option>${message}</option>`; els.region.disabled = true; els.originSelector.innerHTML = els.destinationSelector.innerHTML = `<p class="selector-error"><i class="fa-solid fa-triangle-exclamation"></i> ${message}</p>`;
    setSearchState("error");
    setRouteStatus(message, "error");
    toast("TAGO API에서 역 목록을 가져오지 못했습니다.");
    return;
  }
  selectedRegion = Object.keys(NETWORK_TREE)[0];
  els.region.innerHTML = Object.keys(NETWORK_TREE).map(region => `<option value="${escapeHTML(region)}">${escapeHTML(region)}</option>`).join(""); els.region.value = selectedRegion;
  Object.keys(selections).forEach(role => { selections[role].line = Object.keys(NETWORK_TREE[selectedRegion])[0]; });
  buildGraph(); renderTree("origin"); renderTree("destination");
  catalogReady = true;
  setSearchState("ready");
  setRouteStatus(`역 ${stationById.size.toLocaleString("ko-KR")}개와 시간표 그래프 준비 완료. 출발역과 도착역을 입력하세요.`, "ready");
}

// Compare both route criteria so an equal primary cost has a predictable fallback.
function compareRouteCost(left, right, preference) {
  const leftCost = preference === "transfers" ? [left.transfers, left.minutes] : [left.minutes, left.transfers];
  const rightCost = preference === "transfers" ? [right.transfers, right.minutes] : [right.minutes, right.transfers];
  return leftCost[0] - rightCost[0] || leftCost[1] - rightCost[1];
}
function findRoute(start, end, preference = "time") {
  const startStop = { id: start, line: stationById.get(start)?.line || "노선 정보", minutes: 0, transfer: false };
  const queue = [{ station: start, minutes: 0, transfers: 0, path: [startStop] }];
  const best = new Map([[start, { minutes: 0, transfers: 0 }]]);
  while (queue.length) {
    queue.sort((a, b) => compareRouteCost(a, b, preference));
    const state = queue.shift();
    if (compareRouteCost(state, best.get(state.station), preference) > 0) continue;
    if (state.station === end) return { path: state.path, totalMinutes: state.minutes, transfers: state.transfers, preference };
    for (const edge of graph.get(state.station) || []) {
      const next = { minutes: state.minutes + edge.weight, transfers: state.transfers + Number(edge.transfer) };
      if (compareRouteCost(next, best.get(edge.to) || { minutes: Infinity, transfers: Infinity }, preference) < 0) {
        best.set(edge.to, next);
        const path = [...state.path];
        path[path.length - 1] = { ...path.at(-1), minutes: edge.weight, transfer: edge.transfer };
        path.push({ id: edge.to, line: stationById.get(edge.to)?.line || edge.line, minutes: 0, transfer: false });
        queue.push({ station: edge.to, ...next, path });
      }
    }
  }
  return null;
}

// Function group: each calculation has a deterministic input/output relationship.
const calculateTransfers = path => path.slice(0, -1).reduce((count, stop) => count + Number(stop.transfer), 0);
const formatTime = date => date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

async function fetchTago(endpoint, params = {}, withStatus = false) {
  const query = new URLSearchParams({ endpoint, _type: "json", numOfRows: "50", pageNo: "1", ...params });
  try {
    const response = await fetch(`${API_BASE}?${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const body = data.response?.body;
    const apiSucceeded = data.response?.header?.resultCode === "00" || Boolean(body);
    if (!apiSucceeded) throw new Error(data.response?.header?.resultMsg || "API 응답 오류");
    const items = body?.items?.item || [];
    return withStatus ? { items, error: "" } : items;
  } catch (error) {
    console.warn("TAGO API request failed:", endpoint, error);
    return withStatus ? { items: [], error: error.message || "API 요청에 실패했습니다." } : null;
  }
}

function currentDayType() { const day = new Date().getDay(); return day === 0 ? "03" : day === 6 ? "02" : "01"; }
const CACHE_PREFIX = "metro-tago-v1:";
const TIMETABLE_CACHE_TTL = 60 * 60 * 1000;
function readCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || "null");
    return cached && cached.expiresAt > Date.now() ? cached.value : null;
  } catch { return null; }
}
function writeCache(key, value, ttl) {
  if (value === null) return;
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ value, expiresAt: Date.now() + ttl })); } catch (error) { console.warn("TAGO cache could not be saved:", error); }
}
function clearLegacyDetailCache() {
  try {
    Object.keys(localStorage).filter(key => key.startsWith(CACHE_PREFIX + "bus:") || key.startsWith(CACHE_PREFIX + "facility:")).forEach(key => localStorage.removeItem(key));
  } catch (error) { console.warn("Could not clear old detail cache:", error); }
}
function getDetailCache(key) {
  const value = detailCache.get(key);
  if (!value) return null;
  detailCache.delete(key); detailCache.set(key, value);
  return value;
}
function setDetailCache(key, value) {
  detailCache.set(key, value);
  if (detailCache.size > DETAIL_CACHE_LIMIT) detailCache.delete(detailCache.keys().next().value);
}
function graphWeight(from, to, fallback) { return Number(subwayGraph.stationGraph?.[from]?.[to]?.minutes) || fallback; }
function median(values) {
  const ordered = values.filter(value => value > 0 && value <= 15).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return Math.round(ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2);
}
function timetableSeconds(value) {
  if (!/^\d{6}$/.test(String(value))) return null;
  return Number(value.slice(0, 2)) * 3600 + Number(value.slice(2, 4)) * 60 + Number(value.slice(4, 6));
}
function segmentMinutes(fromRows, toRows) {
  const toByTerminal = new Map();
  normaliseItems(toRows).forEach(row => {
    const terminal = row.endSubwayStationId || row.endSubwayStationName || "";
    const time = timetableSeconds(row.depTime);
    if (time === null) return;
    if (!toByTerminal.has(terminal)) toByTerminal.set(terminal, []);
    toByTerminal.get(terminal).push(time);
  });
  toByTerminal.forEach(times => times.sort((a, b) => a - b));
  const durations = [];
  normaliseItems(fromRows).forEach(row => {
    const start = timetableSeconds(row.depTime); const terminal = row.endSubwayStationId || row.endSubwayStationName || "";
    if (start === null || !toByTerminal.has(terminal)) return;
    const arrivals = toByTerminal.get(terminal);
    let end = arrivals.find(time => time >= start);
    if (end === undefined) end = arrivals[0] + 24 * 60 * 60;
    const minutes = (end - start) / 60;
    if (minutes >= 0.5 && minutes <= 15) durations.push(minutes);
  });
  return median(durations);
}
async function loadGraphSnapshot() {
  return fetchStaticJson(WEIGHTED_GRAPH_FILE);
}
async function fetchStaticJson(file) {
  try {
    const response = await fetch(file, { cache: "force-cache" });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!contentType.includes("application/json")) {
      if (response.url.includes("vercel.com/sso-api")) throw new Error("Vercel 배포 보호가 JSON 요청을 로그인 페이지로 전환했습니다. Vercel Settings > Deployment Protection을 끄거나 사이트에 로그인해주세요.");
      throw new Error("JSON 파일 대신 다른 페이지가 응답되었습니다.");
    }
    return response.json();
  } catch (error) {
    staticDataError = `정적 역 데이터를 불러오지 못했습니다: ${error.message}`;
    console.warn(`Could not load ${file}`, error);
    return null;
  }
}
async function getCachedTago(key, endpoint, params, ttl, forceRefresh = false) {
  const cached = readCache(key);
  if (!forceRefresh && cached !== null) return cached;
  const data = await fetchTago(endpoint, params);
  writeCache(key, data, ttl);
  return data;
}
async function getStationExtras(station, forceRefresh = false) {
  const key = station.id;
  const cached = !forceRefresh && getDetailCache(key);
  if (cached) return cached;
  const [buses, facilities] = await Promise.all([
    fetchTago("GetSubwaySttnExitAcctoBusRouteList", { subwayStationId: station.id, numOfRows: String(DETAIL_ROW_LIMIT) }, true),
    fetchTago("GetSubwaySttnExitAcctoCfrFcltyList", { subwayStationId: station.id, numOfRows: String(DETAIL_ROW_LIMIT) })
  ]);
  const details = { buses: normaliseItems(buses.items).slice(0, DETAIL_ROW_LIMIT), busError: buses.error, facilities: normaliseItems(facilities).slice(0, DETAIL_ROW_LIMIT) };
  setDetailCache(key, details);
  return details;
}

function orderedLines(region) {
  const lines = Object.keys(NETWORK_TREE[region] || {});
  const numbered = lines.filter(line => /^[1-9]호선$/.test(line)).sort((a, b) => Number(a[0]) - Number(b[0]));
  const other = lines.filter(line => !/^[1-9]호선$/.test(line)).sort((a, b) => a.localeCompare(b, "ko"));
  return [...numbered, ...other];
}
function renderTree(role) {
  const state = selections[role]; const lines = orderedLines(selectedRegion); const stations = NETWORK_TREE[selectedRegion]?.[state.line] || [];
  const selector = role === "origin" ? els.originSelector : els.destinationSelector;
  const lineButton = line => `<button class="selector-item ${line === state.line ? "selected" : ""}" type="button" data-line="${escapeHTML(line)}" data-role-selector="${role}"><span class="line-color" style="background:${lineColor(selectedRegion, line)}"></span>${escapeHTML(line)}<i class="fa-solid fa-chevron-right"></i></button>`;
  selector.innerHTML = `
    <div class="selector-column"><p class="selector-label"><i class="fa-solid fa-train-subway"></i> ${role === "origin" ? "출발" : "도착"} 노선</p><div class="selector-list line-selector-list">${lines.map(lineButton).join("")}</div></div>
    <div class="selector-column"><p class="selector-label"><i class="fa-solid fa-location-dot"></i> ${role === "origin" ? "출발" : "도착"} 역</p><div class="selector-list">${stations.map(station => `<button class="selector-item station-option" type="button" data-station-id="${station.id}" data-role-selector="${role}"><span class="station-pin"></span><span class="station-name">${stationNameMarkup(station.name)}</span></button>`).join("")}</div></div>`;
}
function findStationRecord(id) {
  return stationById.get(id) || null;
}
function resolveStationInput(role) {
  const input = role === "origin" ? els.origin : els.destination;
  const name = input.value.trim();
  if (selectedStationRecords[role]?.name === name) return selectedStationRecords[role];
  const matches = regionStations.filter(station => station.name === name);
  if (matches.length === 1) {
    selectedStationRecords[role] = matches[0];
    return matches[0];
  }
  const selectedLineMatch = matches.find(station => station.line === selections[role].line);
  if (selectedLineMatch) {
    selectedStationRecords[role] = selectedLineMatch;
    return selectedLineMatch;
  }
  if (!matches.length && name) {
    const reason = name === "부산역" ? "TAGO 제공 역 목록에 부산역이 없어 경로를 계산할 수 없습니다. 인근 실제 역을 선택해주세요." : `${name}은(는) 현재 ${selectedRegion} 역 목록에 없습니다. 목록에서 역을 선택해주세요.`;
    setRouteStatus(reason, "error");
    toast(reason);
  }
  else if (matches.length > 1) { const reason = `${name}은(는) 여러 노선에 있습니다. 자동완성에서 노선을 선택해주세요.`; setRouteStatus(reason, "error"); toast(reason); }
  return null;
}
function stationNameMarkup(name) {
  const match = String(name).match(/^(.*?)(\s*\([^)]*\))$/);
  if (!match) return `<span class="station-name-main">${escapeHTML(name)}</span>`;
  return `<span class="station-name-main">${escapeHTML(match[1].trim())}</span><span class="station-name-qualifier">${escapeHTML(match[2].trim())}</span>`;
}
function renderRecents() { els.recents.innerHTML = recent.slice(0, 4).map(station => `<button class="chip" data-recent="${station}">${station}</button>`).join(""); }
function stationLine(station) { const edge = graph.get(station)?.[0]; return edge?.line || "노선 정보"; }
function showSuggestions(input) {
  const target = input.dataset.role === "origin" ? els.originSuggestions : els.destinationSuggestions;
  const value = input.value.trim(); const matches = (value ? regionStations.filter(station => station.name.includes(value)) : regionStations).slice(0, 7);
  target.innerHTML = matches.map(station => `<button class="suggestion" type="button" data-pick-id="${station.id}" data-target="${input.dataset.role}"><span class="station-name">${stationNameMarkup(station.name)}</span><small>${escapeHTML(station.line)}</small></button>`).join(""); target.classList.toggle("show", matches.length > 0);
}
function closeSuggestions() { document.querySelectorAll(".suggestions").forEach(item => item.classList.remove("show")); }
function toast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 2500); }

function routeTimes(path, departureSeconds) {
  let time = departureSeconds;
  return path.map((stop, index) => {
    if (index) time += (path[index - 1].minutes || DEFAULT_TRAVEL_MINUTES) * 60;
    return time;
  });
}
function renderResult(result, forceExtras = false, scroll = true) {
  const { path, totalMinutes, preference } = result;
  const transfers = result.transfers ?? calculateTransfers(path); const stops = path.length;
  const now = new Date(); const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  currentRoute = { path, transfers, stops, totalMinutes, departureSeconds: nowSeconds, origin: els.origin.value.trim(), destination: els.destination.value.trim() };
  els.empty.classList.add("hidden"); els.results.classList.remove("hidden"); els.title.textContent = `${currentRoute.origin} → ${currentRoute.destination}`;
  els.metrics.innerHTML = [["fa-right-left","환승횟수",`${transfers}<small>회</small>`],["fa-train-subway","총 이동역",`${stops - 1}<small>개 역</small>`],["fa-clock","현재 시간",formatScheduleTime(nowSeconds)],["fa-train-subway","출발 시간",formatScheduleTime(nowSeconds)],["fa-clock","총 이동시간",`${totalMinutes}<small>분</small>`],["fa-flag-checkered","최종 도착 예정",formatScheduleTime(nowSeconds + totalMinutes * 60)]].map(([icon,label,value]) => `<div class="metric glass-card"><i class="fa-solid ${icon}"></i><p class="metric-label">${label}</p><strong>${value}</strong></div>`).join("");
  document.querySelector(".route-card-head h2").textContent = preference === "transfers" ? "최소 환승 경로" : "최단 시간 경로";
  const stationName = stop => stationById.get(stop.id)?.name || "역 정보 없음";
  const stopRegion = stop => stationById.get(stop.id)?.region || selectedRegion;
  const times = routeTimes(path, nowSeconds);
  renderRouteTimeline(path, times, stopRegion, stationName);
  els.stationDetails.innerHTML = [path[0], path.at(-1)].map((stop, i) => `<article class="station-card glass-card"><p class="eyebrow">${i ? "DESTINATION" : "ORIGIN"} STATION</p><h3>${stationNameMarkup(stationName(stop))}</h3><p class="station-line"><span class="line-color" style="background:${lineColor(stopRegion(stop), stop.line)}"></span> ${escapeHTML(stop.line)}</p><div class="station-info"><div>이전역<b>${i ? stationNameMarkup(stationName(path.at(-2))) : "출발역"}</b></div><div>다음역<b>${i ? "도착" : path[1] ? stationNameMarkup(stationName(path[1])) : "-"}</b></div><div>${i ? "도착 예정" : "출발 시간"}<b>${formatScheduleTime(times[i ? times.length - 1 : 0])}</b></div><div>이동시간<b>${totalMinutes}분</b></div></div></article>`).join("");
  document.getElementById("route-badge").textContent = "다음 열차 시간표 확인 중";
  updateFavoriteButton(); startExtrasRefresh(forceExtras); if (scroll) els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  return updateRouteSchedule(currentRoute);
}
function renderRouteTimeline(path, times, stopRegion, stationName) {
  const items = [];
  for (let i = 0; i < path.length; i += 1) {
    const stop = path[i]; const next = path[i + 1];
    const isSameStationTransfer = Boolean(stop.transfer && next && stationName(stop) === stationName(next));
    const label = i ? "도착 예정" : "출발";
    if (isSameStationTransfer) {
      items.push(`<div class="timeline-stop transfer" style="--route-color:${lineColor(stopRegion(next), next.line)}"><span class="stop-dot"></span><div class="stop-name">${stationNameMarkup(stationName(stop))}</div><div class="stop-line">${escapeHTML(stop.line)} → ${escapeHTML(next.line)} · 환승 완료 ${formatScheduleTime(times[i + 1])}</div><div class="transfer-note">환승: 다음 열차 시간표 반영</div></div>`);
      i += 1;
      continue;
    }
    items.push(`<div class="timeline-stop" style="--route-color:${lineColor(stopRegion(stop), stop.line)}"><span class="stop-dot"></span><div class="stop-name">${stationNameMarkup(stationName(stop))}</div><div class="stop-line">${escapeHTML(stop.line)} · ${label} ${formatScheduleTime(times[i])}</div></div>`);
  }
  els.timeline.innerHTML = items.join("");
}

function timeToSeconds(value, after = 0) {
  if (!/^\d{6}$/.test(String(value))) return null;
  let seconds = Number(value.slice(0, 2)) * 3600 + Number(value.slice(2, 4)) * 60 + Number(value.slice(4, 6));
  while (seconds < after) seconds += 24 * 60 * 60;
  return seconds;
}
function formatScheduleTime(seconds) {
  const time = seconds % (24 * 60 * 60);
  return `${String(Math.floor(time / 3600)).padStart(2, "0")}:${String(Math.floor(time % 3600 / 60)).padStart(2, "0")}`;
}
function nextScheduleRow(rows, after, terminalId = "") {
  return normaliseItems(rows).filter(row => !terminalId || row.endSubwayStationId === terminalId).map(row => ({ row, time: timeToSeconds(row.depTime, after) })).filter(item => item.time !== null).sort((a, b) => a.time - b.time)[0] || null;
}
async function getStationSchedules(stationId) {
  const dayType = currentDayType(); const key = `${stationId}:${dayType}`;
  let schedules = timetableCache.get(key);
  if (!schedules) {
    const [up, down] = await Promise.all(["U", "D"].map(upDownTypeCode => fetchTago("GetSubwaySttnAcctoSchdulList", { subwayStationId: stationId, dailyTypeCode: dayType, upDownTypeCode, numOfRows: "10000" })));
    schedules = [...normaliseItems(up), ...normaliseItems(down)];
    timetableCache.set(key, schedules);
  }
  return schedules;
}
async function getNextTrain(stationId, after, nextStationId = "") {
  const schedules = await getStationSchedules(stationId);
  if (!nextStationId) return nextScheduleRow(schedules, after);
  const nextSchedules = await getStationSchedules(nextStationId);
  const candidates = normaliseItems(schedules).map(row => {
    const time = timeToSeconds(row.depTime, after);
    const terminalId = row.endSubwayStationId || "";
    if (time === null || !terminalId) return null;
    const nextStop = nextScheduleRow(nextSchedules, time, terminalId);
    // A matching terminal at the next route stop identifies the train direction.
    if (!nextStop || nextStop.time - time > 20 * 60) return null;
    return { row, time, nextTime: nextStop.time };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
  return candidates[0] || nextScheduleRow(schedules, after);
}
async function updateRouteSchedule(route) {
  const stationName = stop => stationById.get(stop.id)?.name || "역 정보 없음";
  const stopRegion = stop => stationById.get(stop.id)?.region || selectedRegion;
  const times = routeTimes(route.path, route.departureSeconds);
  try {
    const firstTrain = await getNextTrain(route.path[0].id, route.departureSeconds, route.path[1]?.id);
    if (currentRoute !== route) return;
    if (!firstTrain) throw new Error("출발역 다음 열차 시간표를 찾지 못했습니다.");
    times[0] = firstTrain.time;
    if (times.length > 1) times[1] = firstTrain.nextTime || times[0] + (route.path[0].minutes || DEFAULT_TRAVEL_MINUTES) * 60;
    // Only query live timetables when boarding a train; graph weights cover in-line stops.
    for (let index = 1; index < route.path.length - 1; index += 1) {
      const edge = route.path[index];
      if (edge.transfer) {
        times[index + 1] = times[index] + (edge.minutes || DEFAULT_TRAVEL_MINUTES) * 60;
        const nextStop = route.path[index + 2];
        if (!nextStop) continue;
        const transferTrain = await getNextTrain(route.path[index + 1].id, times[index + 1], nextStop.id);
        if (currentRoute !== route) return;
        if (transferTrain) {
          const delay = transferTrain.time - times[index + 1];
          for (let later = index + 1; later < times.length; later += 1) times[later] += delay;
          times[index + 2] = transferTrain.nextTime || transferTrain.time + (route.path[index + 1].minutes || DEFAULT_TRAVEL_MINUTES) * 60;
        }
        continue;
      }
    }
    const actualMinutes = Math.max(0, Math.round((times.at(-1) - route.departureSeconds) / 60));
    route.departureSeconds = times[0]; route.totalMinutes = actualMinutes; route.times = times;
    const metricCards = els.metrics.querySelectorAll(".metric");
    if (metricCards[3]) metricCards[3].innerHTML = `<i class="fa-solid fa-train-subway"></i><p class="metric-label">다음 열차 출발</p><strong>${formatScheduleTime(times[0])}</strong>`;
    if (metricCards[4]) metricCards[4].innerHTML = `<i class="fa-solid fa-clock"></i><p class="metric-label">총 이동시간</p><strong>${actualMinutes}<small>분</small></strong>`;
    if (metricCards[5]) metricCards[5].innerHTML = `<i class="fa-solid fa-flag-checkered"></i><p class="metric-label">최종 도착 예정</p><strong>${formatScheduleTime(times.at(-1))}</strong>`;
    const stationCards = els.stationDetails.querySelectorAll(".station-card");
    if (stationCards[0]) stationCards[0].querySelector(".station-info div:nth-child(3) b").textContent = formatScheduleTime(times[0]);
    if (stationCards[1]) {
      stationCards[1].querySelector(".station-info div:nth-child(3) b").textContent = formatScheduleTime(times.at(-1));
      stationCards[1].querySelector(".station-info div:nth-child(4) b").textContent = `${actualMinutes}분`;
    }
    renderRouteTimeline(route.path, times, stopRegion, stationName);
    document.getElementById("route-badge").textContent = `도착 예정 ${formatScheduleTime(times.at(-1))}`;
    setRouteStatus(`다음 열차와 환승역 다음 열차를 반영한 추정값입니다. ${formatScheduleTime(times.at(-1))} 도착 예정입니다.`, "ready");
  } catch (error) {
    console.warn("Could not apply live timetable", error);
    if (currentRoute === route) document.getElementById("route-badge").textContent = "시간표 확인 실패 - 평균 이동시간 표시";
  }
}

function normaliseItems(items) { return Array.isArray(items) ? items : items ? [items] : []; }
function busField(item, names, matcher) {
  const direct = names.map(name => item[name]).find(value => value !== undefined && value !== null && String(value).trim());
  if (direct) return direct;
  return Object.entries(item).find(([key, value]) => value !== undefined && value !== null && String(value).trim() && matcher(key.toLowerCase()))?.[1] || "";
}
function busExitLabel(value, fallback) {
  const exit = String(value || fallback).trim();
  return /^\d+$/.test(exit) ? `${exit}번 출구` : exit;
}
function renderBuses(container, items, error = "") {
  const rows = normaliseItems(items);
  if (!rows.length) { container.textContent = error ? `버스 연계 정보를 불러오지 못했습니다. (${error})` : "이 역의 버스 연계 정보가 제공되지 않습니다."; return; }
  const groups = {};
  rows.forEach((item, index) => {
    const exit = busExitLabel(busField(item, ["exitNo", "exitNum", "exit", "exitNumber"], key => key.includes("exit") && /(no|num|number)/.test(key)), `${index + 1}번 출구`);
    const route = busField(item, ["busRouteNo", "routeNo", "busNo", "routeno", "busRouteNm", "busRouteName", "routeNumber"], key => (key.includes("route") || key.includes("bus")) && /(no|num|number|name|nm)/.test(key)) || "노선 정보";
    const routes = (groups[exit] ||= []);
    if (!routes.includes(route)) routes.push(route);
  });
  container.innerHTML = Object.entries(groups).map(([exit, routes]) => `<div class="exit-row"><span class="exit-label">${escapeHTML(exit)}</span><div class="bus-tags">${routes.map(route => `<span class="bus-tag">${escapeHTML(route)}</span>`).join("")}</div></div>`).join("");
}
function category(name) { const value = String(name).toLowerCase(); if (value.includes("카페")) return "카페"; if (value.includes("음식") || value.includes("식당")) return "음식점"; if (value.includes("편의")) return "편의점"; if (value.includes("은행")) return "은행"; if (value.includes("병원")) return "병원"; if (value.includes("약국")) return "약국"; if (value.includes("마트")) return "마트"; if (value.includes("버스")) return "버스정류장"; if (value.includes("택시")) return "택시승강장"; if (value.includes("주차")) return "주차장"; if (value.includes("화장")) return "화장실"; return "기타"; }
function facilityName(item) { return item.dirDesc || item.facilityName || item.fcltyNm || item.name || item.aroundInfo || "주변시설"; }
function renderFacilities() {
  const data = currentRoute?.extras?.[facilityStation]?.facilities; const enabled = [...document.querySelectorAll(".facility-filter:checked")].map(x => x.value); const items = normaliseItems(data);
  if (!items.length) { els.facilities.textContent = "API에서 주변시설 정보를 찾지 못했습니다."; return; }
  const filtered = items.filter(item => enabled.includes("전체") || enabled.includes(category(facilityName(item)))).slice(0, FACILITY_DISPLAY_LIMIT);
  els.facilities.innerHTML = filtered.length ? `<div class="facility-list">${filtered.map(item => `<div class="facility-item"><span>${iconFor(category(facilityName(item)))}</span>${escapeHTML(facilityName(item))}</div>`).join("")}</div>` : "선택한 필터에 해당하는 시설이 없습니다.";
}
function iconFor(kind) { return ({"카페":"☕","음식점":"🍔","편의점":"🏪","은행":"🏦","병원":"🏥","약국":"💊","마트":"🛒","버스정류장":"🚏","택시승강장":"🚖","주차장":"🅿","화장실":"🚻"}[kind] || "📍"); }
function renderFilters() { const types = ["전체","카페","음식점","편의점","은행","병원","약국","마트","버스정류장","택시승강장","화장실","주차장"]; els.filters.innerHTML = types.map((type, i) => `<label class="filter-label"><input class="facility-filter" value="${type}" type="checkbox" ${i === 0 ? "checked" : ""}/><span>${iconFor(type)} ${type}</span></label>`).join(""); }
async function loadExtras(forceRefresh = false) {
  if (extrasRequestInFlight || !selectedStationRecords.origin || !selectedStationRecords.destination) return;
  extrasRequestInFlight = true;
  const route = currentRoute; els.originBuses.textContent = "실제 버스 연계 정보를 불러오는 중..."; els.destinationBuses.textContent = "실제 버스 연계 정보를 불러오는 중..."; els.facilities.textContent = "실제 주변시설 정보를 불러오는 중...";
  try {
    const [origin, destination] = await Promise.all([
      getStationExtras(selectedStationRecords.origin, forceRefresh),
      getStationExtras(selectedStationRecords.destination, forceRefresh)
    ]);
    if (currentRoute !== route) return; route.extras = { origin, destination }; renderBuses(els.originBuses, origin.buses, origin.busError); renderBuses(els.destinationBuses, destination.buses, destination.busError); renderFacilities();
  } finally { extrasRequestInFlight = false; }
}
function startExtrasRefresh(forceRefresh = false) { loadExtras(forceRefresh); }
async function refreshDetails() {
  if (!currentRoute || extrasRequestInFlight) return;
  els.refresh.disabled = true;
  try {
    const now = new Date();
    currentRoute.departureSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    document.getElementById("route-badge").textContent = "현재 시각 기준 시간표 확인 중";
    const scheduleRefresh = updateRouteSchedule(currentRoute);
    const extrasRefresh = loadExtras(true);
    await Promise.all([scheduleRefresh, extrasRefresh]);
    toast("현재 시각 기준으로 다음 열차와 버스 연계 정보를 새로고침했습니다.");
  }
  catch (error) { console.warn("Could not refresh route", error); toast("새로고침에 실패했습니다. 잠시 후 다시 시도해주세요."); }
  finally { els.refresh.disabled = false; }
}
function updateFavoriteButton() { const key = `${els.origin.value.trim()}|${els.destination.value.trim()}`; const active = favorites.some(item => item.key === key); els.favorite.classList.toggle("active", active); els.favorite.innerHTML = `<i class="fa-${active ? "solid" : "regular"} fa-star"></i><span>${active ? "저장됨" : "즐겨찾기"}</span>`; }
function saveRecent(origin, destination) {
  recent = [origin, destination, ...recent.filter(value => value !== origin && value !== destination)].slice(0, 5);
  try { localStorage.setItem("metro-recent", JSON.stringify(recent)); }
  catch (error) { clearLegacyDetailCache(); try { localStorage.setItem("metro-recent", JSON.stringify(recent)); } catch { console.warn("Recent searches will not be persisted:", error); } }
  renderRecents();
}
function submitRoute(event) {
  event?.preventDefault();
  if (!catalogReady) { setRouteStatus("역 데이터를 아직 준비하고 있습니다. 잠시만 기다려주세요."); return toast("역 데이터를 불러오는 중입니다. 잠시 후 다시 시도해주세요."); }
  if (routeCalculationInFlight) return;
  const origin = els.origin.value.trim(); const destination = els.destination.value.trim();
  if (!origin || !destination) { setRouteStatus("출발역과 도착역을 모두 입력해주세요.", "error"); return toast("출발역과 도착역을 모두 입력해주세요."); }
  routeCalculationInFlight = true; setSearchState("calculating"); setRouteStatus("시간표 가중치 그래프에서 최단 경로를 계산하고 있습니다.");
  try {
    const originRecord = resolveStationInput("origin"); const destinationRecord = resolveStationInput("destination");
    const differentStations = originRecord?.id !== destinationRecord?.id;
    if (!originRecord || !destinationRecord) return;
    if (!differentStations) { setRouteStatus("출발역과 도착역은 서로 달라야 합니다.", "error"); return toast("서로 다른 역을 선택해주세요."); }
    if (!graph.has(originRecord.id) || !graph.has(destinationRecord.id)) { setRouteStatus("선택한 역의 경로 그래프 정보를 찾지 못했습니다.", "error"); return toast("목록에서 제공하는 역을 선택해주세요."); }
    const startedAt = performance.now();
    const preference = document.querySelector("input[name='preference']:checked")?.value || "time";
    const result = findRoute(originRecord.id, destinationRecord.id, preference);
    if (!result) { setRouteStatus("두 역 사이의 연결 경로를 찾지 못했습니다. 다른 노선의 역을 선택해보세요.", "error"); return toast("두 역 사이의 연결 경로를 찾지 못했습니다. 다른 노선의 역을 선택해보세요."); }
    saveRecent(origin, destination); renderResult(result);
    const routeLabel = preference === "transfers" ? "최소 환승 경로" : "최단 시간 경로";
    setRouteStatus(`${origin}에서 ${destination}까지 ${routeLabel}를 ${(performance.now() - startedAt).toFixed(1)}ms에 찾았습니다.`, "ready");
  } catch (error) {
    console.error("Route calculation failed", error);
    const message = `경로 계산 중 오류가 발생했습니다: ${error.message || "알 수 없는 오류"}`;
    setRouteStatus(message, "error");
    toast(message);
  } finally { routeCalculationInFlight = false; setSearchState("ready"); }
}

function bindEvents() {
  document.addEventListener("click", event => { const line = event.target.closest("[data-line]"); const station = event.target.closest("[data-station-id]"); const pick = event.target.closest("[data-pick-id]"); if (line) { const role = line.dataset.roleSelector; selections[role].line = line.dataset.line; renderTree(role); } else if (station || pick) { const button = station || pick; const role = button.dataset.roleSelector || button.dataset.target; const record = findStationRecord(button.dataset.stationId || button.dataset.pickId); if (record) { (role === "origin" ? els.origin : els.destination).value = record.name; selectedStationRecords[role] = record; const message = `${record.name}역을 ${role === "origin" ? "출발" : "도착"}역으로 선택했습니다.`; setRouteStatus(message, "ready"); toast(message); } closeSuggestions(); } const recentButton = event.target.closest("[data-recent]"); if (recentButton) { const input = !els.origin.value ? els.origin : els.destination; input.value = recentButton.dataset.recent; } });
  [els.origin, els.destination].forEach(input => input.addEventListener("input", () => { selectedStationRecords[input.dataset.role] = null; showSuggestions(input); }));
  document.addEventListener("click", event => { if (!event.target.closest(".station-field")) closeSuggestions(); });
  document.querySelectorAll("[data-clear]").forEach(button => button.addEventListener("click", () => { (button.dataset.clear === "origin" ? els.origin : els.destination).value = ""; selectedStationRecords[button.dataset.clear] = null; }));
  els.swap.addEventListener("click", () => { [els.origin.value, els.destination.value] = [els.destination.value, els.origin.value]; [selectedStationRecords.origin, selectedStationRecords.destination] = [selectedStationRecords.destination, selectedStationRecords.origin]; });
  els.region.addEventListener("change", () => { selectedRegion = els.region.value; Object.keys(selections).forEach(role => { selections[role].line = Object.keys(NETWORK_TREE[selectedRegion])[0]; selectedStationRecords[role] = null; renderTree(role); }); els.origin.value = ""; els.destination.value = ""; buildGraph(); closeSuggestions(); toast(`${selectedRegion} 지역 역만 검색할 수 있습니다.`); });
  els.form.addEventListener("submit", submitRoute);
  els.theme.addEventListener("click", () => { const dark = document.body.classList.toggle("dark"); els.theme.innerHTML = `<i class="fa-solid fa-${dark ? "sun" : "moon"}"></i>`; localStorage.setItem("metro-dark", dark); });
  els.refresh.addEventListener("click", refreshDetails);
  els.favorite.addEventListener("click", () => { if (!currentRoute) return; const key = `${currentRoute.origin}|${currentRoute.destination}`; const exists = favorites.some(item => item.key === key); favorites = exists ? favorites.filter(item => item.key !== key) : [...favorites, { key, origin: currentRoute.origin, destination: currentRoute.destination }]; localStorage.setItem("metro-favorites", JSON.stringify(favorites)); updateFavoriteButton(); toast(exists ? "즐겨찾기에서 삭제했습니다." : "경로를 즐겨찾기에 저장했습니다."); });
  els.favoritesButton.addEventListener("click", () => { if (!favorites.length) return toast("저장된 즐겨찾기 경로가 없습니다."); const item = favorites.at(-1); els.origin.value = item.origin; els.destination.value = item.destination; submitRoute(); });
  document.addEventListener("change", event => { if (event.target.matches(".facility-filter")) { const all = document.querySelector(".facility-filter[value='전체']"); if (event.target.value === "전체" && event.target.checked) document.querySelectorAll(".facility-filter:not([value='전체'])").forEach(input => input.checked = false); if (event.target.value !== "전체" && event.target.checked) all.checked = false; renderFacilities(); } });
  document.querySelectorAll(".station-tab").forEach(tab => tab.addEventListener("click", () => { facilityStation = tab.dataset.facilityStation; document.querySelectorAll(".station-tab").forEach(button => button.classList.toggle("active", button === tab)); renderFacilities(); }));
}
function init() {
  Object.assign(els, { region:$("#region-select"), originSelector:$("#origin-selector"), destinationSelector:$("#destination-selector"), origin:$("#origin-input"), destination:$("#destination-input"), originSuggestions:$("#origin-suggestions"), destinationSuggestions:$("#destination-suggestions"), form:$("#route-form"), searchButton:$("#search-button"), routeStatus:$("#route-status"), swap:$("#swap-button"), recents:$("#recent-searches"), empty:$("#empty-state"), results:$("#result-section"), title:$("#result-title"), metrics:$("#metric-grid"), timeline:$("#route-timeline"), stationDetails:$("#station-details"), originBuses:$("#origin-buses"), destinationBuses:$("#destination-buses"), facilities:$("#facilities-content"), filters:$("#facility-filters"), favorite:$("#favorite-route"), refresh:$("#refresh-details"), favoritesButton:$("#favorites-button"), theme:$("#theme-toggle"), toast:$("#toast") });
  clearLegacyDetailCache(); renderRecents(); renderFilters(); bindEvents(); loadStationCatalog(); if (localStorage.getItem("metro-dark") === "true") els.theme.click();
  const tick = () => { $("#live-time").textContent = new Date().toLocaleTimeString("ko-KR", { hour12:false }); }; tick(); setInterval(tick, 1000); setTimeout(() => $("#loading-screen").classList.add("done"), 550);
}
document.addEventListener("DOMContentLoaded", init);
