// Media controls: runs media-helper.ps1, which reads Windows' current media session (Spotify,
// a browser tab, ...) and passes on the bar's buttons. The helper sends a JSON line whenever
// the state changes, and a { timeline } line when the track position does; commands go back one per line.

const { app } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

function createMedia({ send }) {
  // Packaged, the script sits outside the asar so PowerShell can read it.
  const script = path.join(__dirname, 'media-helper.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  let proc = null, wanted = false, restartT = null;
  let last = { active: false };

  function start() {
    wanted = true;
    if (proc || process.platform !== 'win32') return;
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        // The track position comes as its own small line, so the state (with its cover art) isn't resent every second.
        if (o.timeline !== undefined) { last = { ...last, timeline: o.timeline }; send('media:timeline', o.timeline); }
        else { last = { ...o, timeline: o.active ? last.timeline : null }; send('media:state', last); }
      }
    });
    proc.stderr.on('data', d => console.error('media helper:', String(d)));
    proc.on('exit', () => {
      proc = null;
      last = { active: false };
      send('media:state', last);
      // A crash shouldn't take the controls away for good.
      if (wanted) restartT = setTimeout(start, 5000);
    });
    proc.on('error', e => console.error('media helper failed to start', e));
  }

  function stop() {
    wanted = false;
    clearTimeout(restartT);
    if (proc) { try { proc.stdin.end(); } catch {} setTimeout(() => { try { proc?.kill(); } catch {} }, 1500); }
  }

  function command(cmd) {
    if (!proc || !/^(toggle|next|prev|shuffle|focus|vol (0|1|0?\.\d+))$/.test(cmd)) return;
    proc.stdin.write(cmd + '\n');
  }

  app.on('will-quit', stop);
  return { start, stop, command, state: () => last };
}

module.exports = { createMedia };
