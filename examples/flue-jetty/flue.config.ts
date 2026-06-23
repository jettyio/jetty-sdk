import { defineConfig } from "@flue/cli/config";

// Flue runs workflows from src/workflows/. Run one locally with:
//   npx flue run eval --target node --input '{"tickets":2}'
export default defineConfig({
  target: "node",
});
