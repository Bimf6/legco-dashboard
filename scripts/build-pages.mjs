import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import postcss from "postcss";

async function main() {
  const outDir = path.resolve("dist-pages");
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: ["src/pages-entry.tsx"],
    bundle: true,
    minify: true,
    sourcemap: false,
    format: "esm",
    target: ["es2020"],
    outfile: path.join(outDir, "app.js"),
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });

  const cssIn = await readFile("src/app/globals.css", "utf8");
  const cssResult = await postcss([tailwindcss()]).process(cssIn, {
    from: "src/app/globals.css",
    to: path.join(outDir, "app.css"),
  });
  await writeFile(path.join(outDir, "app.css"), cssResult.css);

  const html = `<!doctype html>
<html lang="zh-HK">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LegCo Monitor · 香港立法會會議、文件及質詢監察</title>
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body class="min-h-screen antialiased">
    <div id="root"></div>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`;

  await writeFile(path.join(outDir, "index.html"), html);
  await writeFile(path.join(outDir, ".nojekyll"), "");
  console.log("build-pages: generated dist-pages/index.html, app.js, app.css");
}

main().catch((err) => {
  console.error("build-pages failed:", err);
  process.exit(1);
});
