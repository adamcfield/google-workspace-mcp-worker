import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      // The source uses NodeNext-style ".js" import specifiers that point at ".ts"
      // files. Strip the extension during resolution so Vitest (Vite/esbuild) can
      // resolve them to the TypeScript sources.
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" },
      // Worker entry files import the `cloudflare:workers` runtime module (via
      // workers-oauth-provider and agents); Node has no such scheme — stub it.
      { find: /^cloudflare:workers$/, replacement: fileURLToPath(new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        // Externalized deps are loaded by Node directly, where the alias above
        // cannot rewrite `cloudflare:workers`; inline the provider so Vite does.
        inline: [/@cloudflare\/workers-oauth-provider/],
      },
    },
  },
});
