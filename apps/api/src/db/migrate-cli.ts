import { connect } from './connection'
import { migrate } from './migrate'
import { loadEnv } from '../env'

loadEnv()
const database = await connect()
try {
  const ran = await migrate(database, console.log)
  console.log(ran.length ? `Migrazioni applicate: ${ran.length}` : 'Database già aggiornato.')
} finally {
  await database.close()
}
