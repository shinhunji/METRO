"use strict";

// 국토교통부(TAGO) 지하철정보 OpenAPI 인증키입니다.
const SERVICE_KEY = "155e8b803b8707aa4b018864f3afb776cf4fe87e7119b01f4d74b7adfef8a59a";
// TAGO guide endpoint: the service path is SubwayInfo (not SubwayInfoService).
const API_BASE = "https://apis.data.go.kr/1613000/SubwayInfo";
const LINE_COLORS = {
  "수도권": { "1호선":"#0052A4", "2호선":"#00A84D", "3호선":"#EF7C1C", "4호선":"#00A5DE", "5호선":"#996CAC", "6호선":"#CD7C2F", "7호선":"#747F00", "8호선":"#E6186C", "9호선":"#BDB092", "GTX-A":"#9A6292", "경강":"#003DA5", "경의중앙":"#77C4A3", "경춘":"#0C8E72", "공항":"#0090D2", "김포골드라인":"#A17800", "서해선":"#8FC31F", "수인분당":"#F5A200", "신림선":"#6789CA", "신분당":"#D4003B", "에버라인":"#6FB245", "우이신설":"#B7C452", "의정부":"#FDA600", "인천1호선":"#6496D8", "인천2호선":"#ED8B00", "자기부상":"#FFCD12" },
  "부산": { "1호선":"#F06A00", "2호선":"#81BF48", "3호선":"#BB8C00", "4호선":"#217DCB", "동해":"#0054A6", "부산김해경전철":"#8652A1" },
  "대구": { "1호선":"#D93F5C", "2호선":"#00AA80", "3호선":"#FFB100", "대경선":"#0054A6" },
  "광주": { "1호선":"#009088" },
  "대전": { "1호선":"#007448" }
};
// Only these known interchange groups may link separate lines. Equal names alone never connect.
const TRANSFER_STATIONS = {
  "수도권": ["서울역", "시청", "종로3가", "동대문", "신설동", "동묘앞", "청량리", "신도림", "가산디지털단지", "노량진", "대방", "공덕", "홍대입구", "왕십리", "강남", "교대", "사당", "이수", "고속터미널", "잠실", "잠실새내", "건대입구", "신촌", "합정", "여의도", "영등포구청", "석계", "태릉입구", "군자", "상봉", "회기", "용산", "수원", "인천", "부평", "부천", "김포공항", "디지털미디어시티", "강남구청", "선릉", "도곡", "복정", "모란", "미금", "정자", "판교", "금정", "초지", "원인재", "검암", "계양", "주안", "회룡", "의정부", "도봉산", "광운대", "옥수", "이촌", "망우", "구로", "금천구청", "오금", "천호", "강동구청", "마곡나루", "까치산", "연신내", "불광", "충무로", "약수", "동대문역사문화공원", "을지로3가", "을지로4가", "충정로", "신길", "동작", "총신대입구", "석촌", "석촌고분", "종합운동장", "삼성", "신논현", "논현", "신사", "청구", "신금호", "미아사거리", "미아", "길음", "보문", "성신여대입구", "안암", "고려대", "월곡", "돌곶이", "상월곡", "화랑대", "먹골", "중화", "면목", "사가정", "용마산", "중곡", "어린이대공원", "뚝섬", "성수", "한양대", "압구정", "학동", "언주", "선정릉", "한티", "구룡", "개포동", "대모산입구", "수서", "가락시장", "문정", "장지", "산성", "남한산성입구", "단대오거리", "신흥", "수진", "태평"],
  "부산": ["서면", "연산", "수영", "덕천", "동래", "미남", "교대", "부전", "벡스코", "사상", "대저", "거제", "부암", "양산"],
  "대구": ["반월당", "명덕", "청라언덕", "신남", "만촌", "동대구", "대구역", "서대구", "구미", "경산"],
  "광주": [],
  "대전": []
};

// API로 받은 전국 역 데이터는 대한민국 -> 지역 -> 노선 -> 역 트리 객체로 변환됩니다.
let NETWORK_TREE = {};

