import { defineConfig } from "vite";
export default defineConfig({ server: { port: Number(process.env.WEB_PORT ?? 5173) } });
