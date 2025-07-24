#!/bin/bash

# Exa Dedupe - Stop All Services Script

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[$(date +'%H:%M:%S')] ✅${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[$(date +'%H:%M:%S')] ⚠️${NC} $1"
}

print_status "🛑 Stopping Exa Dedupe Application Stack"
print_status "======================================="

# Stop Node.js processes
print_status "Stopping Node.js services..."
pkill -f "npm run dev" 2>/dev/null || true
pkill -f "node.*server.js" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "nodemon" 2>/dev/null || true

# Stop processes using PID files if they exist
if [ -f "main-app.pid" ]; then
    MAIN_PID=$(cat main-app.pid)
    if kill -0 $MAIN_PID 2>/dev/null; then
        print_status "Stopping main application (PID: $MAIN_PID)..."
        kill $MAIN_PID 2>/dev/null || true
    fi
    rm -f main-app.pid
fi

if [ -f "vector-service.pid" ]; then
    VECTOR_PID=$(cat vector-service.pid)
    if kill -0 $VECTOR_PID 2>/dev/null; then
        print_status "Stopping vector service (PID: $VECTOR_PID)..."
        kill $VECTOR_PID 2>/dev/null || true
    fi
    rm -f vector-service.pid
fi

# Stop vector service conda processes
print_status "Stopping vector service..."
pkill -f "python.*app.py" 2>/dev/null || true
pkill -f "conda.*vector-service" 2>/dev/null || true

# Stop Docker services
print_status "Stopping Docker services..."
docker-compose down

# Force kill any remaining processes on our ports
print_status "Cleaning up remaining processes..."
for port in 3000 3001 7001 8003 9001 9000 27017; do
    pids=$(lsof -t -i :$port 2>/dev/null || echo "")
    if [ ! -z "$pids" ]; then
        print_warning "Force killing processes on port $port"
        kill -9 $pids 2>/dev/null || true
    fi
done

print_success "🎉 All services stopped successfully!"
print_status "You can restart with: ./setup.sh" 