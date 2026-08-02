@echo off
chcp 65001 >nul
setlocal

rem このbatと同じフォルダにある FileFly-portable-*.exe を起動する。
rem GitHub Releases から exe をダウンロードして、この bat と同じフォルダに置いてください。

set FOUND=
for %%F in ("%~dp0FileFly-portable-*.exe") do set FOUND=%%~fF

if not defined FOUND (
  echo [エラー] FileFly-portable-*.exe が見つかりません。
  echo このbatファイルと同じフォルダに、GitHub Releases からダウンロードした
  echo FileFly-portable-1.0.0.exe を置いてから、もう一度実行してください。
  pause
  exit /b 1
)

echo FileFly を起動します: %FOUND%
start "" "%FOUND%"
