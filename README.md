# Exa Dedupe - Intelligent Web Data Deduplication & Semantic Clustering

A powerful system for collecting, deduplicating, and semantically clustering web data using advanced AI techniques.

## 🚀 Features

### Core Capabilities
- **🔍 Web Data Collection**: Fetch and process web data using Exa API
- **🧠 AI-Powered Deduplication**: Advanced duplicate detection using LLMs and vector similarity
- **🎯 Semantic Clustering**: Group deduplicated data using natural language queries
- **📊 Real-time Streaming**: Live updates as data is processed
- **💾 Persistent Storage**: MongoDB for reliable data persistence

### New: Semantic Clustering 🎯
After deduplication, you can now cluster results semantically:
- **Natural Language Queries**: `"group movies by same director"`, `"cluster companies in similar industries"`
- **Smart Field Extraction**: Automatically identifies relevant fields for clustering
- **Multiple Entity Types**: Movies, companies, books, and more
- **Intelligent Grouping**: LLM-powered clustering with reasoning

## 🏗️ Architecture

```
exa_dedupe/
├── frontend/             # Next.js React application
├── backend/             # Node.js Express API server  
├── semantic-service/    # Python FastAPI for semantic search
├── vector-service/      # Python FastAPI for vector operations
├── clustering-service/  # Python FastAPI for semantic clustering (NEW)
├── docker-compose.yml   # Multi-service orchestration
└── setup.sh            # One-command startup script (NEW)
```

## 🎬 Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js & npm
- Python with Conda
- Exa API key
- Google API key (for clustering)

### 1. One-Command Setup
```bash
# Clone and setup
git clone <repository>
cd exa_dedupe

# Set environment variables
export EXA_API_KEY=your_exa_api_key_here
export GOOGLE_API_KEY=your_google_api_key_here

# Start everything with one command!
./setup.sh
```

The setup script will:
- ✅ Install all dependencies
- ✅ Create conda environment for vector service
- ✅ Start all Docker services
- ✅ Launch frontend and backend
- ✅ Verify all services are healthy

### 2. Access the Application
- **Main App**: http://localhost:3001
- **API**: http://localhost:3000
- **Service Status**: `./status.sh`

### 3. Test Semantic Clustering
1. Create a webset (e.g., "Christopher Nolan movies")
2. Wait for deduplication to complete
3. Click **🎯 Semantic Clustering**
4. Try queries like:
   - `"group by director"`
   - `"cluster by genre"` 
   - `"movies from same decade"`

## 🛠️ Management Commands

```bash
# Start all services
./setup.sh

# Check service status  
./status.sh

# Stop all services
./stop.sh

# View logs
docker-compose logs -f

# Restart specific service
docker-compose restart clustering-service
```

## 🧪 Manual Development Setup

If you prefer manual control:

### 1. Start Core Services
```bash
docker-compose up -d mongodb chromadb semantic_search clustering-service
```

### 2. Start Vector Service
```bash
cd vector-service
conda activate vector-service  # or create environment
pip install -r requirements.txt
python app.py
```

### 3. Start Application
```bash
# In project root
npm install
npm run dev  # Starts both backend and frontend
```

## 🔧 Service Details

| Service | Port | Description |
|---------|------|-------------|
| Frontend | 3001 | Next.js React UI |
| Backend | 3000 | Node.js API server |
| MongoDB | 27017 | Data persistence |
| ChromaDB | 9000 | Vector database |
| Vector Service | 7001 | Embeddings & similarity |
| Clustering | 8003 | Semantic clustering |
| Semantic Search | 9001 | Advanced search |

## 🎯 Semantic Clustering Examples

### Movies
- `"group by director"` → Christopher Nolan Films, Quentin Tarantino Films
- `"cluster by genre"` → Action Movies, Sci-Fi Films, Crime Dramas  
- `"same decade"` → 1990s Movies, 2000s Movies, 2010s Movies

### Companies  
- `"same industry"` → Tech Companies, Healthcare, Finance
- `"by location"` → US Companies, European Companies
- `"cluster by size"` → Startups, SMEs, Enterprise

### Books
- `"by author"` → Stephen King Books, J.K. Rowling Books
- `"same genre"` → Fantasy Novels, Mystery Books
- `"by publisher"` → Penguin Books, Random House

## 🐛 Troubleshooting

### Port Conflicts
```bash
# Check what's using ports
./status.sh

# Force stop everything
./stop.sh
```

### Service Issues
```bash
# Check logs
docker-compose logs clustering-service
docker-compose logs semantic_search

# Restart specific service
docker-compose restart <service-name>
```

### Dependencies
```bash
# Reinstall Node dependencies
rm -rf node_modules backend/node_modules
npm install
cd backend && npm install

# Recreate conda environment
conda env remove -n vector-service
conda create -n vector-service python=3.11 -y
```

## 📊 Monitoring

- **Service Health**: `./status.sh`
- **Database Stats**: http://localhost:3000/api/stats/database
- **Vector Stats**: http://localhost:7001/stats
- **Clustering Health**: http://localhost:8003/health

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Test with `./setup.sh`
4. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

---

**🎉 Ready to deduplicate and cluster your data intelligently!** 