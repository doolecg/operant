# Operant media helper: reports what Windows is playing (the same session the volume flyout shows)
# and runs the bar's media buttons. Started by media.js; one JSON line per change on stdout (state,
# { timeline }, or { art } when the cover changes), one command per line on stdin:
# toggle | next | prev | shuffle | focus | vol <0..1>.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Per-app volume lives in Core Audio (not in the media session), reached through COM.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace OperantMedia {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl2 session);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName(IntPtr name, IntPtr context);
    int GetIconPath(out IntPtr path);
    int SetIconPath(IntPtr path, IntPtr context);
    int GetGroupingParam(out Guid grouping);
    int SetGroupingParam(IntPtr grouping, IntPtr context);
    int RegisterAudioSessionNotification(IntPtr client);
    int UnregisterAudioSessionNotification(IntPtr client);
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out uint pid);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid context);
    int GetMasterVolume(out float level);
    int SetMute(bool mute, ref Guid context);
    int GetMute(out bool mute);
  }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float db, ref Guid context);
    int SetMasterVolumeLevelScalar(float level, ref Guid context);
    int GetMasterVolumeLevel(out float db);
    int GetMasterVolumeLevelScalar(out float level);
  }

  public static class Volume {
    static IMMDevice Speakers() {
      IMMDevice dev;
      ((IMMDeviceEnumerator)new MMDeviceEnumerator()).GetDefaultAudioEndpoint(0, 1, out dev);
      return dev;
    }

    // The volume of every audio session whose process matches the media app (Spotify.exe, Chrome, ...).
    static List<ISimpleAudioVolume> AppVolumes(string app) {
      var found = new List<ISimpleAudioVolume>();
      if (string.IsNullOrEmpty(app)) return found;
      Guid iid = typeof(IAudioSessionManager2).GUID;
      object o;
      Speakers().Activate(ref iid, 23, IntPtr.Zero, out o);
      IAudioSessionEnumerator sessions;
      ((IAudioSessionManager2)o).GetSessionEnumerator(out sessions);
      int n; sessions.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 s; sessions.GetSession(i, out s);
        uint pid; s.GetProcessId(out pid);
        if (pid == 0) continue;
        string name;
        try { name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { continue; }
        if (name == app || app.StartsWith(name) || name.StartsWith(app)) found.Add((ISimpleAudioVolume)s);
      }
      return found;
    }

    static IAudioEndpointVolume Master() {
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Speakers().Activate(ref iid, 23, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }

    // Returns the app's volume, or the system volume (as a negative-free value, flagged by isApp) when the app has no session.
    public static float Get(string app, out bool isApp) {
      var vols = AppVolumes(app);
      isApp = vols.Count > 0;
      float v;
      if (isApp) vols[0].GetMasterVolume(out v); else Master().GetMasterVolumeLevelScalar(out v);
      return v;
    }

    public static void Set(string app, float v) {
      Guid ctx = Guid.Empty;
      var vols = AppVolumes(app);
      if (vols.Count == 0) { Master().SetMasterVolumeLevelScalar(v, ref ctx); return; }
      foreach (var s in vols) s.SetMasterVolume(v, ref ctx);
    }
  }

  // Brings the media app's window to the front (restoring it if minimized).
  public static class Window {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    static bool Raise(IntPtr h) {
      if (h == IntPtr.Zero) return false;
      if (IsIconic(h)) ShowWindow(h, 9);
      // Windows only lets the foreground app hand over the foreground; a tap of Alt counts as input and lifts that.
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(h);
      return true;
    }

    public static bool Focus(string app, string title) {
      if (!string.IsNullOrEmpty(app)) {
        foreach (var p in Process.GetProcesses()) {
          string name = p.ProcessName.ToLowerInvariant();
          if (!(name == app || app.StartsWith(name) || name.StartsWith(app))) continue;
          if (Raise(p.MainWindowHandle)) return true;
        }
      }
      // No process name matched (e.g. an unmapped AUMID): fall back to the window whose title has the track.
      if (!string.IsNullOrEmpty(title)) {
        foreach (var p in Process.GetProcesses()) {
          if (p.MainWindowHandle == IntPtr.Zero) continue;
          if (p.MainWindowTitle.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) continue;
          if (Raise(p.MainWindowHandle)) return true;
        }
      }
      return false;
    }
  }
}
'@

# WinRT async calls, awaited from PowerShell 5.1.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(5000)
  $task.Result
}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$ns = 'Windows.Media.Control.GlobalSystemMediaTransportControlsSession'
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Type]"${ns}Manager")

