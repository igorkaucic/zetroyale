# ZET Royale Deploy Script - Build + Push to GitHub Pages
$ErrorActionPreference = "Stop"

# Bump version in package.json
Write-Host "Bumping version..." -ForegroundColor Cyan
npm version patch --no-git-tag-version
$packageData = Get-Content package.json | ConvertFrom-Json
$newVersion = $packageData.version
Write-Host " Version bumped to: $newVersion" -ForegroundColor Green

# Write version.ts for the React app
Set-Content -Path "src/version.ts" -Value "export const APP_VERSION = '$newVersion';" -Encoding UTF8

# Patch service worker version to trigger auto-update
$swFile = "public/sw.js"
if (Test-Path $swFile) {
    $swContent = Get-Content $swFile -Raw
    $swContent = $swContent -replace "// VERSION: .*", "// VERSION: $newVersion"
    $swContent = $swContent -replace "const CACHE_VERSION = 'zr-v.*?'", "const CACHE_VERSION = 'zr-v$newVersion'"
    Set-Content -Path $swFile -Value $swContent -Encoding UTF8 -NoNewline
    Write-Host " SW version synced: zr-v$newVersion" -ForegroundColor Green
}

Write-Host "Building ZET Royale..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

# Commit and push to main repo
Write-Host "Deploying to GitHub Pages..." -ForegroundColor Green
git add .
git commit -m "Deploy v$newVersion"
git push origin main

# Deploy to gh-pages branch
npx -y gh-pages -d ../public_v2
Write-Host "Deployed v$newVersion to https://igorkaucic.github.io/zetroyale/" -ForegroundColor Green

