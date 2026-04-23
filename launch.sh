#!/bin/bash
# Horus Desk Dashboard Launcher
# Run with: bash launch.sh
# Or make executable once with: chmod +x launch.sh
# Then double-click or run: ./launch.sh

PORT=47432

# Function to open browser
open_browser() {
    sleep 1  # Give server a moment to start
    if command -v xdg-open &> /dev/null; then
        xdg-open "http://localhost:$PORT"
    elif command -v gnome-open &> /dev/null; then
        gnome-open "http://localhost:$PORT"
    else
        echo "Open your browser and go to: http://localhost:$PORT"
    fi
}

echo "Starting Horus Desk Dashboard on port $PORT..."

# Open browser in background
open_browser &

# Try Python 3, then Python, then Node
if command -v python3 &> /dev/null; then
    python3 -m http.server $PORT
elif command -v python &> /dev/null; then
    python -m http.server $PORT
elif command -v node &> /dev/null; then
    npx serve . -l $PORT
else
    echo "ERROR: Could not find Python or Node.js."
    echo "Install Python: sudo apt install python3"
    echo "Or Node.js: https://nodejs.org"
    exit 1
fi