# The media app's name as a process name: 'Spotify.exe' -> 'spotify', 'SpotifyAB.SpotifyMusic_x!Spotify' -> 'spotify',
# a bare hex AUMID (Firefox's build) -> 'firefox'.
function AppKey($aumid) {
  if (-not $aumid) { return '' }
  if ($aumid -match '^[0-9A-Fa-f]{16}$') { return 'firefox' }
  $k = ($aumid -split '!')[-1] -replace '\.exe$', ''
  return $k.ToLowerInvariant()
}

# A friendly display name for the app key ('spotify' -> 'Spotify').
function AppName($key) {
  switch ($key) {
    'firefox' { return 'Firefox' }
    'spotify' { return 'Spotify' }
    'chrome' { return 'Chrome' }
    'msedge' { return 'Edge' }
    default { if (-not $key) { return '' } return (Get-Culture).TextInfo.ToTitleCase($key) }
  }
}

function Thumbnail($props) {
  try {
    if (-not $props.Thumbnail) { return $null }
    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # PowerShell sees the stream as a bare COM object, so the extension method is called through reflection.
    $asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
    $ms = New-Object System.IO.MemoryStream
    $asStream.Invoke($null, @($stream)).CopyTo($ms)
    $bytes = $ms.ToArray()
    if ($bytes.Length -eq 0) { return $null }
    $type = [Windows.Storage.Streams.IContentTypeProvider].GetProperty('ContentType').GetValue($stream)
    if (-not $type) { $type = 'image/png' }
    return "data:$type;base64," + [Convert]::ToBase64String($bytes)
  } catch { return $null }
}

$lastTrack = $null; $lastArt = $null; $artChanged = $false; $lastJson = ''
$lastVol = -1.0; $lastVolIsApp = $false; $lastVolCheck = [DateTime]::MinValue

# Volume has no session event, so it's only re-read (via the COM audio enumeration) every few seconds.
function CheckVolume($app, [switch]$Force) {
  if (-not $Force -and (Get-Date) -lt $script:lastVolCheck.AddSeconds(3)) { return }
  $script:lastVolCheck = Get-Date
  $isApp = $false
  $vol = -1
  try { $vol = [OperantMedia.Volume]::Get($app, [ref]$isApp) } catch {}
  $script:lastVol = [math]::Round($vol, 3)
  $script:lastVolIsApp = $isApp
}

function State {
  $session = $manager.GetCurrentSession()
  if (-not $session) { $script:lastTrack = $null; return @{ active = $false } }
  $info = $session.GetPlaybackInfo()
  $props = Await ($session.TryGetMediaPropertiesAsync()) ([Type]"${ns}MediaProperties")
  $app = AppKey $session.SourceAppUserModelId
  $track = "$app|$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
  if ($track -ne $script:lastTrack) {
    $script:lastTrack = $track; $script:lastArt = Thumbnail $props; $script:artChanged = $true
    CheckVolume $app -Force
  } else {
    CheckVolume $app
  }
  $c = $info.Controls
  return @{
    active = $true
    app = $session.SourceAppUserModelId
    appName = AppName $app
    title = $props.Title
    artist = $props.Artist
    album = $props.AlbumTitle
    playing = ($info.PlaybackStatus -eq 'Playing')
    shuffle = [bool]$info.IsShuffleActive
    canShuffle = [bool]$c.IsShuffleEnabled
    canPrev = [bool]$c.IsPreviousEnabled
    canNext = [bool]$c.IsNextEnabled
    canPlayPause = [bool]($c.IsPlayPauseToggleEnabled -or $c.IsPlayEnabled -or $c.IsPauseEnabled)
    volume = $script:lastVol
    appVolume = $script:lastVolIsApp
  }
}

# Where the track is: position and length in seconds, and when the player last reported the position (ms since
# 1970), so Operant can count on from there. Sent only when the player reports a new position.
function Timeline {
  $session = $manager.GetCurrentSession()
  if (-not $session) { return $null }
  $t = $session.GetTimelineProperties()
  $dur = ($t.EndTime - $t.StartTime).TotalSeconds
  if ($dur -le 0) { return $null }
  return @{
    pos = [math]::Round(($t.Position - $t.StartTime).TotalSeconds, 2)
    dur = [math]::Round($dur, 2)
    at = $t.LastUpdatedTime.ToUnixTimeMilliseconds()
  }
}

