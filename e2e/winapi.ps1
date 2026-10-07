# Real OS window control for the scale e2e: finds the top-level window of a process by EnumWindows and drives it
# with user32 (ShowWindow), then measures what is painted with PrintWindow. Prints one JSON line.
# Usage: powershell -File winapi.ps1 -Action maximize|restore|rect|measure|screen -ProcessId <pid> [-Png <file>]
param([string]$Action, [int]$ProcessId, [string]$Png = '')
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Text;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      var t = new StringBuilder(128); GetWindowText(h, t, 128);
      if (c.ToString() == "Chrome_WidgetWin_1" && t.ToString().Length > 0 && t.ToString() != "Default IME") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Do(uint pid, string action, string png) {
    IntPtr h = Find(pid);
    if (h == IntPtr.Zero) return "{\"error\":\"no window\"}";
    if (action == "maximize") ShowWindow(h, 3);          // SW_MAXIMIZE
    if (action == "restore") ShowWindow(h, 9);           // SW_RESTORE
    if (action == "fullscreen") { RECT d; GetWindowRect(h, out d); }
    RECT r; GetWindowRect(h, out r); RECT c; GetClientRect(h, out c);
    string res = "{\"zoomed\":" + (IsZoomed(h) ? "true" : "false") + ",\"dpi\":" + GetDpiForWindow(h) + ",\"window\":[" + (r.R - r.L) + "," + (r.B - r.T) + "],\"client\":[" + c.R + "," + c.B + "]";
    if (action == "measure" || action == "screen") {
      int w = c.R, hh = c.B;
      // Capture the whole window and cut the client area (the non-client frame is painted by Windows, not the page).
      int ww = r.R - r.L, wh = r.B - r.T;
      using (var bmp = new Bitmap(ww, wh, PixelFormat.Format32bppArgb)) {
        if (action == "screen") {
          // What is really on the display: lift the window above the others without activating it, copy the screen, put it back.
          SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0013); System.Threading.Thread.Sleep(400);
          using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(ww, wh));
          SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
        } else using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
        if (png != "") bmp.Save(png, ImageFormat.Png);
        int cx0 = ww - w, cy0 = wh - hh; // client starts after the frame; with a top caption the frame is mostly the top
        // Client origin on screen:
        var pt = new POINT(); ClientToScreen(h, ref pt);
        cx0 = pt.X - r.L; cy0 = pt.Y - r.T;
        int minx = int.MaxValue, miny = int.MaxValue, maxx = -1, maxy = -1;
        var data = bmp.LockBits(new Rectangle(0, 0, ww, wh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        unsafe0(data, cx0, cy0, w, hh, ref minx, ref miny, ref maxx, ref maxy);
        bmp.UnlockBits(data);
        res += ",\"paintedBox\":[" + (maxx < 0 ? 0 : maxx - minx + 1) + "," + (maxy < 0 ? 0 : maxy - miny + 1) + "],\"origin\":[" + (maxx < 0 ? 0 : minx) + "," + (maxy < 0 ? 0 : miny) + "]";
      }
    }
    return res + "}";
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  static void unsafe0(BitmapData d, int x0, int y0, int w, int h, ref int minx, ref int miny, ref int maxx, ref int maxy) {
    byte[] row = new byte[d.Stride];
    for (int y = y0; y < y0 + h && y < d.Height; y++) {
      Marshal.Copy(IntPtr.Add(d.Scan0, y * d.Stride), row, 0, d.Stride);
      for (int x = x0; x < x0 + w && x < d.Width; x++) {
        int i = x * 4; // BGRA: anything that is not pure black counts as painted
        if (row[i] + row[i + 1] + row[i + 2] > 6) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      }
    }
    if (maxx >= 0) { minx -= x0; maxx -= x0; miny -= y0; maxy -= y0; }
  }
}
'@
[W]::Do([uint32]$ProcessId, $Action, $Png)
