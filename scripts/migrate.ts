import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'

const config = loadConfig()
const pool = createPool(config.databaseUrl)
try {
  const reset = process.argv.includes('--reset')
  const ran = await runMigrations(pool, { reset })
  if (ran.length === 0) {
    console.log('migrations up to date')
  } else {
    console.log(`applied: ${ran.join(', ')}`)
  }
} finally {
  await pool.end()
}
