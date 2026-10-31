import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url))

export async function runMigrations(pool: pg.Pool, { reset = false } = {}): Promise<string[]> {
  const lockClient = await pool.connect()
  const ran: string[] = []
  try {
    // 多实例同时启动时只允许一个实例执行迁移。
    await lockClient.query("SELECT pg_advisory_lock(hashtext('trend_coach_migrations'))")
    if (reset) {
      await lockClient.query('DROP SCHEMA IF EXISTS public CASCADE')
      await lockClient.query('CREATE SCHEMA public')
    }
    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const applied = new Set(
      (await lockClient.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(row => row.name),
    )
    const files = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort()
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(`${migrationsDir}${file}`, 'utf8')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        ran.push(file)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }
    return ran
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('trend_coach_migrations'))").catch(() => undefined)
    lockClient.release()
  }
}
