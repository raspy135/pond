# Pond installer for Windows (PowerShell 5.1+)
#   irm https://raw.githubusercontent.com/raspy135/pond/main/install.ps1 | iex
# Re-run any time to update — your .env and data\ are never touched.
# Options (env vars): POND_HOME (default ~\pond)  POND_REPO (raspy135/pond)  POND_BRANCH (main)
#                     POND_NO_START=1 (don't launch)  POND_SOURCE_DIR (install from a local folder)
& {
  $ErrorActionPreference = 'Stop'
  $Repo   = if ($env:POND_REPO)   { $env:POND_REPO }   else { 'raspy135/pond' }
  $Branch = if ($env:POND_BRANCH) { $env:POND_BRANCH } else { 'main' }
  $Dir    = if ($env:POND_HOME)   { $env:POND_HOME }   else { Join-Path $HOME 'pond' }
  function Say($m)  { Write-Host "[pond] $m" -ForegroundColor Cyan }
  function Fail($m) { Write-Host "[pond] $m" -ForegroundColor Red; throw $m }  # throw (not exit) so `| iex` doesn't close the window
  function NodeOk { try { $v = & node -p "process.versions.node.split('.')[0]" 2>$null; return ([int]$v -ge 18) } catch { return $false } }
  function PyOk {
    foreach ($c in @(@('py', '-3'), @('python'))) {
      try { $v = & $c[0] @($c | Select-Object -Skip 1) -c "import sys; print(sys.version_info[1])" 2>$null
            if ($LASTEXITCODE -eq 0 -and [int]$v -ge 9) { return $true } } catch { }
    }
    return $false
  }

  # 1) Node.js 18+
  if (-not (NodeOk)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Say 'Installing Node.js LTS with winget...'
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Host
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if (-not (NodeOk)) { Fail 'Node.js 18+ is required - install it from https://nodejs.org and run this again.' }
  }
  Say "Using Node $(node -v)"

  # 1b) Python 3.9+ (required: data, spreadsheets, PDFs, scripts)
  if (-not (PyOk)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Say 'Installing Python 3.12 with winget...'
      winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements --silent | Out-Host
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if (-not (PyOk)) { Fail 'Python 3.9+ is required - install it from https://www.python.org/downloads/ (tick "Add to PATH") and run this again.' }
  }

  # 2) Download or update Pond (keeps .env and data\)
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($env:POND_SOURCE_DIR) {
    Say "Copying from $($env:POND_SOURCE_DIR)..."
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Get-ChildItem -LiteralPath $env:POND_SOURCE_DIR -Force |
      Where-Object { $_.Name -notin @('data', '.env', '.git', 'node_modules', '.venv') -and $_.Name -notlike '.backup*' } |
      Copy-Item -Destination $Dir -Recurse -Force
  } elseif ($git -and (Test-Path (Join-Path $Dir '.git'))) {
    Say "Updating $Dir..."
    git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail 'git pull failed (local changes?). Fix them or delete the folder and re-run.' }
  } elseif ($git -and -not (Test-Path $Dir)) {
    Say "Downloading Pond to $Dir..."
    git clone --depth 1 -b $Branch "https://github.com/$Repo.git" $Dir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
  } else {
    Say "Downloading Pond to $Dir..."
    $tmp = Join-Path $env:TEMP ("pond-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'pond.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Get-ChildItem -LiteralPath $src.FullName -Force | Copy-Item -Destination $Dir -Recurse -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force
  }
  Set-Location $Dir

  # 3) Configure
  if ($env:POND_NONINTERACTIVE) { node scripts/setup.mjs --yes } else { node scripts/setup.mjs }

  # 4) Desktop shortcut
  try {
    $desk = [Environment]::GetFolderPath('Desktop')
    if ($desk) {
      $ws = New-Object -ComObject WScript.Shell
      $lnk = $ws.CreateShortcut((Join-Path $desk 'Pond.lnk'))
      $lnk.TargetPath = Join-Path $Dir 'start.bat'
      $lnk.WorkingDirectory = $Dir
      $ico = Join-Path $Dir 'public\icons\pond.ico'
      if (Test-Path $ico) { $lnk.IconLocation = $ico }
      $lnk.Save()
      Say 'Added a "Pond" shortcut to your desktop.'
    }
  } catch { }

  # 5) Start
  $port = 8787
  $line = Select-String -Path (Join-Path $Dir '.env') -Pattern '^PORT=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
  $running = $false
  try { $running = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) } catch { }
  if ($running) {
    Say "Pond is already running on port $port - restart it (rebuild.bat) to load this version."
  } elseif ($env:POND_NO_START) {
    Say "Installed. Start it with the desktop shortcut or $Dir\start.bat"
  } else {
    Say "Installed in $Dir - starting Pond..."
    Start-Process -FilePath (Join-Path $Dir 'start.bat') -WorkingDirectory $Dir
  }
}
