// Shows the Windows "select folder" window and returns the chosen path (or null if cancelled).
// The browser cannot tell a local program which folder was picked, so the dialog is opened from
// here instead, through PowerShell.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Tries the modern Explorer-style folder picker first and falls back to the classic tree dialog.
const SCRIPT = String.raw`
param([string]$Title, [string]$Start, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Show()
$owner.Activate()
$result = $null
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SeedTesterFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialog { }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes();
    void SetFileTypeIndex();
    void GetFileTypeIndex();
    void Advise();
    void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler();
    void GetParent();
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

  public static string Pick(IntPtr owner, string title, string start) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20 | 0x40 | 0x800); // pick folders, file system only, path must exist
    dialog.SetTitle(title);
    dialog.SetOkButtonLabel("Select world folder");
    if (!String.IsNullOrEmpty(start)) {
      try {
        IShellItem item;
        SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out item);
        dialog.SetFolder(item);
      } catch { }
    }
    if (dialog.Show(owner) != 0) return null;
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
  if ($DryRun) { $result = 'modern picker ready' } else { $result = [SeedTesterFolderPicker]::Pick($owner.Handle, $Title, $Start) }
} catch {
  if ($DryRun) { [Console]::Out.Write("classic picker only: $_"); $owner.Close(); exit 0 }
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = $Title
  $dialog.ShowNewFolderButton = $false
  if ($Start) { $dialog.SelectedPath = $Start }
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $result = $dialog.SelectedPath }
}
$owner.Close()
if ($result) { [Console]::Out.Write($result) }
`

/**
 * Opens the picker. dryRun only prepares it and reports which kind is available, without
 * showing a window (used for testing).
 */
export function pickFolder({ title, start = '', dryRun = false }) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('The folder picker is only available on Windows.'))
  }
  // Run from a file so the title and start folder travel as real arguments, never as script text.
  const script = path.join(os.tmpdir(), 'seedtester-folder-picker.ps1')
  fs.writeFileSync(script, '\ufeff' + SCRIPT, 'utf8')
  const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title]
  if (start) args.push('-Start', start)
  if (dryRun) args.push('-DryRun')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`The folder window could not be opened: ${(stderr || error.message).trim().split('\n')[0]}`))
      const chosen = stdout.trim()
      resolve(chosen === '' ? null : chosen)
    })
  })
}
