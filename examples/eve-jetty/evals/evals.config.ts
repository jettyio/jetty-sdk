/**
 * Run-wide eve eval config. The `Jetty()` reporter sends every eval result to
 * Jetty as a durable, labelled trajectory — it drops in exactly where eve's
 * built-in `Braintrust(...)` reporter would go.
 *
 *   JETTY_COLLECTION=acme JETTY_PROJECT=triage-agent npx eve eval
 *
 * Point at a local mise with JETTY_API_URL=http://localhost:8000. With no
 * JETTY_COLLECTION set the reporter no-ops (the evals still run), so the file is
 * safe to commit.
 */
import { defineEvalConfig } from "eve/evals";

import { Jetty } from "@jetty/eve/reporter";

export default defineEvalConfig({
  reporters: [Jetty()],
});
