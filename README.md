# Jetty SDK

Talk to [Jetty](https://jetty.io) from your own code. Run a task, poll a
[trajectory](https://docs.jetty.io) to completion, read its step outputs, attach
labels. It's the on-ramp for the rest of the Jetty eval and ingestion tooling,
and how you put a check on the agent loop (the *run, check, fix, rerun* cycle
from [_How to build an AI agent_](https://jetty.io/guides/how-to-build-an-ai-agent)).

```ts
import { JettyClient } from "@jetty/sdk";

const jetty = new JettyClient();            // token from env or ~/.config/jetty/token
const run = await jetty.runAndWait("acme", "triage", { ticket });
const { category, priority, draft_reply } = run.steps.triage.outputs;
```

## Packages

| Package | Status | Install |
| --- | --- | --- |
| [`@jetty/sdk`](packages/sdk) (TypeScript) | shipping | `npm install @jetty/sdk` |
| [`@jetty/eve`](packages/eve) (eve extension + eval reporter) | shipping | `npm install @jetty/eve` |
| `jetty` (Python) | planned | n/a |

## Layout

```
jetty-sdk/
├── packages/
│   ├── sdk/                 # @jetty/sdk, the TypeScript client
│   └── eve/                 # @jetty/eve, the eve extension (live grading + bandit) & Jetty() reporter
├── examples/
│   ├── flue-jetty/          # flagship: A/B-eval an agent & catch a regression
│   └── eve-jetty/           # eve: the live online experiment, via the @jetty/eve extension
├── docs/
│   └── sdk.md               # docs site page (Docusaurus)
└── .github/workflows/       # CI (build/typecheck/test) + tag-gated publish
```

## Develop

This is an npm-workspaces monorepo. Node 18+ (the eve example and `@jetty/eve` need Node 24+).

```bash
npm install            # install all workspaces
npm run build          # build @jetty/sdk
npm test               # run the SDK test suite (vitest)
npm run typecheck      # typecheck every workspace
```

Try the flagship example (no keys needed for the offline demo):

```bash
npm run build -w @jetty/sdk
cd examples/flue-jetty && npm run demo   # prints the A/B verdict table
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for the full API
reference. The flagship [`examples/flue-jetty/`](examples/flue-jetty) is the one
to read: *catch a regression before you ship*. Run two versions of an agent,
grade each independently, see which one regressed. New to the project? The
step-by-step [tutorial](examples/flue-jetty/TUTORIAL.md) walks it from a fresh
checkout.

## Releasing `@jetty/sdk`

Publishing is tag-gated. With an `NPM_TOKEN` secret configured for the `@jetty`
scope:

```bash
npm version patch -w @jetty/sdk     # bump packages/sdk/package.json
git tag v0.1.1 && git push --tags   # triggers .github/workflows/publish.yml
```

> **Lockfile:** intentionally not committed. CI uses `npm install` (not `npm ci`)
> so Linux regenerates the platform-correct optional native deps each run. npm on
> macOS strips Linux-only optional deps from the lockfile, which breaks `npm ci`.

## License

MIT © Jetty.io
