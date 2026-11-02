#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# HealOps: Automated Setup Script for AWS EC2 (Ubuntu 22.04 / 24.04 LTS)
# ==============================================================================

echo "🚀 [1/5] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl gnupg lsb-release git

echo "🐳 [2/5] Installing Docker Engine & Docker Compose plugin..."
if ! command -v docker &> /dev/null; then
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "👤 [3/5] Adding current user ($USER) to docker group..."
sudo usermod -aG docker "$USER" || true
sudo systemctl enable docker
sudo systemctl start docker

echo "⚙️ [4/5] Checking configuration..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "⚠️ .env not found. Creating from .env.example..."
        cp .env.example .env
        echo "❗ Please edit .env with your real GitHub App and Groq credentials: nano .env"
    fi
fi

echo "🚢 [5/5] Building and launching HealOps container..."
sudo docker compose build
sudo docker compose up -d

echo ""
echo "=================================================================="
echo "✅ HealOps is successfully running in Docker on EC2!"
echo "=================================================================="
echo "🔍 View logs:         sudo docker compose logs -f healops"
echo "🛑 Stop service:      sudo docker compose down"
echo "🔄 Restart service:   sudo docker compose restart healops"
echo "🩺 Health status:     curl http://localhost:3000/ping"
echo "=================================================================="
