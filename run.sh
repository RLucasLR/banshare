#!/usr/bin/env bash
set -euo pipefail

#──────────────────────────────────────────────
# Banshare Bot — run.sh
# Usage:  ./run.sh          → development mode
#         ./run.sh prod      → production mode
#──────────────────────────────────────────────

MODE="${1:-dev}"
APP_NAME="banshare"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_FILE="$SCRIPT_DIR/banshare-db.sqllite"
BACKUP_DIR="$SCRIPT_DIR/backups"
ENV_FILE="$SCRIPT_DIR/src/.env"
LOG_FILE="$SCRIPT_DIR/logs/banshare.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

#──────────────────────────────────────────────
# Preflight checks
#──────────────────────────────────────────────
preflight() {
    echo ""
    echo "═══════════════════════════════════════"
    echo "  Banshare — Preflight Checks"
    echo "═══════════════════════════════════════"
    echo ""

    # Node.js installed
    command -v node >/dev/null 2>&1 || fail "Node.js is not installed"
    NODE_VER="$(node -v)"
    log "Node.js $NODE_VER"

    # Minimum Node version (v18+)
    NODE_MAJOR="${NODE_VER%%.*}"
    NODE_MAJOR="${NODE_MAJOR#v}"
    if [ "$NODE_MAJOR" -lt 18 ]; then
        fail "Node.js v18+ required (found $NODE_VER)"
    fi

    # npm installed
    command -v npm >/dev/null 2>&1 || fail "npm is not installed"
    log "npm $(npm -v)"

    # .env file exists and has DISCORD_TOKEN
    if [ ! -f "$ENV_FILE" ]; then
        fail "Missing $ENV_FILE — copy src/.env.example and fill in values"
    fi

    if ! grep -qE '^DISCORD_TOKEN=.+' "$ENV_FILE"; then
        fail "DISCORD_TOKEN is not set in $ENV_FILE"
    fi
    log "Environment file OK"

    # Dependencies installed
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        warn "node_modules not found — installing dependencies..."
        npm ci --prefix "$SCRIPT_DIR"
    fi
    log "Dependencies OK"

    # TypeScript build
    if [ ! -f "$SCRIPT_DIR/dist/index.js" ]; then
        warn "No build found — building..."
        npm run build --prefix "$SCRIPT_DIR"
    elif [ "$MODE" = "prod" ]; then
        log "Rebuilding for production..."
        npm run build --prefix "$SCRIPT_DIR"
    fi
    log "Build OK"

    # Check dist/index.js isn't empty
    if [ ! -s "$SCRIPT_DIR/dist/index.js" ]; then
        fail "dist/index.js is empty — build may have failed"
    fi

    echo ""
    log "All preflight checks passed"
    echo ""
}

#──────────────────────────────────────────────
# Database backup
#──────────────────────────────────────────────
backup_db() {
    if [ ! -f "$DB_FILE" ]; then
        warn "No database file found — skipping backup (first run)"
        return
    fi

    mkdir -p "$BACKUP_DIR"

    TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
    BACKUP_FILE="$BACKUP_DIR/banshare-db_${TIMESTAMP}.sqllite"

    cp "$DB_FILE" "$BACKUP_FILE"
    log "Database backed up → $BACKUP_FILE"

    # Keep only the 10 most recent backups
    BACKUP_COUNT="$(find "$BACKUP_DIR" -name 'banshare-db_*.sqllite' -type f | wc -l | tr -d ' ')"
    if [ "$BACKUP_COUNT" -gt 10 ]; then
        find "$BACKUP_DIR" -name 'banshare-db_*.sqllite' -type f \
            | sort \
            | head -n "$(( BACKUP_COUNT - 10 ))" \
            | xargs rm -f
        log "Pruned old backups (kept 10 most recent)"
    fi
}

#──────────────────────────────────────────────
# Start — Development
#──────────────────────────────────────────────
start_dev() {
    echo "═══════════════════════════════════════"
    echo "  Starting in DEVELOPMENT mode"
    echo "═══════════════════════════════════════"
    echo ""

    export NODE_ENV=development
    exec npm run watch:start --prefix "$SCRIPT_DIR"
}

#──────────────────────────────────────────────
# Start — Production
#──────────────────────────────────────────────
start_prod() {
    echo "═══════════════════════════════════════"
    echo "  Starting in PRODUCTION mode"
    echo "═══════════════════════════════════════"
    echo ""

    export NODE_ENV=production

    # Create logs directory
    mkdir -p "$(dirname "$LOG_FILE")"

    if command -v pm2 >/dev/null 2>&1; then
        log "pm2 detected — using process manager"

        # Stop existing instance if running
        if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
            pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
        fi

        pm2 start "$SCRIPT_DIR/dist/index.js" \
            --name "$APP_NAME" \
            --cwd "$SCRIPT_DIR" \
            --log "$LOG_FILE" \
            --time \
            --max-memory-restart 512M \
            --restart-delay 5000 \
            --max-restarts 10 \
            --env production

        pm2 save

        log "Bot running under pm2"
        echo ""
        echo "  pm2 status    — view status"
        echo "  pm2 logs $APP_NAME — view logs"
        echo "  pm2 stop $APP_NAME — stop bot"
        echo ""
    else
        warn "pm2 not found — running directly (install pm2 globally for process management)"
        exec node "$SCRIPT_DIR/dist/index.js" 2>&1 | tee -a "$LOG_FILE"
    fi
}

#──────────────────────────────────────────────
# Main
#──────────────────────────────────────────────
case "$MODE" in
    prod|production)
        MODE="prod"
        preflight
        backup_db
        start_prod
        ;;
    dev|development|"")
        MODE="dev"
        preflight
        backup_db
        start_dev
        ;;
    *)
        echo "Usage: $0 [prod|dev]"
        exit 1
        ;;
esac
