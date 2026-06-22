# Contributing

Thanks for helping build the Jetty SDK. This is an npm-workspaces monorepo
(Node 18+).

## Setup

```bash
npm install
npm run build        # build @jetty/sdk
npm test             # vitest
npm run typecheck    # all workspaces
```

## Layout

- `packages/sdk` — the `@jetty/sdk` TypeScript client. Source in `src/`, tests in `tests/`.
- `examples/flue-jetty` — the flagship example (A/B agent eval); depends on the workspace `@jetty/sdk`.

## Conventions

- **ESM only**, `NodeNext` module resolution. Use `.js` extensions in relative
  imports (e.g. `import { x } from "./errors.js"`) — they resolve to `.ts` at
  build time.
- **Strict TypeScript.** No `any` on public signatures; mirror backend models in
  `src/types.ts`.
- **No runtime dependencies** in `@jetty/sdk`. Native `fetch` only.
- **Tests** use [vitest](https://vitest.dev). Unit tests inject a mock `fetch`
  via `new JettyClient({ fetch })` / `new HttpClient({ fetch })` — no network.

## Testing against a real Jetty

The flagship example's `npm run demo` runs offline (no keys). For the live A/B
(`npm run eval`), set `ANTHROPIC_API_KEY` + `JETTY_API_TOKEN` (or drop a token at
`~/.config/jetty/token`) and run it from `examples/flue-jetty`. Don't commit
tokens — `.env` is gitignored.

## Releasing

Publishing `@jetty/sdk` is tag-gated (`.github/workflows/publish.yml`):

```bash
npm version <patch|minor|major> -w @jetty/sdk
git push && git push --tags     # a v* tag triggers npm publish
```

CI must be green; the publish workflow re-runs typecheck + tests + build before
`npm publish --provenance`.
