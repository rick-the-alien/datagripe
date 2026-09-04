import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			// "prompt": a new service worker waits until the user applies the
			// update via the StatusBar refresh button (stores/pwa.ts).
			registerType: "prompt",
			includeAssets: ["icon.svg"],
			manifest: {
				name: "DataGripe",
				short_name: "DataGripe",
				description: "Web-based database IDE inspired by DataGrip",
				theme_color: "#0B0E14",
				background_color: "#0B0E14",
				// window-controls-overlay first: installed frameless windows get no
				// OS title bar; .dg-header becomes the drag region (see index.css).
				display: "standalone",
				display_override: ["window-controls-overlay", "standalone"],
				icons: [
					{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
					{ src: "icon-512.png", sizes: "512x512", type: "image/png" },
					{
						src: "icon-maskable-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
			workbox: {
				// API/websocket traffic must never be answered from the cache.
				navigateFallbackDenylist: [/^\/api\//, /^\/health$/, /^\/ws$/],
				// Monaco workers are multi-MB chunks.
				maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
			},
			devOptions: {
				// Without this the dev server never injects the manifest link or
				// registers a service worker, so Chrome refuses to offer install.
				enabled: true,
				type: "module",
			},
		}),
	],
	server: {
		port: 5173,
		proxy: {
			"/api": "http://localhost:3001",
			"/health": "http://localhost:3001",
			"/ws": {
				target: "ws://localhost:3001",
				ws: true,
			},
		},
	},
});
