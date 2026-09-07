import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
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
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }
        ]
      }
    })
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080" },
    // Tunnels and sandboxed preview hosts (phone + tablet testing) reach the dev server
    // through a proxied hostname, so allow any preview host instead of only localhost.
    allowedHosts: [".e2b.app"]
  }
});