function Out-Line($line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

$lastTimeline = ''
function Emit {
  $json = (State) | ConvertTo-Json -Compress
  if ($json -ne $script:lastJson) { $script:lastJson = $json; Out-Line $json }
  if ($script:artChanged) { $script:artChanged = $false; Out-Line ((@{ art = $script:lastArt }) | ConvertTo-Json -Compress) }
  $tl = @{ timeline = (Timeline) } | ConvertTo-Json -Compress
  if ($tl -ne $script:lastTimeline) { $script:lastTimeline = $tl; Out-Line $tl }
}

function Run($line) {
  $session = $manager.GetCurrentSession()
  if (-not $session) { return }
  $parts = $line.Trim() -split '\s+'
  switch ($parts[0]) {
    'toggle' { [void](Await ($session.TryTogglePlayPauseAsync()) ([bool])) }
    'next' { [void](Await ($session.TrySkipNextAsync()) ([bool])) }
    'prev' { [void](Await ($session.TrySkipPreviousAsync()) ([bool])) }
    'shuffle' { [void](Await ($session.TryChangeShuffleActiveAsync(-not [bool]$session.GetPlaybackInfo().IsShuffleActive)) ([bool])) }
    'focus' {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Type]"${ns}MediaProperties")
      [void][OperantMedia.Window]::Focus((AppKey $session.SourceAppUserModelId), $props.Title)
    }
    'vol' { [OperantMedia.Volume]::Set((AppKey $session.SourceAppUserModelId), [float][math]::Min([double]1, [math]::Max([double]0, [double]$parts[1]))) }
  }
}

# Rather than polling on a timer, subscribe to the session manager and current session so Emit only
# runs on a real change. If Register-ObjectEvent can't hook these WinRT events on some system,
# $eventsOk drops the helper back to a cheap 1s poll instead.
$eventsOk = $true

function Unsubscribe-Session {
  foreach ($id in 'OperantMediaProps', 'OperantPlaybackInfo', 'OperantTimeline') {
    Get-EventSubscriber -SourceIdentifier $id -ErrorAction SilentlyContinue | Unregister-Event
  }
}

function Subscribe-Session($session) {
  Unsubscribe-Session
  if (-not $session) { return }
  try {
    Register-ObjectEvent -InputObject $session -EventName MediaPropertiesChanged -SourceIdentifier OperantMediaProps | Out-Null
    Register-ObjectEvent -InputObject $session -EventName PlaybackInfoChanged -SourceIdentifier OperantPlaybackInfo | Out-Null
    Register-ObjectEvent -InputObject $session -EventName TimelinePropertiesChanged -SourceIdentifier OperantTimeline | Out-Null
  } catch { $script:eventsOk = $false }
}

try {
  Register-ObjectEvent -InputObject $manager -EventName CurrentSessionChanged -SourceIdentifier OperantSessionChanged | Out-Null
} catch { $eventsOk = $false }
Subscribe-Session ($manager.GetCurrentSession())

# stdin is read asynchronously so events keep being handled between commands; the helper exits when Operant closes stdin.
$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$commandDue = [DateTime]::MinValue
$fallbackPoll = [DateTime]::MinValue # only used if $eventsOk goes false
$volPoll = [DateTime]::MinValue
Emit
while ($true) {
  if ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { break }
    try { Run $line } catch { [Console]::Error.WriteLine("command '$line' failed: $_") }
    $pending = $stdin.ReadLineAsync()
    $commandDue = (Get-Date).AddMilliseconds(150) # let the player catch up, then report
  }

  $due = (Get-Date) -ge $commandDue
  if ($due) { $commandDue = [DateTime]::MaxValue }
  $events = Get-Event -ErrorAction SilentlyContinue
  foreach ($e in $events) {
    if ($e.SourceIdentifier -eq 'OperantSessionChanged') { Subscribe-Session ($manager.GetCurrentSession()) }
    Remove-Event -EventIdentifier $e.EventIdentifier
    $due = $true
  }
  if (-not $eventsOk -and (Get-Date) -ge $fallbackPoll) { $due = $true; $fallbackPoll = (Get-Date).AddSeconds(1) }
  if ((Get-Date) -ge $volPoll) { $due = $true; $volPoll = (Get-Date).AddSeconds(3) }

  if ($due) {
    try { Emit } catch { Out-Line (@{ active = $false; error = "$_" } | ConvertTo-Json -Compress) }
  }
  Start-Sleep -Milliseconds 50
}
Unsubscribe-Session
Unregister-Event -SourceIdentifier OperantSessionChanged -ErrorAction SilentlyContinue
