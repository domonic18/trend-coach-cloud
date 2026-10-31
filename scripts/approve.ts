import { AuthService } from '../src/auth/service.js'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'

const userCode = process.argv[2]
if (userCode === undefined) {
  console.error('usage: npm run approve -- <USER-CODE>')
  process.exit(1)
}

const config = loadConfig()
const pool = createPool(config.databaseUrl)
try {
  // 本地/运维绕过 HTTP 控制台；生产审批入口应在 M3 账号后台。
  await new AuthService(pool, config).approveDeviceCode({ userCode })
  console.log(`approved ${userCode}`)
} finally {
  await pool.end()
}
