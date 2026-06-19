import { buildApp } from './app.js'

const app = await buildApp()

const port = Number(process.env.SERVER_PORT ?? 4000)
app.listen({ port, host: '0.0.0.0' }).catch((e) => {
  app.log.error(e)
  process.exit(1)
})
