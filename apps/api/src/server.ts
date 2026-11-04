import { assertProductionConfig, config, loadEnv } from './env'
import { connect } from './db/connection'
import { migrate } from './db/migrate'
import { buildApp } from './app'
import { startWorker } from './services/jobs'

loadEnv()
const problems = assertProductionConfig(config(), process.env.DATABASE_URL)
if (problems.length) {
  console.error('Configurazione di produzione non valida:\n- ' + problems.join('\n- '))
  process.exit(1)
}
const database = await connect()
if (process.env.AUTO_MIGRATE !== 'false') await migrate(database, (m) => console.log(m))
const app = await buildApp(database)
await app.listen({ port: app.cfg.port, host: app.cfg.host })
// Con PostgreSQL in-process (pglite) il worker gira nello stesso processo; con un server PostgreSQL
// si può impostare WORKER_INLINE=false e avviare `npm run worker` separatamente.
const inline = process.env.WORKER_INLINE ? process.env.WORKER_INLINE !== 'false' : database.kind === 'pglite'
const stopWorker = inline ? startWorker(database.db, app.cfg, (m) => app.log.error(m)) : () => {}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopWorker()
    await app.close()
    await database.close()
    process.exit(0)
  })
}
