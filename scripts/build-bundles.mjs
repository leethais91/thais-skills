/**
 * Bundles each MCP server into one self-contained ESM file under `server/`.
 *
 * Plugin hosts install this repository straight from git and run
 * `node server/<name>.js` without `npm install`, so every runtime dependency
 * must be inlined and the output committed.
 */
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  logLevel: "info",
  // Bundled CommonJS dependencies still call `require` for Node built-ins.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
};

await build({
  ...shared,
  entryPoints: ["src/redmine/index.ts"],
  outfile: "server/redmine.js",
});

await build({
  ...shared,
  entryPoints: ["src/markdown-viewer/server.js"],
  outfile: "server/markdown-viewer.js",
  // The bundle lives in server/, but the reader assets stay in the source tree.
  define: { READER_PATH: JSON.stringify("../src/markdown-viewer/reader") },
});
