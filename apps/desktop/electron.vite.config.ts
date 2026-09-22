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
    // blob: + wasm-unsafe-eval leave room for AudioWorklets / RNNoise WASM in the call engine.
    `script-src 'self' blob: 'wasm-unsafe-eval'${dev ? " 'unsafe-inline' 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:",
    "media-src 'self' blob: mediastream:",
    "worker-src 'self' blob:",
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
