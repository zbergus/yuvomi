# Arcane Stack Deployment for Yuvomi

This directory contains the stack definition for running Yuvomi in [Arcane](https://github.com/thespotteddemon/arcane) on TrueNAS SCALE or Docker hosts.

## Quick Start

1. **Create Stack in Arcane**:
   - In the Arcane web UI, create a new Stack named `yuvomi`.
   - Copy the contents of `docker-compose.yml` into the Compose editor.
   - Copy the contents of `.env.example` into the Environment editor and set:
     - `SESSION_SECRET`: Generate with `openssl rand -hex 32`
     - `YUVOMI_PORT`: Port to expose (default `3000`)
     - Storage paths (`YUVOMI_DATA_DIR`, `YUVOMI_BACKUP_DIR`, `YUVOMI_MODULES_DIR`, `YUVOMI_DOCUMENTS_DIR`)
2. **Norish Recipe Provider Integration**:
   - Ensure `RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK=true` is set.
   - Once Yuvomi is running, navigate to **Settings -> Modules -> Kitchen -> Recipe Provider**.
   - Select **Norish**.
   - Enter your Norish URL (e.g., `http://192.168.0.63:9096`) and your Norish API token.
   - Test connection and save.
