import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Where bot tokens live. The database keeps only the key (`token_ref`).
export interface SecretStore {
  get(key: string): string | null
  set(key: string, secret: string): void
  delete(key: string): void
  // Why the last get() of this key found nothing even though a value was stored (unreadable, OS encryption unavailable).
  problem?(key: string): string | null
}

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>()
  get(key: string): string | null {
    return this.map.get(key) ?? null
  }
  set(key: string, secret: string): void {
    this.map.set(key, secret)
  }
  delete(key: string): void {
    this.map.delete(key)
  }
}

// The shape of Electron's safeStorage (OS keychain / DPAPI), so main passes it in and tests pass a fake.
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/

// One encrypted file per key, outside the database. With no OS encryption available it refuses to store
// anything rather than writing the token in the clear.
export class FileSecretStore implements SecretStore {
  private readonly problems = new Map<string, string>()

  constructor(
    private readonly dir: string,
    private readonly cipher: SecretCipher,
    private readonly log?: (line: string) => void,
  ) {}

  problem(key: string): string | null {
    return this.problems.get(key) ?? null
  }

  private fail(key: string, why: string): null {
    if (this.problems.get(key) !== why) this.log?.(`Secret ${key}: ${why}`)
    this.problems.set(key, why)
    return null
  }

  private file(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('Invalid secret key')
    return join(this.dir, `${key}.bin`)
  }

  get(key: string): string | null {
    const file = this.file(key)
    if (!existsSync(file)) return null
    if (!this.cipher.isAvailable()) return this.fail(key, 'The OS keychain is not available, so the saved token cannot be read')
    try {
      const plain = this.cipher.decrypt(readFileSync(file))
      this.problems.delete(key)
      return plain
    } catch {
      return this.fail(key, 'The saved token could not be decrypted (it was saved by another Windows user or on another machine). Paste the token again')
    }
  }

  set(key: string, secret: string): void {
    const file = this.file(key)
    if (!this.cipher.isAvailable()) throw new Error('The OS keychain is not available, so the token cannot be stored safely')
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(file, this.cipher.encrypt(secret), { mode: 0o600 })
  }

  delete(key: string): void {
    rmSync(this.file(key), { force: true })
  }
}
