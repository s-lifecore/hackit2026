@echo off
chcp 65001 >nul
setlocal

rem 開発者向け：ソースコードから依存関係をインストールしてアプリを起動する。
rem このリポジトリのルートフォルダで実行してください。

where npm >nul 2>nul
if errorlevel 1 (
  echo [エラー] npm が見つかりません。Node.js をインストールしてから、もう一度実行してください。
  echo https://nodejs.org/
  pause
  exit /b 1
)

cd /d "%~dp0.."

echo 依存関係をインストールしています（npm install）...
call npm install
if errorlevel 1 (
  echo [エラー] npm install に失敗しました。
  pause
  exit /b 1
)

echo アプリを起動します（npm start）...
call npm start
