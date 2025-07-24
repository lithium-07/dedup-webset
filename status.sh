#!/bin/bash

# Exa Dedupe - Service Status Check Script

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${BLUE}$1${NC}"
}

check_service() {
    local url=$1
    local name=$2
    local port=$3
    
    printf "  %-20s " "$name:"
    
    # Check if port is in use
    if ! lsof -i :$port > /dev/null 2>&1; then
        echo -e "${RED}❌ Not running (port $port free)${NC}"
        return 1
    fi
    
    # Check if service responds
    if curl -s "$url" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Running${NC} (http://localhost:$port)"
        return 0
    else
        echo -e "${YELLOW}⚠️  Port busy but no response${NC} (port $port)"
        return 1
    fi
}

check_docker_service() {
    local service_name=$1
    local display_name=$2
    
    printf "  %-20s " "$display_name:"
    
    if docker-compose ps --services --filter "status=running" | grep -q "^$service_name$"; then
        echo -e "${GREEN}✅ Running${NC} (Docker)"
        return 0
    else
        echo -e "${RED}❌ Not running${NC} (Docker)"
        return 1
    fi
}

echo ""
print_header "🔍 Exa Dedupe - Service Status Check"
print_header "===================================="
echo ""

print_header "Docker Services:"
check_docker_service "mongodb" "MongoDB"
check_docker_service "chromadb" "ChromaDB" 
check_docker_service "semantic_search" "Semantic Search"
check_docker_service "clustering-service" "Clustering"

echo ""
print_header "Node.js Services:"
check_service "http://localhost:3000/api/stats/database" "Backend API" 3000
check_service "http://localhost:3001" "Frontend" 3001

echo ""
print_header "Python Services:"
check_service "http://localhost:7001/health" "Vector Service" 7001

echo ""
print_header "Service Endpoints:"
check_service "http://localhost:8003/health" "Clustering API" 8003
check_service "http://localhost:9001/health" "Semantic API" 9001
check_service "http://localhost:9000/api/v1/heartbeat" "ChromaDB API" 9000

echo ""
print_header "Quick Access URLs:"
echo "  🌐 Main Application:    http://localhost:3001"
echo "  🔧 Backend API:         http://localhost:3000"
echo "  📊 Database Stats:      http://localhost:3000/api/stats/database"
echo "  🎯 Clustering Health:   http://localhost:8003/health"
echo "  🔍 Semantic Health:     http://localhost:9001/health"
echo "  📈 Vector Health:       http://localhost:7001/health"
echo "" 