import { loadEnv } from './env'
import { connect } from './db/connection'
import { migrate } from './db/migrate'
import { buildApp } from './app'

loadEnv()
const database = await connect()
if (process.env.AUTO_MIGRATE !== 'false') await migrate(database, (m) => console.log(m))
const app = await buildApp(database)
await app.listen({ port: app.cfg.port, host: app.cfg.host })

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close()
    await database.close()
    process.exit(0)
  })
}
