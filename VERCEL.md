# Vercel deployment

1. Import `shinhunji/METRO` into Vercel.
2. In **Project Settings > Environment Variables**, add `SUBWAY_SERVICE_KEY` for subway timetable/station data and `BUS_SERVICE_KEY` for bus-route data. Enable both for Production, Preview, and Development. Subscribe the bus key to TAGO's `GetSubwaySttnExitAcctoBusRouteList` service before deploying.
3. Deploy the project. Vercel serves the site from `프로젝트/` and exposes the secure proxy at `/api/tago`.

> Important: Disable **Vercel Settings > Deployment Protection** for the production domain, or require visitors to sign in. Protected deployments redirect `station_catalog.json` and `weighted_graph.json` to Vercel's login page, which prevents the route finder from starting.

The `.env` file is only for local use and is ignored by Git. Do not commit the TAGO key.

## Static subway data

The app loads `프로젝트/station_catalog.json` and `프로젝트/weighted_graph.json` immediately at startup. The catalog is indexed as `region -> line -> stations`; the weighted graph is a station ID adjacency list with TAGO timetable weights, safe fallback weights for unavailable timetable pairs, and 5-minute transfer edges.

To refresh the static data from TAGO before a release, set `SUBWAY_SERVICE_KEY` locally and run:

```powershell
$env:SUBWAY_SERVICE_KEY = "your-tago-subway-service-key"
node scripts/generate-subway-data.mjs
```

The generator validates representative Seoul, Busan, and Daegu transfer paths before writing the files. Commit the two generated JSON files. The API key is used only during generation and is never written to either file.
