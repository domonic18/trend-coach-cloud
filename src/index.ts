import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createPool } from './db.js'
import { runMigrations } from './migrate.js'

const config = loadConfig()
const pool = createPool(config.databaseUrl)

try {
  const migrated = await runMigrations(pool)
  const app = await buildApp({ config, pool, startPipeline: true })
  await app.listen({ host: config.host, port: config.port })
  app.log.info({ environment: config.env, port: config.port, migrated }, 'trend-coach-cloud started')

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    await app.close()
    await pool.end()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
} catch (error) {
  console.error(error)
  await pool.end().catch(() => undefined)
  process.exit(1)
}
