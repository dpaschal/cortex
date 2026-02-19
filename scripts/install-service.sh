#!/bin/bash
# Install cortex as a systemd service

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/cortex.service"

echo "Installing cortex systemd service..."

# Copy service file
sudo cp "$SERVICE_FILE" /etc/systemd/system/cortex.service

# Reload systemd
sudo systemctl daemon-reload

# Enable service (start on boot)
sudo systemctl enable cortex

echo "Service installed. Commands:"
echo "  sudo systemctl start cortex   # Start now"
echo "  sudo systemctl status cortex  # Check status"
echo "  sudo journalctl -u cortex -f  # View logs"