const els = {};
let graph = new Map();
let allStations = []; let currentRoute = null; let facilityStation = "origin"; let selectedRegion = ""; let extrasRequestInFlight = false; let extrasRefreshTimer = null; let stationById = new Map();
const selections = { origin: { line: "" }, destination: { line: "" } };
const selectedStationRecords = { origin: null, destination: null };
let favorites = JSON.parse(localStorage.getItem("metro-favorites") || "[]");
let recent = JSON.parse(localStorage.getItem("metro-recent") || "[\"서울역\",\"강남\",\"부산역\"]");

const $ = (selector) => document.querySelector(selector);
function escapeHTML(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[char])); }
function lineColor(region, line) { return LINE_COLORS[region]?.[line] || "#0b76d1"; }

// Station IDs, not display names, are graph vertices so equal station names never create transfers.
function buildGraph() {
  graph = new Map();
  stationById = new Map();
  const connect = (from, to, line) => {
    if (!graph.has(from)) graph.set(from, []); if (!graph.has(to)) graph.set(to, []);
    graph.get(from).push({ to, line, distance: 1 });
    graph.get(to).push({ to: from, line, distance: 1 });
  };
  Object.values(NETWORK_TREE).forEach(region => Object.entries(region).forEach(([line, stations]) => {
    stations.forEach(station => { stationById.set(station.id, station); if (!graph.has(station.id)) graph.set(station.id, []); });
    for (let i = 0; i < stations.length - 1; i += 1) connect(stations[i].id, stations[i + 1].id, line);
  }));
  Object.entries(TRANSFER_STATIONS).forEach(([region, names]) => {
    const allowedNames = new Set(names);
    const grouped = new Map();
    [...stationById.values()].filter(station => station.region === region && allowedNames.has(station.name)).forEach(station => {
      if (!grouped.has(station.name)) grouped.set(station.name, []);
      grouped.get(station.name).push(station);
    });
    grouped.forEach(stations => {
      for (let index = 1; index < stations.length; index += 1) {
        // A physical transfer is a short, but non-zero, edge between explicitly listed station IDs.
        const from = stations[0]; const to = stations[index];
        graph.get(from.id).push({ to: to.id, line: to.line, distance: 0, transfer: true });
        graph.get(to.id).push({ to: from.id, line: from.line, distance: 0, transfer: true });
      }
    });
  });
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
async function loadStationCatalog() {
  els.originSelector.innerHTML = els.destinationSelector.innerHTML = `<p class="selector-loading"><i class="fa-solid fa-spinner fa-spin"></i> 실제 역 목록을 불러오는 중...</p>`;
  // An empty subwayStationName returns the complete nationwide station catalog (1,108 records).
  const stationItems = await fetchTago("GetKwrdFndSubwaySttnList", { subwayStationName: "", numOfRows: "10000", pageNo: "1" });
  NETWORK_TREE = buildStationTree(stationItems);
  if (!Object.keys(NETWORK_TREE).length) {
    const message = "실제 역 목록을 불러오지 못했습니다. TAGO 역 조회 API 주소와 요청 항목을 확인해주세요.";
    els.region.innerHTML = `<option>${message}</option>`; els.region.disabled = true; els.originSelector.innerHTML = els.destinationSelector.innerHTML = `<p class="selector-error"><i class="fa-solid fa-triangle-exclamation"></i> ${message}</p>`;
    toast("TAGO API에서 역 목록을 가져오지 못했습니다.");
    return;
  }
  selectedRegion = Object.keys(NETWORK_TREE)[0];
  els.region.innerHTML = Object.keys(NETWORK_TREE).map(region => `<option value="${escapeHTML(region)}">${escapeHTML(region)}</option>`).join(""); els.region.value = selectedRegion;
  Object.keys(selections).forEach(role => { selections[role].line = Object.keys(NETWORK_TREE[selectedRegion])[0]; });
  buildGraph(); renderTree("origin"); renderTree("destination");
}

// Dijkstra finds the least-cost path. Cost differs for time, distance, or transfers.
function dijkstra(start, end, preference) {
  const queue = [{ station: start, cost: 0, line: null, transfers: 0, path: [] }];
  const best = new Map([[`${start}|`, 0]]);
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const state = queue.shift();
    if (state.station === end) return [...state.path, { id: end, line: state.line }];
    for (const edge of graph.get(state.station) || []) {
      const isTransfer = Boolean(state.line && state.line !== edge.line);
        const weight = preference === "transfer" ? (isTransfer ? 12 : 1) : edge.distance;
      const nextCost = state.cost + weight;
      const key = `${edge.to}|${edge.line}`;
      if (nextCost < (best.get(key) ?? Infinity)) {
        best.set(key, nextCost);
        queue.push({ station: edge.to, cost: nextCost, line: edge.line, transfers: state.transfers + Number(isTransfer), path: [...state.path, { id: state.station, line: edge.line, transfer: Boolean(edge.transfer) }] });
      }
    }
  }
  return null;
}

