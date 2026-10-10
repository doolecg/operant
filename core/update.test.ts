import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appImageInstallScript,
  checkIntervalMs,
  debInstallScript,
  downloaded,
  installKind,
  macInstallScript,
  msiWorkerScript,
  newer,
  pickAsset,
  pickRelease,
  shQuote,
  verifyDigest,
  type ReleaseAsset,
} from './update'

const asset = (name: string): ReleaseAsset => ({ name, size: 1, browser_download_url: `https://x/${name}` })

describe('update', () => {
  it('compares versions', () => {
    expect(newer('2.0.1', '2.0.0')).toBe(true)
    expect(newer('v2.1.0', '2.0.9')).toBe(true)
    expect(newer('2.0.0', '2.0.0')).toBe(false)
    expect(newer('1.9.9', '2.0.0')).toBe(false)
    expect(newer('3.0.4-dev.7', '3.0.4-dev.6')).toBe(true)
    expect(newer('3.0.4-dev.6', '3.0.4-dev.7')).toBe(false)
    expect(newer('3.0.4', '3.0.4-dev.9')).toBe(true)
    expect(newer('3.0.4-dev.9', '3.0.4')).toBe(false)
    expect(newer('3.0.4-dev.1', '3.0.3')).toBe(true)
    expect(newer('10.0.0', '9.9.9')).toBe(true)
  })

  it('turns the check setting into an interval', () => {
    expect(checkIntervalMs(undefined)).toBe(3 * 3_600_000)
    expect(checkIntervalMs('')).toBe(3 * 3_600_000)
    expect(checkIntervalMs(0)).toBe(0)
    expect(checkIntervalMs(6)).toBe(6 * 3_600_000)
    expect(checkIntervalMs(99)).toBe(24 * 3_600_000)
  })

  it('picks the release for a channel, skipping drafts', () => {
    const list = [
      { tag_name: '2.2.0', draft: true, assets: [] },
      { tag_name: '2.1.0-beta.1', prerelease: true, assets: [] },
      { tag_name: '2.0.1', assets: [] },
      { tag_name: '2.0.0', assets: [] },
    ]
    expect(pickRelease(list, 'stable')?.tag_name).toBe('2.0.1')
    expect(pickRelease(list, 'beta')?.tag_name).toBe('2.1.0-beta.1')
    expect(pickRelease('nope', 'stable')).toBeNull()
  })

  it('knows which installer this copy can apply', () => {
    expect(installKind({ platform: 'win32' })).toBe('msi')
    expect(installKind({ platform: 'darwin' })).toBe('dmg')
    expect(installKind({ platform: 'linux', env: { APPIMAGE: '/a/O.AppImage' }, execPath: '/x' })).toBe('appimage')
    expect(installKind({ platform: 'linux', env: {}, execPath: '/opt/Operant 2/operant' })).toBe('deb')
    expect(installKind({ platform: 'linux', env: {}, execPath: '/opt/Operant 3/operant' })).toBe('deb')
    expect(installKind({ platform: 'linux', env: {}, execPath: '/home/u/dev/electron' })).toBeNull()
  })

  it('picks the asset for the platform and architecture', () => {
    const assets = [
      'Operant2-2.0.1-windows-x64.msi',
      'Operant2-2.0.1-mac-arm64.dmg',
      'Operant2-2.0.1-mac-x64.dmg',
      'Operant2-2.0.1-linux-x86_64.AppImage',
      'Operant2-2.0.1-linux-amd64.deb',
    ].map(asset)
    const name = (o: Parameters<typeof pickAsset>[1]) => pickAsset(assets, o)?.name
    expect(name({ platform: 'win32', arch: 'x64', kind: 'msi' })).toBe('Operant2-2.0.1-windows-x64.msi')
    expect(name({ platform: 'darwin', arch: 'arm64', kind: 'dmg' })).toBe('Operant2-2.0.1-mac-arm64.dmg')
    expect(name({ platform: 'darwin', arch: 'x64', kind: 'dmg' })).toBe('Operant2-2.0.1-mac-x64.dmg')
    expect(name({ platform: 'linux', arch: 'x64', kind: 'appimage' })).toBe('Operant2-2.0.1-linux-x86_64.AppImage')
    expect(name({ platform: 'linux', arch: 'x64', kind: 'deb' })).toBe('Operant2-2.0.1-linux-amd64.deb')
    expect(name({ platform: 'linux', arch: 'arm64', kind: 'deb' })).toBeUndefined()
    expect(name({ platform: 'linux', arch: 'x64', kind: null })).toBeUndefined()
  })

  it('matches assets by platform, architecture and extension, not by the file name prefix', () => {
    const rel = {
      tag_name: '3.0.0',
      assets: [
        'Operant3-3.0.0-windows-x64.msi',
        'Operant3-3.0.0-mac-arm64.dmg',
        'Operant3-3.0.0-linux-x86_64.AppImage',
        'Operant3-3.0.0-linux-amd64.deb',
      ].map(asset),
    }
    const name = (o: Parameters<typeof pickAsset>[1], assets = rel.assets) => pickAsset(assets, o)?.name
    expect(name({ platform: 'win32', arch: 'x64', kind: 'msi' })).toBe('Operant3-3.0.0-windows-x64.msi')
    expect(name({ platform: 'darwin', arch: 'arm64', kind: 'dmg' })).toBe('Operant3-3.0.0-mac-arm64.dmg')
    expect(name({ platform: 'linux', arch: 'x64', kind: 'deb' })).toBe('Operant3-3.0.0-linux-amd64.deb')
    // A release carrying both prefixes (compatibility copies) still resolves to one installer.
    const both = [...['Operant2-3.0.0-windows-x64.msi'].map(asset), ...rel.assets]
    expect(name({ platform: 'win32', arch: 'x64', kind: 'msi' }, both)).toBe('Operant2-3.0.0-windows-x64.msi')
    expect(newer(rel.tag_name, '2.0.0')).toBe(true)
  })

  it('checks sizes and sha256 digests of downloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operant-upd-'))
    try {
      const file = join(dir, 'a.msi')
      writeFileSync(file, 'installer bytes')
      expect(downloaded(file, 15)).toBe(true)
      expect(downloaded(file, 16)).toBe(false)
      expect(downloaded(join(dir, 'missing'), 1)).toBe(false)
      const good = 'sha256:' + createHash('sha256').update('installer bytes').digest('hex')
      await expect(verifyDigest(file, good)).resolves.toBe(true)
      await expect(verifyDigest(file, null)).resolves.toBe(false)
      await expect(verifyDigest(file, 'sha256:' + '0'.repeat(64))).rejects.toThrow('digest mismatch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes install workers that wait for the app and quote paths', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    const mac = macInstallScript({ pid: 42, dmg: '/tmp/O.dmg', bundle: '/Applications/Operant 2.app', log: '/tmp/l', relaunch: true })
    expect(mac).toContain('while kill -0 42')
    expect(mac).toContain(`ditto "$mnt/Operant 3.app" "$bundle.new"`)
    expect(mac).toContain(`bundle='/Applications/Operant 2.app'`)
    expect(mac).toMatch(/open "\$bundle"\nsay done$/)
    expect(macInstallScript({ pid: 1, dmg: 'd', bundle: 'b', log: 'l', relaunch: false })).not.toContain('open "$bundle"')

    const ai = appImageInstallScript({ pid: 7, appImage: '/tmp/n', target: '/home/u/O.AppImage', log: '/tmp/l', relaunch: false })
    expect(ai).toContain('mv -f "$target.new" "$target"')
    expect(ai).not.toContain('nohup')
    expect(debInstallScript({ pid: 7, deb: '/tmp/o.deb', exe: '/opt/Operant 2/operant', log: 'l', relaunch: true })).toContain(
      'pkexec dpkg -i "$deb"',
    )

    const msi = msiWorkerScript({
      pid: 9,
      exe: "C:\\Program Files\\Operant 2\\Operant 2.exe",
      installDir: 'C:\\Program Files\\Operant 2',
      msi: "C:\\Temp\\O'2.msi",
      log: 'C:\\Temp\\l.log',
      relaunch: true,
    })
    expect(msi).toContain('Wait-Process -Id 9')
    expect(msi).toContain(`/i "C:\\Temp\\O''2.msi" /passive`)
    expect(msi).toContain(`Start-Process -FilePath 'C:\\Program Files\\Operant 2\\Operant 2.exe'`)
  })
})
