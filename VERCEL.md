# Vercel deployment

1. Import `shinhunji/METRO` into Vercel.
2. In **Project Settings > Environment Variables**, add `Seoul_Express_Train_key` with the TAGO key. Enable it for Production, Preview, and Development.
3. Deploy the project. Vercel serves the site from `프로젝트/` and exposes the secure proxy at `/api/tago`.

The `.env` file is only for local use and is ignored by Git. Do not commit the TAGO key.

## Static subway data

The app loads `프로젝트/station_catalog.json` and `프로젝트/weighted_graph.json` immediately at startup. The catalog is indexed as `region -> line -> stations`; the weighted graph is a station ID adjacency list with TAGO timetable weights, safe fallback weights for unavailable timetable pairs, and 5-minute transfer edges.

To refresh the static data from TAGO before a release, set `Seoul_Express_Train_key` locally and run:

```powershell
$env:Seoul_Express_Train_key = "your-tago-key"
node scripts/generate-subway-data.mjs
```

The generator validates representative Seoul, Busan, and Daegu transfer paths before writing the files. Commit the two generated JSON files. The API key is used only during generation and is never written to either file.
