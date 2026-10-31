import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runMigrations } from '../src/migrate.js'
import { seedDatabase } from '../src/seed.js'

const config = loadConfig()
const pool = createPool(config.databaseUrl)
try {
  await runMigrations(pool)
  const seed = await seedDatabase(pool)
  console.log(`seeded ${seed.courses.length} course(s), ${seed.segments.length} segment(s)`)
} finally {
  await pool.end()
}
