import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const serviceKey = process.env.SUBWAY_SERVICE_KEY;
if (!serviceKey) throw new Error("Set SUBWAY_SERVICE_KEY before generating static subway JSON data.");

const outputDirectory = resolve("프로젝트");
const baseUrl = "https://apis.data.go.kr/1613000/SubwayInfo";
const dayType = process.env.SUBWAY_DAY_TYPE || "01";
const defaultTravelMinutes = 3;
const transferMinutes = 5;
const transferStations = {
  "수도권": ["서울역", "시청", "종로3가", "동대문", "신설동", "동묘앞", "청량리", "신도림", "가산디지털단지", "노량진", "대방", "공덕", "홍대입구", "왕십리", "강남", "교대", "사당", "이수", "고속터미널", "잠실", "잠실새내", "건대입구", "신촌", "합정", "여의도", "영등포구청", "석계", "태릉입구", "군자", "상봉", "회기", "용산", "수원", "인천", "부평", "부천", "김포공항", "디지털미디어시티", "강남구청", "선릉", "도곡", "복정", "모란", "미금", "정자", "판교", "금정", "초지", "원인재", "검암", "계양", "주안", "회룡", "의정부", "도봉산", "광운대", "옥수", "이촌", "망우", "구로", "금천구청", "오금", "천호", "강동구청", "마곡나루", "까치산", "연신내", "불광", "충무로", "약수", "동대문역사문화공원", "을지로3가", "을지로4가", "충정로", "신길", "동작", "총신대입구", "석촌", "석촌고분", "종합운동장", "삼성", "신논현", "논현", "신사", "청구", "신금호", "미아사거리", "미아", "길음", "보문", "성신여대입구", "안암", "고려대", "월곡", "돌곶이", "상월곡", "화랑대", "먹골", "중화", "면목", "사가정", "용마산", "중곡", "어린이대공원", "뚝섬", "성수", "한양대", "압구정", "학동", "언주", "선정릉", "한티", "구룡", "개포동", "대모산입구", "수서", "가락시장", "문정", "장지", "산성", "남한산성입구", "단대오거리", "신흥", "수진", "태평"],
  "부산": ["서면", "연산", "수영", "덕천", "동래", "미남", "교대", "부전", "벡스코", "사상", "대저", "거제", "부암", "양산"],
  "대구": ["반월당", "명덕", "청라언덕", "신남", "만촌", "동대구", "대구역", "서대구", "구미", "경산"],
  "광주": [],
  "대전": []
};
// Some TAGO transfer stations use qualified names, so connect these known ID pairs directly.
const explicitTransferPairs = [
  ["MTRBGB10101", "MTRBS2227"] // 부산김해경전철 사상 <-> 부산 2호선 사상
];
const endpoint = async (name, params) => {
  const url = new URL(`${baseUrl}/${name}`);
  url.search = new URLSearchParams({ serviceKey, _type: "json", numOfRows: "10000", pageNo: "1", ...params });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name} failed: ${response.status}`);
  const payload = await response.json();
  return payload.response?.body?.items?.item || [];
};
const items = value => Array.isArray(value) ? value : value ? [value] : [];
const regions = {};
const regionFor = (id, line) => id.startsWith("MTRB") || line === "동해" ? "부산" : id.startsWith("MTRDG") || id.startsWith("MTRKRK7K") ? "대구" : id.startsWith("MTRGJ") ? "광주" : id.startsWith("MTRDJ") ? "대전" : "수도권";
const catalogRows = items(await endpoint("GetKwrdFndSubwaySttnList", { subwayStationName: "" }));
for (const row of catalogRows) {
  const id = row.subwayStationId; const line = row.subwayRouteName; const name = row.subwayStationName;
  if (!id || !line || !name) continue;
  const region = regionFor(id, line);
  const stations = (((regions[region] ||= {}).lines ||= {})[line] ||= { stations: [] }).stations;
  if (!stations.some(station => station.id === id)) stations.push({ id, name });
}
const seconds = value => /^\d{6}$/.test(String(value)) ? Number(value.slice(0, 2)) * 3600 + Number(value.slice(2, 4)) * 60 + Number(value.slice(4, 6)) : null;
const median = values => { const sorted = values.filter(value => value >= 0.5 && value <= 15).sort((a, b) => a - b); if (!sorted.length) return null; const index = Math.floor(sorted.length / 2); return Math.round(sorted.length % 2 ? sorted[index] : (sorted[index - 1] + sorted[index]) / 2); };
const segmentMinutes = (fromRows, toRows) => {
  const destinations = new Map();
  for (const row of items(toRows)) { const terminal = row.endSubwayStationId || row.endSubwayStationName || ""; const time = seconds(row.depTime); if (time !== null) (destinations.get(terminal) || destinations.set(terminal, []).get(terminal)).push(time); }
  destinations.forEach(times => times.sort((a, b) => a - b));
  const values = [];
  for (const row of items(fromRows)) { const start = seconds(row.depTime); const times = destinations.get(row.endSubwayStationId || row.endSubwayStationName || ""); if (start === null || !times?.length) continue; let end = times.find(time => time >= start); if (end === undefined) end = times[0] + 86400; values.push((end - start) / 60); }
  return median(values);
};
const stationGraph = {};
const addEdge = (from, to, minutes, source) => { (stationGraph[from] ||= {})[to] = { minutes, source }; };
const allStations = Object.values(regions).flatMap(region => Object.values(region.lines).flatMap(line => line.stations));
const schedules = new Map();
const requests = allStations.flatMap(station => ["U", "D"].map(direction => ({ station, direction })));
const worker = async () => {
  while (requests.length) {
    const { station, direction } = requests.shift();
    schedules.set(`${station.id}:${direction}`, await endpoint("GetSubwaySttnAcctoSchdulList", { subwayStationId: station.id, dailyTypeCode: dayType, upDownTypeCode: direction }));
  }
};
await Promise.all(Array.from({ length: 8 }, worker));
for (const region of Object.values(regions)) for (const line of Object.values(region.lines)) {
  for (let index = 0; index < line.stations.length - 1; index += 1) for (const direction of ["U", "D"]) {
    const from = line.stations[index]; const to = line.stations[index + 1];
    const forward = segmentMinutes(schedules.get(`${from.id}:${direction}`), schedules.get(`${to.id}:${direction}`));
    const backward = segmentMinutes(schedules.get(`${to.id}:${direction}`), schedules.get(`${from.id}:${direction}`));
    addEdge(from.id, to.id, forward || defaultTravelMinutes, forward ? "TAGO timetable" : "catalog fallback");
    addEdge(to.id, from.id, backward || defaultTravelMinutes, backward ? "TAGO timetable" : "catalog fallback");
  }
}
for (const [regionName, names] of Object.entries(transferStations)) {
  const allowedNames = new Set(names);
  const grouped = new Map();
  for (const line of Object.values(regions[regionName]?.lines || {})) for (const station of line.stations) {
    const normalizedName = station.name.replace(/\s*\([^)]*\)\s*$/, "");
    if (!allowedNames.has(normalizedName)) continue;
    (grouped.get(normalizedName) || grouped.set(normalizedName, []).get(normalizedName)).push(station);
  }
  for (const stations of grouped.values()) for (let index = 1; index < stations.length; index += 1) {
    addEdge(stations[0].id, stations[index].id, transferMinutes, "transfer");
    addEdge(stations[index].id, stations[0].id, transferMinutes, "transfer");
  }
}
for (const [from, to] of explicitTransferPairs) {
  addEdge(from, to, transferMinutes, "transfer");
  addEdge(to, from, transferMinutes, "transfer");
}
const hasPath = (start, end) => {
  const visited = new Set([start]); const queue = [start];
  while (queue.length) {
    const station = queue.shift();
    if (station === end) return true;
    for (const next of Object.keys(stationGraph[station] || {})) if (!visited.has(next)) { visited.add(next); queue.push(next); }
  }
  return false;
};
const stationId = (region, line, name) => regions[region]?.lines?.[line]?.stations.find(station => station.name === name)?.id;
const requiredRoutes = [
  [stationId("수도권", "1호선", "서울역"), stationId("수도권", "4호선", "서울역"), "수도권 서울역 환승"],
  [stationId("부산", "1호선", "서면"), stationId("부산", "2호선", "서면"), "부산 서면 환승"],
  ["MTRBGB10101", "MTRBS2227", "부산김해경전철 사상 환승"],
  [stationId("대구", "1호선", "반월당"), stationId("대구", "2호선", "반월당"), "대구 반월당 환승"]
];
for (const [start, end, label] of requiredRoutes) {
  if (!start || !end || !hasPath(start, end)) throw new Error(`Static graph validation failed: ${label}`);
}
const generatedAt = new Date().toISOString();
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "station_catalog.json"), JSON.stringify({ version: 1, generatedAt, regions }, null, 2) + "\n"),
  writeFile(resolve(outputDirectory, "weighted_graph.json"), JSON.stringify({ version: 1, generatedAt, dayType, stationGraph }, null, 2) + "\n")
]);
console.log(`Generated static subway data for ${catalogRows.length} stations with ${Object.values(stationGraph).reduce((count, edges) => count + Object.keys(edges).length, 0)} edges.`);
