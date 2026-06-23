# Changelog

All notable changes to `@jetty/sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-23

### Added

- `gradeWithJetty(client, collection, task, options)` — the eval primitive.
  Upload an agent output, run a Jetty grading task to completion, read its grade
  file, and label the resulting trajectory, in one call. Collapses the
  run → read-file → label dance into a single helper. Generic over the grade
  type, with `gradeFile` / `parseGrade` overrides and `labels` that can read the
  parsed grade (so `eval.grade` is the score itself). Used by the
  `examples/flue-jetty` A/B-eval workflow.

## [0.1.1] - 2026-06-22

### Added

- `runAndWait` now accepts a `files` option, so a run can upload files (multipart
  → `init_params.file_paths[]`) and still poll to a terminal status through the
  same helper.

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
