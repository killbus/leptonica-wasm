// webpack5 fixture: bundle the shared entry, then run it under Node.
import { spawnSync } from "node:child_process";
import webpack from "webpack";

const config = (await import("./webpack.config.js")).default;

await new Promise((resolve, reject) => {
  webpack(config, (err, stats) => {
    if (err) return reject(err);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ errorDetails: true })));
    console.log(stats.toString({ assets: true, modules: false, colors: false }));
    resolve();
  });
});
console.log("webpack5: bundled");
