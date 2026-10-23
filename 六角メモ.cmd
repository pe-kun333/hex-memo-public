@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo 六角メモ：初回の準備をしています。Electron をダウンロードするため、数分かかることがあります…
  echo.
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Node.js が見つかりません。https://nodejs.org/ から LTS 版をインストールしてから、もう一度ダブルクリックしてください。
    echo.
    pause
    exit /b 1
  )
  call npm install --no-fund --no-audit
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo 準備に失敗しました。上のメッセージを確認してください。
    echo.
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" . %*
