import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

/**
 * Content-Security-Policy for the renderer, injected as a <meta> tag so it also
 * applies to file:// loads in production. The hub is user-configured, so
 * connect-src allows any http(s)/ws(s) origin.
 */
function cspPlugin(dev: boolean): Plugin {
  const directives = [
    "default-src 'self'",
    // No blob: scripts (nothing builds code at runtime); wasm-unsafe-eval stays for WASM DSP.
    `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline' 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // Images are bundled assets or data: URLs made by main (screen thumbnails, app icons).
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join("; ");
  return {
    name: "shpihcord-csp",
    transformIndexHtml(html) {
      return html.replace(
        "<!--CSP-->",
        `<meta http-equiv="Content-Security-Policy" content="${directives}" />`,
      );
    },
  };
}

export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      rollupOptions: {
        // Sandboxed preload scripts must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    // Defaults: root src/renderer, entry src/renderer/index.html.
    plugins: [react(), cspPlugin(command === "serve")],
  },
}));
