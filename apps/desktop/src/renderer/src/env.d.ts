/// <reference types="vite/client" />
import type { ShpihcordApi } from "../../shared/ipc";

declare global {
  interface Window {
    /** Exposed by the preload script. Undefined when running in a plain browser. */
    shpihcord?: ShpihcordApi;
  }
}

export {};
