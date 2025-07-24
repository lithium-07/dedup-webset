#!/bin/bash

# Exa Dedupe - Complete Setup Script
# This script starts all services needed for the application

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[$(date +'%H:%M:%S')] ✅${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[$(date +'%H:%M:%S')] ⚠️${NC} $1"
}

print_error() {
    echo -e "${RED}[$(date +'%H:%M:%S')] ❌${NC} $1"
}

# Function to check if a port is in use
check_port() {
    local port=$1
    if lsof -i :$port > /dev/null 2>&1; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Function to kill processes on specific ports
kill_port() {
    local port=$1
    local pids=$(lsof -t -i :$port 2>/dev/null || echo "")
    if [ ! -z "$pids" ]; then
        print_warning "Killing processes on port $port: $pids"
        kill -9 $pids 2>/dev/null || true
        sleep 2
    fi
}

# Function to wait for service to be ready
wait_for_service() {
    local url=$1
    local service_name=$2
    local max_attempts=30
    local attempt=1
    
    print_status "Waiting for $service_name to be ready..."
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s "$url" > /dev/null 2>&1; then
            print_success "$service_name is ready!"
            return 0
        fi
        
        if [ $((attempt % 5)) -eq 0 ]; then
            print_status "Still waiting for $service_name... (attempt $attempt/$max_attempts)"
        fi
        
        sleep 2
        attempt=$((attempt + 1))
    done
    
    print_error "$service_name failed to start after $max_attempts attempts"
    return 1
}

# Cleanup function for graceful shutdown
cleanup() {
    print_warning "Shutting down Docker services..."
    
    # Stop Docker services
    docker-compose down 2>/dev/null || true
    
    print_warning "Note: Please manually close the terminal windows for:"
    print_warning "  • Vector Service (conda environment)"
    print_warning "  • Main Application (Frontend + Backend)"
    
    print_success "Docker services stopped. Setup script cleanup completed."
}

# Set up trap for cleanup on script exit
trap cleanup EXIT INT TERM

print_status "🚀 Starting Exa Dedupe Application Stack"
print_status "======================================="

# Step 1: Clean up any existing processes
print_status "Cleaning up existing processes..."
kill_port 3000  # Backend
kill_port 3001  # Frontend  
kill_port 7001  # Vector service
kill_port 8003  # Clustering service
kill_port 9001  # Semantic service

# Step 2: Check required dependencies
print_status "Checking dependencies..."

# Check Docker
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed. Please install Docker first."
    exit 1
fi

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check npm
if ! command -v npm &> /dev/null; then
    print_error "npm is not installed. Please install npm first."
    exit 1
fi

# Check conda
if ! command -v conda &> /dev/null; then
    print_error "Conda is not installed. Please install Miniconda or Anaconda first."
    exit 1
fi

print_success "All dependencies found"

# Step 3: Install Node.js dependencies if needed
if [ ! -d "node_modules" ]; then
    print_status "Installing Node.js dependencies..."
    npm install
fi

if [ ! -d "backend/node_modules" ]; then
    print_status "Installing backend dependencies..."
    cd backend && npm install && cd ..
fi

# Step 4: Start Docker services
print_status "Starting Docker services..."
docker-compose up -d mongodb chromadb semantic_search clustering-service

# Wait for core services
wait_for_service "http://localhost:9000/api/v1/heartbeat" "ChromaDB"
wait_for_service "http://localhost:8003/health" "Clustering Service" 
wait_for_service "http://localhost:9001/health" "Semantic Service"

# Step 5: Start Vector Service with conda in new terminal
print_status "Starting Vector Service in new terminal..."

# Check if conda environment exists
if ! conda env list | grep -q "vector-service"; then
    print_warning "Conda environment 'vector-service' not found. Creating it..."
    conda create -n vector-service python=3.11 -y
fi

# Install dependencies first
print_status "Installing vector service dependencies..."
(cd vector-service && conda run -n vector-service python -m pip install -r requirements.txt 2>/dev/null || true)

# Start vector service in new terminal window
print_status "Opening Vector Service in new terminal window..."
osascript -e "tell application \"Terminal\" to do script \"cd $(pwd)/vector-service && conda activate vector-service && echo '🚀 Vector Service Starting...' && python app.py\""

# Wait for vector service to start
print_status "Waiting for Vector Service to start..."
sleep 8
wait_for_service "http://localhost:7001/health" "Vector Service"

# Step 6: Start Backend and Frontend in new terminal
print_status "Starting Node.js services in new terminal..."

# Start main application in new terminal window
print_status "Opening Main Application (Frontend + Backend) in new terminal window..."
osascript -e "tell application \"Terminal\" to do script \"cd $(pwd) && echo '🚀 Main Application Starting (Frontend + Backend)...' && npm run dev\""

# Wait for services to be ready
print_status "Waiting for Node.js services to start..."
sleep 8
wait_for_service "http://localhost:3000/api/stats/database" "Backend API"
wait_for_service "http://localhost:3001" "Frontend"

# Step 8: Display service status
print_success "🎉 All services are running!"
echo ""
print_status "Service Status:"
echo "  ✅ MongoDB:          http://localhost:27017"
echo "  ✅ ChromaDB:         http://localhost:9000"
echo "  ✅ Vector Service:   http://localhost:7001"
echo "  ✅ Clustering:       http://localhost:8003"
echo "  ✅ Semantic Search:  http://localhost:9001"
echo "  ✅ Backend API:      http://localhost:3000"
echo "  ✅ Frontend:         http://localhost:3001"
echo ""
print_status "🌐 Open your browser to: http://localhost:3001"
echo ""
print_status "💡 Useful Commands:"
echo "  • View logs: docker-compose logs -f"
echo "  • Stop all: ./stop.sh (or Ctrl+C)"
echo "  • Restart: ./setup.sh"
echo ""

# Step 9: Keep script running to maintain Docker services
print_status "🎯 All services started in separate terminals!"
print_status "📺 Check the new terminal windows for:"
print_status "   • Vector Service logs (port 7001)"
print_status "   • Frontend + Backend logs (ports 3001 & 3000)"
echo ""
print_status "Press Ctrl+C to stop Docker services and exit"
print_status "Note: You'll need to manually close the terminal windows for vector and main app"
echo ""

# Keep the script running to maintain Docker containers
# This will wait indefinitely until Ctrl+C
while true; do
    sleep 10
    # Optional: Check if services are still running and restart if needed
    if ! curl -s "http://localhost:7001/health" > /dev/null 2>&1; then
        print_warning "Vector service appears to be down"
    fi
    if ! curl -s "http://localhost:3000/api/stats/database" > /dev/null 2>&1; then
        print_warning "Backend service appears to be down"
    fi
done 