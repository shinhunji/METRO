# Vercel deployment

1. Import `shinhunji/METRO` into Vercel.
2. In **Project Settings > Environment Variables**, add `Seoul_Express_Train_key` with the TAGO key. Enable it for Production, Preview, and Development.
3. Deploy the project. Vercel serves the site from `프로젝트/` and exposes the secure proxy at `/api/tago`.

The `.env` file is only for local use and is ignored by Git. Do not commit the TAGO key.
