# DogScheduler

Medication calendar for a dog: a month grid with per-day AM/PM dose
checklists. Checked doses persist in the browser's localStorage. Schedules
live as declarative rules in `src/schedule.ts`; the design spec is in
`docs/superpowers/specs/2026-07-22-medication-calendar-design.md`.

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

## License

[MIT](LICENSE)
