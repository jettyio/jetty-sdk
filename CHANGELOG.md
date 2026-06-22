# Changelog

All notable changes to `@jetty/sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-20

Initial release — the `JettyClient` extracted from `jettyio-skills` into a
standalone, typed, published package.

### Added

- `JettyClient` covering collections, tasks, runs, trajectories, labels, files,
  step templates, and routines.
- Config & auth resolution: argument → `JETTY_API_TOKEN` → `~/.config/jetty/token`;
  base URL argument → `JETTY_API_URL` → `https://flows-api.jetty.io`. Clear,
  source-naming error when no token is found.
- HTTP hardening: per-request timeout (`AbortController`), exponential-backoff
  retries on network errors + 5xx, and a typed error hierarchy. Cloudflare `524`
  maps to `JettyInProgressError` and is never retried.
- Typed models mirroring the backend (`Trajectory`, `Step`, `Label`,
  `TrajectoryAttribute`, `WorkflowResponse`, …).
- `parseWorkflowId` + `runAndWait` — start an async run and poll the trajectory
  to a terminal status.
- File helpers: `runWithFiles` (multipart upload → `init_params.file_paths[]`)
  and `downloadFile` (bytes + filename from Content-Disposition).
- Flagship example (`examples/flue-jetty`) — A/B-eval an agent and catch a regression — plus full README + docs page.
- CI (build/typecheck/test on Node 18/20/22) and tag-gated npm publish.