// Function group: each calculation has a deterministic input/output relationship.
const calculateTransfers = path => path.slice(1).reduce((count, stop, index) => count + Number(stop.line !== path[index].line), 0);
const calculateFare = (stops, baseFare, extraFare) => baseFare + (stops <= 10 ? 0 : Math.ceil((stops - 10) / 5) * extraFare);
const calculateFares = stops => ({ adult: calculateFare(stops, 1400, 100), youth: calculateFare(stops, 800, 80), child: calculateFare(stops, 500, 50) });
const formatTime = date => date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

async function fetchTago(endpoint, params = {}) {
  const query = new URLSearchParams({ serviceKey: SERVICE_KEY, _type: "json", numOfRows: "50", pageNo: "1", ...params });
  try {
    const response = await fetch(`${API_BASE}/${endpoint}?${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const body = data.response?.body;
    const apiSucceeded = data.response?.header?.resultCode === "00" || Boolean(body);
    if (!apiSucceeded) throw new Error(data.response?.header?.resultMsg || "API 응답 오류");
    return body?.items?.item || [];
  } catch (error) { console.warn("TAGO API request failed:", endpoint, error); return null; }
}

function currentDayType() { const day = new Date().getDay(); return day === 0 ? "03" : day === 6 ? "02" : "01"; }
const CACHE_PREFIX = "metro-tago-v1:";
const STATIC_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
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
async function getCachedTago(key, endpoint, params, ttl, forceRefresh = false) {
  const cached = readCache(key);
  if (!forceRefresh && cached !== null) return cached;
  const data = await fetchTago(endpoint, params);
  writeCache(key, data, ttl);
  return data;
}
async function getStationExtras(station, forceRefresh = false) {
  const [buses, facilities] = await Promise.all([
    getCachedTago(`bus:${station.id}`, "GetSubwaySttnExitAcctoBusRouteList", { subwayStationId: station.id, numOfRows: "10000" }, STATIC_CACHE_TTL, forceRefresh),
    getCachedTago(`facility:${station.id}`, "GetSubwaySttnExitAcctoCfrFcltyList", { subwayStationId: station.id, numOfRows: "10000" }, STATIC_CACHE_TTL, forceRefresh)
  ]);
  return { buses, facilities };
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
  const lineButton = line => `<button class="selector-item ${line === state.line ? "selected" : ""}" data-line="${escapeHTML(line)}" data-role-selector="${role}"><span class="line-color" style="background:${lineColor(selectedRegion, line)}"></span>${escapeHTML(line)}<i class="fa-solid fa-chevron-right"></i></button>`;
  selector.innerHTML = `
    <div class="selector-column"><p class="selector-label"><i class="fa-solid fa-train-subway"></i> ${role === "origin" ? "출발" : "도착"} 노선</p><div class="selector-list line-selector-list">${lines.map(lineButton).join("")}</div></div>
    <div class="selector-column"><p class="selector-label"><i class="fa-solid fa-location-dot"></i> ${role === "origin" ? "출발" : "도착"} 역</p><div class="selector-list">${stations.map(station => `<button class="selector-item station-option" data-station-id="${station.id}" data-role-selector="${role}"><span class="station-pin"></span><span class="station-name">${stationNameMarkup(station.name)}</span></button>`).join("")}</div></div>`;
}
function findStationRecord(id) {
  for (const region of Object.values(NETWORK_TREE)) for (const stations of Object.values(region)) {
    const record = stations.find(station => station.id === id); if (record) return record;
  }
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
  const allowedStations = NETWORK_TREE[selectedRegion] ? Object.values(NETWORK_TREE[selectedRegion]).flat() : [];
  const value = input.value.trim(); const matches = (value ? allowedStations.filter(station => station.name.includes(value)) : allowedStations).slice(0, 7);
  target.innerHTML = matches.map(station => `<button class="suggestion" data-pick-id="${station.id}" data-target="${input.dataset.role}"><span class="station-name">${stationNameMarkup(station.name)}</span><small>${escapeHTML(station.line)}</small></button>`).join(""); target.classList.toggle("show", matches.length > 0);
}
function closeSuggestions() { document.querySelectorAll(".suggestions").forEach(item => item.classList.remove("show")); }
function toast(message) { els.toast.textContent = message; els.toast.classList.add("show"); setTimeout(() => els.toast.classList.remove("show"), 2500); }

function renderResult(path) {
  const transfers = calculateTransfers(path); const stops = path.length;
  const fares = calculateFares(stops);
  currentRoute = { path, transfers, stops, origin: els.origin.value.trim(), destination: els.destination.value.trim() };
  els.empty.classList.add("hidden"); els.results.classList.remove("hidden"); els.title.textContent = `${currentRoute.origin} → ${currentRoute.destination}`;
  const fareBreakdown = `성인 ${fares.adult.toLocaleString()}원<br><small>청소년 ${fares.youth.toLocaleString()}원 · 어린이 ${fares.child.toLocaleString()}원</small>`;
  els.metrics.innerHTML = [["fa-right-left","환승횟수",`${transfers}<small>회</small>`],["fa-train-subway","총 이동역",`${stops - 1}<small>개 역</small>`],["fa-clock","출발역 다음 열차",`<small>시간표를 확인하는 중</small>`],["fa-arrow-right-from-bracket","운행 방향",`<small>하행 (D)</small>`],["fa-won-sign","예상요금",fareBreakdown]].map(([icon,label,value]) => `<div class="metric glass-card"><i class="fa-solid ${icon}"></i><p class="metric-label">${label}</p><strong>${value}</strong></div>`).join("");
  const stationName = stop => stationById.get(stop.id)?.name || "역 정보 없음";
  const stopRegion = stop => stationById.get(stop.id)?.region || selectedRegion;
  els.timeline.innerHTML = path.map((stop, i) => { const transfer = i > 0 && stop.line !== path[i - 1].line; return `<div class="timeline-stop ${transfer ? "transfer" : ""}" style="--route-color:${lineColor(stopRegion(stop), stop.line)}"><span class="stop-dot"></span><div class="stop-name">${stationNameMarkup(stationName(stop))}</div><div class="stop-line">${escapeHTML(stop.line)}</div>${transfer ? "<div class=\"transfer-note\">환승 +5분</div>" : ""}</div>`; }).join("");
  els.stationDetails.innerHTML = [path[0], path.at(-1)].map((stop, i) => `<article class="station-card glass-card"><p class="eyebrow">${i ? "DESTINATION" : "ORIGIN"} STATION</p><h3>${stationNameMarkup(stationName(stop))}</h3><p class="station-line"><span class="line-color" style="background:${lineColor(stopRegion(stop), stop.line)}"></span> ${escapeHTML(stop.line)}</p><div class="station-info"><div>이전역<b>${i ? stationNameMarkup(stationName(path.at(-2))) : "출발역"}</b></div><div>다음역<b>${i ? "도착" : path[1] ? stationNameMarkup(stationName(path[1])) : "-"}</b></div><div>${i ? "시간표 안내" : "다음 열차"}<b>${i ? "출발역 기준 안내" : "시간표 확인 중"}</b></div><div>${i ? "운행 방향" : "조회 기준"}<b>${i ? "하행 (D)" : "출발역 하행 (D)"}</b></div></div></article>`).join("");
  document.getElementById("route-badge").textContent = "시간표 확인 중";
  updateFavoriteButton(); startExtrasRefresh(); els.results.scrollIntoView({ behavior: "smooth", block: "start" });
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
async function loadOriginSchedule(route, forceRefresh) {
  const origin = selectedStationRecords.origin;
  if (!origin) return null;
  const dayType = currentDayType();
  const schedules = await getCachedTago(`timetable:${origin.id}:${dayType}:D`, "GetSubwaySttnAcctoSchdulList", { subwayStationId: origin.id, dailyTypeCode: dayType, upDownTypeCode: "D", numOfRows: "10000" }, TIMETABLE_CACHE_TTL, forceRefresh);
  const now = new Date(); const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const departure = nextScheduleRow(schedules, nowSeconds);
  return departure ? { time: departure.time, terminal: departure.row.endSubwayStationName || departure.row.endSubwayStationId || "" } : null;
}
function updateOriginSchedule(route, schedule) {
  if (currentRoute !== route) return;
  const metricCards = els.metrics.querySelectorAll(".metric");
  if (!schedule) {
    if (metricCards[2]) metricCards[2].innerHTML = `<i class="fa-solid fa-clock"></i><p class="metric-label">출발역 다음 열차</p><strong><small>시간표 없음</small></strong>`;
    const originCard = els.stationDetails.querySelector(".station-card");
    if (originCard) originCard.querySelector(".station-info div:nth-child(3) b").textContent = "시간표 없음";
    document.getElementById("route-badge").textContent = "출발역 시간표 없음";
    return;
  }
  const departure = formatScheduleTime(schedule.time);
  route.nextDeparture = departure;
  if (metricCards[2]) metricCards[2].innerHTML = `<i class="fa-solid fa-clock"></i><p class="metric-label">출발역 다음 열차</p><strong>${departure}<small>${escapeHTML(schedule.terminal || "하행 (D)")}</small></strong>`;
  const originCard = els.stationDetails.querySelector(".station-card");
  if (originCard) originCard.querySelector(".station-info div:nth-child(3) b").textContent = departure;
  document.getElementById("route-badge").textContent = `다음 열차 ${departure}`;
}

function normaliseItems(items) { return Array.isArray(items) ? items : items ? [items] : []; }
function renderBuses(container, items) {
  const rows = normaliseItems(items); if (!rows.length) { container.textContent = "API에서 버스 연계 정보를 찾지 못했습니다."; return; }
  const groups = {}; rows.forEach((item, index) => { const exit = item.exitNo || item.exitNum || item.exit || `${index + 1}번 출구`; const route = item.busRouteNo || item.routeNo || item.busNo || item.routeno || "노선 정보"; (groups[exit] ||= []).push(route); });
  container.innerHTML = Object.entries(groups).map(([exit, routes]) => `<div class="exit-row"><span class="exit-label">${escapeHTML(exit)}</span><div class="bus-tags">${routes.map(route => `<span class="bus-tag">${escapeHTML(route)}</span>`).join("")}</div></div>`).join("");
}
function category(name) { const value = String(name).toLowerCase(); if (value.includes("카페")) return "카페"; if (value.includes("음식") || value.includes("식당")) return "음식점"; if (value.includes("편의")) return "편의점"; if (value.includes("은행")) return "은행"; if (value.includes("병원")) return "병원"; if (value.includes("약국")) return "약국"; if (value.includes("마트")) return "마트"; if (value.includes("버스")) return "버스정류장"; if (value.includes("택시")) return "택시승강장"; if (value.includes("주차")) return "주차장"; if (value.includes("화장")) return "화장실"; return "기타"; }
function facilityName(item) { return item.dirDesc || item.facilityName || item.fcltyNm || item.name || item.aroundInfo || "주변시설"; }
function renderFacilities() {
  const data = currentRoute?.extras?.[facilityStation]?.facilities; const enabled = [...document.querySelectorAll(".facility-filter:checked")].map(x => x.value); const items = normaliseItems(data);
  if (!items.length) { els.facilities.textContent = "API에서 주변시설 정보를 찾지 못했습니다."; return; }
  const filtered = items.filter(item => enabled.includes("전체") || enabled.includes(category(facilityName(item))));
  els.facilities.innerHTML = filtered.length ? `<div class="facility-list">${filtered.map(item => `<div class="facility-item"><span>${iconFor(category(facilityName(item)))}</span>${escapeHTML(facilityName(item))}</div>`).join("")}</div>` : "선택한 필터에 해당하는 시설이 없습니다.";
}
function iconFor(kind) { return ({"카페":"☕","음식점":"🍔","편의점":"🏪","은행":"🏦","병원":"🏥","약국":"💊","마트":"🛒","버스정류장":"🚏","택시승강장":"🚖","주차장":"🅿","화장실":"🚻"}[kind] || "📍"); }
function renderFilters() { const types = ["전체","카페","음식점","편의점","은행","병원","약국","마트","버스정류장","택시승강장","화장실","주차장"]; els.filters.innerHTML = types.map((type, i) => `<label class="filter-label"><input class="facility-filter" value="${type}" type="checkbox" ${i === 0 ? "checked" : ""}/><span>${iconFor(type)} ${type}</span></label>`).join(""); }
async function loadExtras(forceRefresh = false) {
  if (extrasRequestInFlight || !selectedStationRecords.origin || !selectedStationRecords.destination) return;
  extrasRequestInFlight = true;
  const route = currentRoute; els.originBuses.textContent = "실제 버스 연계 정보를 불러오는 중..."; els.destinationBuses.textContent = "실제 버스 연계 정보를 불러오는 중..."; els.facilities.textContent = "실제 주변시설 정보를 불러오는 중...";
  try {
    const [origin, destination, schedule] = await Promise.all([
      getStationExtras(selectedStationRecords.origin, forceRefresh),
      getStationExtras(selectedStationRecords.destination, forceRefresh),
      loadOriginSchedule(route, forceRefresh)
    ]);
    if (currentRoute !== route) return; route.extras = { origin, destination }; renderBuses(els.originBuses, origin.buses); renderBuses(els.destinationBuses, destination.buses); renderFacilities();
    updateOriginSchedule(route, schedule);
  } finally { extrasRequestInFlight = false; }
}
function startExtrasRefresh() {
  clearInterval(extrasRefreshTimer);
  loadExtras(true);
  // The visible route uses fresh TAGO detail data every 30 seconds.
  extrasRefreshTimer = setInterval(() => loadExtras(true), 30000);
}
async function refreshDetails() {
  if (!currentRoute || extrasRequestInFlight) return;
  els.refresh.disabled = true;
  try { await loadExtras(true); toast("최신 역 정보를 불러왔습니다."); }
  finally { els.refresh.disabled = false; }
}
function updateFavoriteButton() { const key = `${els.origin.value.trim()}|${els.destination.value.trim()}`; const active = favorites.some(item => item.key === key); els.favorite.classList.toggle("active", active); els.favorite.innerHTML = `<i class="fa-${active ? "solid" : "regular"} fa-star"></i><span>${active ? "저장됨" : "즐겨찾기"}</span>`; }
function saveRecent(origin, destination) { recent = [origin, destination, ...recent.filter(value => value !== origin && value !== destination)].slice(0, 5); localStorage.setItem("metro-recent", JSON.stringify(recent)); renderRecents(); }
function submitRoute(event) { event?.preventDefault(); const origin = els.origin.value.trim(); const destination = els.destination.value.trim(); const originRecord = selectedStationRecords.origin; const destinationRecord = selectedStationRecords.destination; const inputsValid = Boolean(origin && destination); const stationsSelected = Boolean(originRecord && destinationRecord); const differentStations = originRecord?.id !== destinationRecord?.id; if (!inputsValid) return toast("출발역과 도착역을 모두 선택해주세요."); if (!stationsSelected) return toast("자동완성 또는 노선·역 목록에서 실제 역을 선택해주세요."); if (!differentStations) return toast("서로 다른 역을 선택해주세요."); if (!graph.has(originRecord.id) || !graph.has(destinationRecord.id)) return toast("목록에서 제공하는 역을 선택해주세요."); const preference = document.querySelector("input[name=preference]:checked").value; const path = dijkstra(originRecord.id, destinationRecord.id, preference); if (!path) return toast("두 역 사이의 연결 경로를 찾지 못했습니다."); saveRecent(origin, destination); renderResult(path); }

function bindEvents() {
  document.addEventListener("click", event => { const line = event.target.closest("[data-line]"); const station = event.target.closest("[data-station-id]"); const pick = event.target.closest("[data-pick-id]"); if (line) { const role = line.dataset.roleSelector; selections[role].line = line.dataset.line; renderTree(role); } else if (station || pick) { const button = station || pick; const role = button.dataset.roleSelector || button.dataset.target; const record = findStationRecord(button.dataset.stationId || button.dataset.pickId); if (record) { (role === "origin" ? els.origin : els.destination).value = record.name; selectedStationRecords[role] = record; toast(`${record.name}역을 ${role === "origin" ? "출발" : "도착"}역으로 선택했습니다.`); } closeSuggestions(); } const recentButton = event.target.closest("[data-recent]"); if (recentButton) { const input = !els.origin.value ? els.origin : els.destination; input.value = recentButton.dataset.recent; } });
  [els.origin, els.destination].forEach(input => input.addEventListener("input", () => { selectedStationRecords[input.dataset.role] = null; showSuggestions(input); }));
  document.addEventListener("click", event => { if (!event.target.closest(".station-field")) closeSuggestions(); });
  document.querySelectorAll("[data-clear]").forEach(button => button.addEventListener("click", () => { (button.dataset.clear === "origin" ? els.origin : els.destination).value = ""; selectedStationRecords[button.dataset.clear] = null; }));
  els.swap.addEventListener("click", () => { [els.origin.value, els.destination.value] = [els.destination.value, els.origin.value]; [selectedStationRecords.origin, selectedStationRecords.destination] = [selectedStationRecords.destination, selectedStationRecords.origin]; });
  els.region.addEventListener("change", () => { selectedRegion = els.region.value; Object.keys(selections).forEach(role => { selections[role].line = Object.keys(NETWORK_TREE[selectedRegion])[0]; selectedStationRecords[role] = null; renderTree(role); }); els.origin.value = ""; els.destination.value = ""; closeSuggestions(); toast(`${selectedRegion} 지역 역만 검색할 수 있습니다.`); });
  els.form.addEventListener("submit", submitRoute);
  els.theme.addEventListener("click", () => { const dark = document.body.classList.toggle("dark"); els.theme.innerHTML = `<i class="fa-solid fa-${dark ? "sun" : "moon"}"></i>`; localStorage.setItem("metro-dark", dark); });
  els.refresh.addEventListener("click", refreshDetails);
  els.favorite.addEventListener("click", () => { if (!currentRoute) return; const key = `${currentRoute.origin}|${currentRoute.destination}`; const exists = favorites.some(item => item.key === key); favorites = exists ? favorites.filter(item => item.key !== key) : [...favorites, { key, origin: currentRoute.origin, destination: currentRoute.destination }]; localStorage.setItem("metro-favorites", JSON.stringify(favorites)); updateFavoriteButton(); toast(exists ? "즐겨찾기에서 삭제했습니다." : "경로를 즐겨찾기에 저장했습니다."); });
  els.favoritesButton.addEventListener("click", () => { if (!favorites.length) return toast("저장된 즐겨찾기 경로가 없습니다."); const item = favorites.at(-1); els.origin.value = item.origin; els.destination.value = item.destination; submitRoute(); });
  document.addEventListener("change", event => { if (event.target.matches(".facility-filter")) { const all = document.querySelector(".facility-filter[value='전체']"); if (event.target.value === "전체" && event.target.checked) document.querySelectorAll(".facility-filter:not([value='전체'])").forEach(input => input.checked = false); if (event.target.value !== "전체" && event.target.checked) all.checked = false; renderFacilities(); } });
  document.querySelectorAll(".station-tab").forEach(tab => tab.addEventListener("click", () => { facilityStation = tab.dataset.facilityStation; document.querySelectorAll(".station-tab").forEach(button => button.classList.toggle("active", button === tab)); renderFacilities(); }));
}
function init() {
  Object.assign(els, { region:$("#region-select"), originSelector:$("#origin-selector"), destinationSelector:$("#destination-selector"), origin:$("#origin-input"), destination:$("#destination-input"), originSuggestions:$("#origin-suggestions"), destinationSuggestions:$("#destination-suggestions"), form:$("#route-form"), swap:$("#swap-button"), recents:$("#recent-searches"), empty:$("#empty-state"), results:$("#result-section"), title:$("#result-title"), metrics:$("#metric-grid"), timeline:$("#route-timeline"), stationDetails:$("#station-details"), originBuses:$("#origin-buses"), destinationBuses:$("#destination-buses"), facilities:$("#facilities-content"), filters:$("#facility-filters"), favorite:$("#favorite-route"), refresh:$("#refresh-details"), favoritesButton:$("#favorites-button"), theme:$("#theme-toggle"), toast:$("#toast") });
  renderRecents(); renderFilters(); bindEvents(); loadStationCatalog(); if (localStorage.getItem("metro-dark") === "true") els.theme.click();
  const tick = () => { $("#live-time").textContent = new Date().toLocaleTimeString("ko-KR", { hour12:false }); }; tick(); setInterval(tick, 1000); setTimeout(() => $("#loading-screen").classList.add("done"), 550);
}
document.addEventListener("DOMContentLoaded", init);
