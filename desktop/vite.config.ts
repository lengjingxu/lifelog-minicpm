import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { createReadStream, existsSync, statSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { extname, resolve, sep } from "node:path";
const host = process.env.TAURI_DEV_HOST;
const sampleRoot = resolve(process.cwd(), "sample-data");

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": "application/json; charset=utf-8",
};

function serveFixture(sampleDataRoot: string) {
  return (req: { url?: string }, res: any, next: () => void) => {
    if (!req.url) return next();
    let pathname: string;
    try {
      pathname = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      res.statusCode = 400;
      res.end("bad path");
      return;
    }
    const relative = pathname.replace(/^\/__fixture\/?/, "").replace(/^\/+/, "");
    const candidate = resolve(sampleDataRoot, relative);
    if (!candidate.startsWith(sampleDataRoot + sep) || !existsSync(candidate) || !statSync(candidate).isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", MIME[extname(candidate).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600");
    createReadStream(candidate).pipe(res);
  };
}

function fixturePlugin() {
  return {
    name: "shiguang-fixture-static",
    configureServer(server: any) {
      server.middlewares.use("/__fixture", serveFixture(sampleRoot));
    },
    configurePreviewServer(server: any) {
      server.middlewares.use("/__fixture", serveFixture(sampleRoot));
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), fixturePlugin()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
