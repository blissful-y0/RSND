import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

describe('/api/read database fallback', () => {
  test('returns raw database bytes when server-side strip decode fails', async () => {
    const rawDatabase = Buffer.from('not-a-valid-risusave')
    const databaseKey = 'database/database.bin'
    const hexName = Buffer.from(databaseKey, 'utf-8').toString('hex')

    const srv = await spawnServer({
      seedSave: async (saveDir) => {
        await writeFile(path.join(saveDir, hexName), rawDatabase)
      },
    })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const res = await client.fetch('/api/read', {
      headers: {
        'file-path': hexName,
      },
    })

    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(rawDatabase)
  })
})
