import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IdentificationRecord, SellerSessionRecord, SellerSessionStore } from '../app/sellerSessions'

// Local single-host storage (same model as the agent store). Records contain only hashes
// and AES-GCM sealed tokens; files are created with mode 0600 in a 0700 directory.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[A-Z0-9]{7}$/

export const makeFileSellerSessionStore = (directory: string): SellerSessionStore => {
  const root = resolve(directory)
  const init = () => mkdir(root, { recursive: true, mode: 0o700 })
  const file = (kind: string, id: string, pattern = UUID) => {
    if (!pattern.test(id)) throw new Error('Identificador inválido')
    return join(root, `${kind}-${id}.json`)
  }
  const read = async <T>(path: string): Promise<T | null> => {
    try { return JSON.parse(await readFile(path, 'utf8')) as T }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
  }
  const write = async (path: string, value: unknown) => {
    await init()
    const temporary = `${path}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  }
  const codeKey = (code: string) => code.replace('-', '')
  return {
    getIdentification: id => read<IdentificationRecord>(file('identification', id)),
    async findIdentificationByCode(code) {
      if (!CODE.test(code)) return null
      const index = await read<{ id: string }>(file('code', code, CODE))
      return index ? read<IdentificationRecord>(file('identification', index.id)) : null
    },
    async saveIdentification(value) {
      await write(file('identification', value.id), value)
      await write(file('code', codeKey(value.user_code), CODE), { id: value.id })
    },
    getSession: id => read<SellerSessionRecord>(file('session', id)),
    saveSession: value => write(file('session', value.id), value),
    async listSessions() {
      await init()
      const names = (await readdir(root)).filter(name => /^session-[0-9a-f-]{36}\.json$/i.test(name))
      const sessions = await Promise.all(names.map(name => read<SellerSessionRecord>(join(root, name))))
      return sessions.filter((s): s is SellerSessionRecord => Boolean(s))
    }
  }
}
