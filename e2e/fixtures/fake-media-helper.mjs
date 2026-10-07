// Stands in for helper/media-helper.ps1: the same JSON lines out, the same one-per-line commands in, no Windows APIs.
// OPERANT_FAKE_MEDIA_LOG: file that gets every command received, one per line.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.env.OPERANT_FAKE_MEDIA_LOG
// A 1x1 transparent PNG, so the cover slot has something to show.
const art = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const s = {
  active: true,
  app: 'Spotify.exe',
  appName: 'Spotify',
  title: process.env.OPERANT_FAKE_MEDIA_TITLE ?? 'Midnight City (Extended Mix of the Long Fake Title)',
  artist: 'M83',
  album: 'Hurry Up, We Are Dreaming',
  playing: true,
  shuffle: false,
  canShuffle: true,
  canPrev: true,
  canNext: true,
  canPlayPause: true,
  volume: 0.4,
  appVolume: true,
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out(s)
out({ art })
out({ timeline: { pos: 62, dur: 244, at: Date.now() } })
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const cmd = line.trim()
    if (log) appendFileSync(log, cmd + '\n')
    if (cmd === 'toggle') s.playing = !s.playing
    else if (cmd === 'shuffle') s.shuffle = !s.shuffle
    else if (cmd.startsWith('vol ')) s.volume = Number(cmd.slice(4))
    out(s)
  })
  .on('close', () => process.exit(0))
