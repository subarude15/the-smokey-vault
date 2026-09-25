import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

/** Chromium prints this page. A controlling service worker would swap it for the app shell. */
function brewSheetPrintWithoutServiceWorker(): Plugin {
  return {
    name: "brew-sheet-print-without-service-worker",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.filename?.endsWith("brew-sheet-print.html")) return html;
        return html
          .replace(/<link rel="manifest"[^>]*>/g, "")
          .replace(/<script id="vite-plugin-pwa:register-sw"[^>]*><\/script>/g, "");
      }
    }
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/brew-sheet-print\.html/]
      },
      manifest: {
        name: "The Smokey Barrel Bar & Brewing",
        // Home-screen labels get truncated past ~12 characters, so this stays short.
        short_name: "Smokey Barrel",
        description: "Your private bar, cellar, and brewery.",
        theme_color: "#15130f",
        background_color: "#0b0a08",
        display: "standalone",
        start_url: "/",
        share_target: {
          action: "/",
          method: "GET",
          enctype: "application/x-www-form-urlencoded",
          params: {
            title: "title",
            text: "text",
            url: "url"
          }
        },
        icons: [
          { src: "/brand/sb-icon.png", sizes: "256x256", type: "image/png", purpose: "any" },
          { src: "/brand/sb-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/brand/sb-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      }
    }),
    brewSheetPrintWithoutServiceWorker()
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        print: resolve(import.meta.dirname, "brew-sheet-print.html")
      }
    }
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080" },
    // Tunnels and sandboxed preview hosts (phone + tablet testing) reach the dev server
    // through a proxied hostname, so allow any preview host instead of only localhost.
    allowedHosts: [".e2b.app"]
  }
});
