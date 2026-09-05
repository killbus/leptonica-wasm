import { fileURLToPath } from "node:url";

export default {
  entry: fileURLToPath(new URL("./main.mjs", import.meta.url)),
  target: "web",
  mode: "production",
  output: {
    path: fileURLToPath(new URL("./dist", import.meta.url)),
    filename: "main.mjs",
  },
  experiments: {
    outputModule: true,
  },
  resolve: {
    extensions: [".mjs", ".js"],
  },
  // The emscripten loader probes for Node at runtime with dynamic
  // imports of node: builtins (dead branches in the browser). Mark
  // them external so webpack does not try to resolve them for a web
  // target; the browser never executes those paths.
  externals: [/^node:/],
};
