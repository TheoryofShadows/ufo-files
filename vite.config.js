import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA. Build output in dist/ — deploy to Vercel, Netlify, or GitHub Pages.
// For project-page hosting (https://USER.github.io/uap-files/) set base accordingly,
// e.g. run with: BASE=/uap-files/ npm run build
export default defineConfig({
  base: process.env.BASE || "/",
  plugins: [react()],
  server: { host: true, port: 5173 },
});
