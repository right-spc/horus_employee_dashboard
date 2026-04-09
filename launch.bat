@echo off
:: Horus Desk Dashboard Launcher
:: Double-click this file to open the dashboard

:: Find an available port starting from 47432
:: (obscure enough to avoid conflicts)
set PORT=47432

:: Check if Python is available, then Node, then fall back with error
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo Starting Horus Desk Dashboard on port %PORT%...
    start "" "http://localhost:%PORT%"
    python -m http.server %PORT%
    goto :end
)

python3 --version >nul 2>&1
if %errorlevel% == 0 (
    echo Starting Horus Desk Dashboard on port %PORT%...
    start "" "http://localhost:%PORT%"
    python3 -m http.server %PORT%
    goto :end
)

node --version >nul 2>&1
if %errorlevel% == 0 (
    echo Starting Horus Desk Dashboard on port %PORT%...
    start "" "http://localhost:%PORT%"
    npx serve . -l %PORT%
    goto :end
)

echo ERROR: Could not find Python or Node.js.
echo Please install Python from https://python.org or Node.js from https://nodejs.org
pause

:end
