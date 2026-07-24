# DogScheduler

Medication calendar for a dog: a month grid with per-day AM/PM dose
checklists. Checks sync across devices through a Cloudflare Worker + KV
backend (`worker/`) guarded by a shared sync token; each device keeps a
localStorage cache and an offline op queue, so checking off a dose never
waits on the network. Installable as a PWA (Add to Home Screen).
Medications are managed in-app (Meds screen) and sync as data; the seed
schedules live in `src/schedule.ts`. Design specs are in
`docs/superpowers/specs/`.

Built with [SolidJS](https://solidjs.com/) and [Vite](https://vite.dev/).

**Live site:** https://nicholaspsmith.github.io/DogScheduler/

## Development

```sh
npm install
npm run dev      # local dev server with HMR
npm run build    # production build to dist/
npm run preview  # preview the production build
```

## Deployment

Pushes to `main` are automatically built and deployed to GitHub Pages via
`.github/workflows/deploy.yml`.

## Sync backend

The Worker lives in `worker/` and deploys manually:

```sh
cd worker && wrangler deploy
```

One-time provisioning was: `wrangler login`, `wrangler kv namespace create
KV` (id goes in `worker/wrangler.toml`), `wrangler secret put SYNC_TOKEN`
(a random token, also pasted into each device via the app's setup screen).
The Worker URL is hardcoded in `src/config.ts`.

## License

[MIT](LICENSE)
