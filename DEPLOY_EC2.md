# 🚀 Deploying HealOps to AWS EC2

This guide outlines the end-to-end steps to deploy **HealOps** on an AWS EC2 instance for 24/7 autonomous CI/CD self-healing.

---

## 📋 Prerequisites
- An active AWS Account.
- Your GitHub App credentials (`APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`).
- Your Groq API key (`GROQ_API_KEY`).

---

## Step 1: Launch an AWS EC2 Instance

1. In the **AWS EC2 Console**, click **Launch Instance**.
2. **Name**: `healops-agent`
3. **AMI**: **Ubuntu Server 24.04 LTS** (or 22.04 LTS), 64-bit (x86_64 or arm64).
4. **Instance Type**:
   - Recommended: **`t3.small`** (2 vCPU, 2 GiB RAM) or **`t4g.small`** (AWS Graviton, lower cost).
   - *Note*: Running sandboxed `npm install` and `npm run build` needs at least 2 GB RAM.
5. **Key Pair**: Select or create an SSH key pair (e.g. `healops-key.pem`).
6. **Storage**: 20 GiB gp3 (sufficient for Docker images and ephemeral sandboxes).

---

## Step 2: Configure the EC2 Security Group

Under **Network settings** / **Security Groups**, configure the following Inbound Rules:

| Type | Port Range | Source | Purpose |
| :--- | :---: | :---: | :--- |
| **SSH** | `22` | `My IP` (or restricted CIDR) | Secure terminal access |
| **Custom TCP** | `3000` | `0.0.0.0/0` (Anywhere) | GitHub Webhook direct ingestion |
| **HTTP** *(Optional)* | `80` | `0.0.0.0/0` (Anywhere) | Only needed if using domain / Caddy SSL |
| **HTTPS** *(Optional)* | `443` | `0.0.0.0/0` (Anywhere) | Only needed if using domain / Caddy SSL |

> [!TIP]
> If you only want GitHub to access Port 3000, you can optionally restrict the IP range to [GitHub's official webhook CIDR ranges](https://api.github.com/meta).

---

## Step 3: Connect to EC2 & Clone the Repository

SSH into your EC2 instance from your terminal:
```bash
ssh -i "path/to/healops-key.pem" ubuntu@<YOUR-EC2-PUBLIC-IP>
```

Clone your repository onto the instance:
```bash
git clone https://github.com/akashbirajdar04/DevOpsPilot.git
cd DevOpsPilot
```

---

## Step 4: Configure the Production `.env` File

Create the `.env` file on the instance:
```bash
cp .env.example .env
nano .env
```

Populate your `.env` values:
```dotenv
# GitHub App Configuration
APP_ID=5467590
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----"
WEBHOOK_SECRET=your_github_webhook_secret

# LLM Engine (Groq)
GROQ_API_KEY=gsk_your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-120b
GROQ_TURN_DELAY_MS=2000

# Server Settings
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
MAX_RETRY_ITERATIONS=3

# IMPORTANT: Ensure WEBHOOK_PROXY_URL is NOT set or commented out!
# On EC2, GitHub delivers webhooks directly to your public IP.
```

Save and exit in nano: `Ctrl + O`, `Enter`, then `Ctrl + X`.

---

## Step 5: Automated Setup & Launch

Run the automated setup script:
```bash
chmod +x deploy/setup-ec2.sh
./deploy/setup-ec2.sh
```

This script automatically:
1. Installs Docker and the Docker Compose plugin.
2. Configures Docker daemon with auto-start.
3. Builds the HealOps image with Node 20 (Debian/glibc) and Git.
4. Starts the container with `restart: unless-stopped` and log rotation.

---

## Step 6: Verify the Service is Running

Check container status:
```bash
docker compose ps
```

Test the healthcheck endpoint:
```bash
curl http://localhost:3000/ping
# Should output: PONG
```

Test from your local machine browser or curl:
```bash
curl http://<YOUR-EC2-PUBLIC-IP>:3000/ping
# Should output: PONG
```

---

## Step 7: Update Webhook URL in GitHub App

1. Go to **[GitHub Developer Settings > GitHub Apps](https://github.com/settings/apps)**.
2. Select your **HealOps** App.
3. Scroll down to **Webhook**:
   - **Webhook URL**:
     ```text
     http://<YOUR-EC2-PUBLIC-IP>:3000/api/github/webhooks
     ```
   - **Webhook secret**: Must match `WEBHOOK_SECRET` in your `.env`.
   - Ensure **Active** is checked.
4. Click **Save changes**.
5. Click **Advanced** > **Recent Deliveries** and click **Redeliver** on a past ping event to verify the green `200 OK` checkmark!

---

## 🛠️ Management & Maintenance Commands

| Action | Command |
| :--- | :--- |
| **View Live Logs** | `docker compose logs -f healops` |
| **Restart Service** | `docker compose restart healops` |
| **Stop Service** | `docker compose down` |
| **Update Code** | `git pull && docker compose build && docker compose up -d` |
| **Inspect Health** | `curl -i http://localhost:3000/ping` |
