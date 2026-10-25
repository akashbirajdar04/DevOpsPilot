"""Local Development Tunnel Launcher (Cloudflare Tunnels & ngrok)."""

import os
import re
import shutil
import subprocess
import sys
import time


def main():
    port = int(os.environ.get("PORT", "8000"))
    print(f"🚀 Initializing DevOpsPilot Local Tunnel for port {port}...")

    # Check for Cloudflare Tunnels (100% free, no login needed for quick tunnels)
    if shutil.which("cloudflared"):
        print("Detected 'cloudflared'. Launching free Cloudflare Tunnel...")
        print(f"Forwarding public HTTPS -> http://localhost:{port}")
        cmd = ["cloudflared", "tunnel", "--url", f"http://localhost:{port}"]
        try:
            subprocess.run(cmd)
        except KeyboardInterrupt:
            print("\nCloudflare tunnel terminated.")
        return

    # Check for ngrok
    if shutil.which("ngrok"):
        print("Detected 'ngrok'. Launching ngrok tunnel...")
        print(f"Forwarding public HTTPS -> http://localhost:{port}")
        cmd = ["ngrok", "http", str(port)]
        try:
            subprocess.run(cmd)
        except KeyboardInterrupt:
            print("\nngrok tunnel terminated.")
        return

    print("⚠️ Neither 'cloudflared' nor 'ngrok' was found in PATH.")
    print("\nHow to install Cloudflare Tunnels (100% Free):")
    print("  - Windows: winget install Cloudflare.cloudflared")
    print("  - macOS: brew install cloudflared")
    print("  - Linux: sudo apt install cloudflared")
    print("\nAlternatively, install ngrok:")
    print("  - https://ngrok.com/download")
    print("\nOnce installed, configure your GitHub Webhook URL to:")
    print("  https://<your-tunnel-url>/api/v1/webhook/github")
    print("  Content type: application/json")
    print("  Secret: your GITHUB_WEBHOOK_SECRET")
    print("  Event: workflow_job")


if __name__ == "__main__":
    main()
