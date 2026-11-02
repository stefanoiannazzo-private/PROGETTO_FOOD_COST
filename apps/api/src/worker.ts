import { loadEnv, config } from './env'
import { connect } from './db/connection'
import { startWorker } from './services/jobs'

/** Worker separato per le importazioni (in produzione, con PostgreSQL server). */
loadEnv()
const database = await connect()
const stop = startWorker(database.db, config(), (m) => console.error(m))
console.log('Worker importazioni avviato.')
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stop()
    await database.close()
    process.exit(0)
  })
}
