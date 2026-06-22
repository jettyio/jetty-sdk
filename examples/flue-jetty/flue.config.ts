import { defineConfig } from "@flue/cli/config";

// Flue runs workflows from src/workflows/. Run one locally with:
//   npx flue run triage --target node --payload '{"ticket":{...}}'
export default defineConfig({
  target: "node",
});
