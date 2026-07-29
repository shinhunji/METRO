import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const serviceKey = process.env.Seoul_Express_Train_key;
if (!serviceKey) throw new Error("Set Seoul_Express_Train_key before generating static subway JSON data.");

const outputDirectory = resolve("프로젝트");
const baseUrl = "https://apis.data.go.kr/1613000/SubwayInfo";
const dayType = process.env.SUBWAY_DAY_TYPE || "01";
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
    if (forward) (stationGraph[from.id] ||= {})[to.id] = { minutes: forward, source: "TAGO timetable" };
    if (backward) (stationGraph[to.id] ||= {})[from.id] = { minutes: backward, source: "TAGO timetable" };
  }
}
const generatedAt = new Date().toISOString();
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "station_catalog.json"), JSON.stringify({ version: 1, generatedAt, regions }, null, 2) + "\n"),
  writeFile(resolve(outputDirectory, "weighted_graph.json"), JSON.stringify({ version: 1, generatedAt, dayType, stationGraph }, null, 2) + "\n")
]);
console.log(`Generated static subway data for ${catalogRows.length} stations.`);
