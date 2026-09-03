import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
})

export default defineConfig({
  plugins: [api()],
  // Where the built page is mounted. `/` for the desk; `/town/` when it is served behind a
  // reverse proxy on a path, as the phone's framed view is. Every asset and API URL follows.
  base: process.env.BOT_CROSSING_BASE || '/',
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: { port: Number(process.env.PORT) || 5274, strictPort: false },
  build: { target: 'esnext' },
})
