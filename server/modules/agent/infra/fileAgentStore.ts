import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentBusyError, type AgentStore, type Operation, type RequestRecord } from '../contracts'

// Local, durable single-host storage. A lock whose process died is recovered only when no
// create_sale dispatch is unsettled (an interrupted commit may already have created a sale).
export const makeFileAgentStore = (directory: string): AgentStore => {
  const root = resolve(directory)
  const init = () => mkdir(root, { recursive: true, mode: 0o700 })
  const path = (kind: string, id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Identificador inválido')
    return join(root, `${kind}-${id}.json`)
  }
  const read = async <T>(kind: string, id: string): Promise<T | null> => {
    try { return JSON.parse(await readFile(path(kind, id), 'utf8')) as T }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
  }
  const save = async (kind: string, id: string, value: unknown) => {
    await init()
    const target = path(kind, id)
    const temporary = `${target}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, target)
  }
  const processAlive = (pid: number) => {
    try { process.kill(pid, 0); return true }
    catch (error: any) { return error.code === 'EPERM' } // EPERM: it exists (another user)
  }
  const orphanLockRecoverable = async (lockPath: string) => {
    let owner: { pid?: number }
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch { return false } // being written: busy
    if (!Number.isInteger(owner.pid) || owner.pid === process.pid || processAlive(owner.pid!)) return false
    const ops = await Promise.all((await readdir(root)).flatMap(name => /^operation-([0-9a-f-]{36})\.json$/i.exec(name)?.[1] || []).map(id => read<Operation>('operation', id)))
    return !ops.some(op => op && (op.execution ? !op.execution.settled : op.state === 'executing'))
  }
  return {
    getRequest: (id) => read<RequestRecord>('request', id),
    saveRequest: (id, value) => save('request', id, value),
    getOperation: (id) => read<Operation>('operation', id),
    saveOperation: (value) => save('operation', value.id, value),
    async listOperations() {
      await init()
      const ids = (await readdir(root)).flatMap(name => /^operation-([0-9a-f-]{36})\.json$/i.exec(name)?.[1] || [])
      const ops = await Promise.all(ids.map(id => read<Operation>('operation', id)))
      return ops.filter((op): op is Operation => Boolean(op))
    },
    async exclusive(work) {
      await init()
      const lockPath = join(root, 'processing.lock')
      let lock
      for (let attempt = 0; ; attempt++) {
        try { lock = await open(lockPath, 'wx', 0o600); break }
        catch (error: any) {
          if (error.code !== 'EEXIST') throw error
          // An orphan lock (its process died) is recovered only if no create_sale is unsettled:
          // an interrupted dispatch must be reconciled by a person, never cleared automatically.
          if (attempt === 0 && await orphanLockRecoverable(lockPath)) { await unlink(lockPath).catch(() => {}); continue }
          throw new AgentBusyError()
        }
      }
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }))
        return await work()
      } finally {
        await lock.close()
        await unlink(lockPath)
      }
    }
  }
}
