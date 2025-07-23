from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np, faiss, uvicorn, os
from sentence_transformers import SentenceTransformer
import logging
from datetime import datetime
import base64

# Configure detailed logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('vector_service.log')
    ]
)
logger = logging.getLogger(__name__)

logger.info("🚀 Starting vector service initialization...")

try:
    DIM = 384
    logger.info(f"📏 Setting vector dimension to {DIM}")
    
    logger.info("🔧 Creating FAISS index...")
    # Create base index and wrap with IDMap to support add_with_ids
    base_index = faiss.IndexHNSWFlat(DIM, 32)
    index = faiss.IndexIDMap(base_index)
    logger.info(f"✅ FAISS index created successfully: {type(index)}")
    
    # ID mapping to maintain relationship between original IDs and numeric IDs
    id_mapping = {}  # numeric_id -> original_id
    reverse_mapping = {}  # original_id -> numeric_id
    
    logger.info("🤖 Loading sentence transformer model...")
    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    
    # Test the model with a simple encoding
    test_vec = model.encode("test", normalize_embeddings=True)
    if test_vec.shape[0] != DIM:
        raise ValueError(f"Model output dimension {test_vec.shape[0]} doesn't match expected {DIM}")
    
    logger.info("✅ Sentence transformer model loaded and tested successfully")
    
except Exception as e:
    logger.error(f"❌ Initialization failed: {e}")
    raise e

logger.info("✅ Vector service initialization complete!")

class AddReq(BaseModel):
    row_id: str
    text: str
    
    class Config:
        # Validate that text is not empty
        @classmethod
        def validate_text(cls, v):
            if not v or not v.strip():
                raise ValueError("Text cannot be empty")
            return v.strip()

class QueryReq(BaseModel):
    text: str
    k: int = 3
    
    class Config:
        # Validate that text is not empty and k is reasonable
        @classmethod
        def validate_text(cls, v):
            if not v or not v.strip():
                raise ValueError("Text cannot be empty")
            return v.strip()
        
        @classmethod
        def validate_k(cls, v):
            if v < 1:
                raise ValueError("k must be at least 1")
            if v > 1000:  # Reasonable upper limit
                raise ValueError("k cannot exceed 1000")
            return v

app = FastAPI()

@app.get("/health")
def health_check():
    logger.info("🏥 Health check requested")
    try:
        # Test if index is accessible
        index_size = index.ntotal
        
        # Test if model is accessible
        test_vec = model.encode("health check", normalize_embeddings=True)
        
        return {
            "status": "healthy",
            "service": "vector-service",
            "faiss_version": faiss.__version__ if hasattr(faiss, '__version__') else "unknown",
            "index_size": index_size,
            "id_mappings_count": len(id_mapping),
            "model_dimension": test_vec.shape[0],
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"❌ Health check failed: {e}")
        return {
            "status": "unhealthy",
            "error": str(e),
            "timestamp": datetime.now().isoformat()
        }

@app.get("/status")
def status():
    """Detailed status endpoint"""
    logger.info("📊 Status check requested")
    try:
        return {
            "service": "vector-service",
            "index_type": str(type(index)),
            "index_size": index.ntotal,
            "id_mappings_count": len(id_mapping),
            "model_info": {
                "name": "sentence-transformers/all-MiniLM-L6-v2",
                "dimension": DIM
            },
            "memory_usage": {
                "id_mapping_size": len(id_mapping),
                "reverse_mapping_size": len(reverse_mapping)
            },
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        logger.error(f"❌ Status check failed: {e}")
        return {"error": str(e)}

@app.post("/add")
def add(req: AddReq):
    logger.info(f"📥 ADD request received: row_id={req.row_id}, text='{req.text[:50]}...'")
    try:
        start_time = datetime.now()
        
        # Validate input
        if not req.row_id or not req.row_id.strip():
            return {"ok": False, "error": "row_id cannot be empty"}
        
        if not req.text or not req.text.strip():
            return {"ok": False, "error": "text cannot be empty"}
        
        # Check if ID already exists
        if req.row_id in reverse_mapping:
            logger.warning(f"⚠️ ID {req.row_id} already exists in index")
            return {"ok": False, "error": f"ID {req.row_id} already exists in index"}
        
        logger.info("🔢 Encoding text to vector...")
        vec = model.encode(req.text, normalize_embeddings=True)
        logger.info(f"✅ Text encoded to vector shape: {vec.shape}")
        
        # Validate vector shape
        if vec.shape[0] != DIM:
            logger.error(f"❌ Vector dimension mismatch: expected {DIM}, got {vec.shape[0]}")
            return {"ok": False, "error": f"Vector dimension mismatch: expected {DIM}, got {vec.shape[0]}"}
        
        logger.info("💾 Adding vector to FAISS index...")
        # Use hash function to convert any string to a numeric ID
        numeric_id = hash(req.row_id) & 0x7fffffff  # Ensure positive 32-bit integer
        logger.info(f"🔑 Using numeric ID: {numeric_id} for original ID: {req.row_id}")
        
        # Check for hash collision
        if numeric_id in id_mapping and id_mapping[numeric_id] != req.row_id:
            logger.warning(f"⚠️ Hash collision detected for ID {req.row_id}")
            # Generate a new ID by adding a suffix
            numeric_id = (hash(req.row_id + "_collision") & 0x7fffffff)
            logger.info(f"🔑 Using collision-resolved numeric ID: {numeric_id}")
        
        # Store the mapping
        id_mapping[numeric_id] = req.row_id
        reverse_mapping[req.row_id] = numeric_id
        
        index.add_with_ids(vec.reshape(1, -1), np.array([numeric_id]))
        
        elapsed = (datetime.now() - start_time).total_seconds() * 1000
        logger.info(f"✅ Successfully added to index in {elapsed:.2f}ms. Total items: {index.ntotal}")
        
        return {"ok": True, "total_items": index.ntotal}
        
    except Exception as e:
        logger.error(f"❌ Error in add endpoint: {e}")
        return {"ok": False, "error": str(e)}

@app.post("/query")
def query(req: QueryReq):
    logger.info(f"🔍 QUERY request received: text='{req.text[:50]}...', k={req.k}")
    try:
        start_time = datetime.now()
        
        # Validate input
        if not req.text or not req.text.strip():
            return {"ids": [], "error": "text cannot be empty"}
        
        if req.k < 1:
            return {"ids": [], "error": "k must be at least 1"}
        
        if req.k > 1000:
            return {"ids": [], "error": "k cannot exceed 1000"}
        
        if index.ntotal == 0:
            logger.info("⚠️ Index is empty, returning no results")
            return {"ids": [], "total_items": 0}
        
        logger.info(f"🔢 Encoding query text... (index has {index.ntotal} items)")
        vec = model.encode(req.text, normalize_embeddings=True)
        logger.info(f"✅ Query encoded to vector shape: {vec.shape}")
        
        # Validate vector shape
        if vec.shape[0] != DIM:
            logger.error(f"❌ Vector dimension mismatch: expected {DIM}, got {vec.shape[0]}")
            return {"ids": [], "error": f"Vector dimension mismatch: expected {DIM}, got {vec.shape[0]}"}
        
        # Ensure k doesn't exceed available items
        actual_k = min(req.k, index.ntotal)
        if actual_k != req.k:
            logger.info(f"⚠️ Requested k={req.k} but only {index.ntotal} items available, using k={actual_k}")
        
        logger.info(f"🔍 Searching FAISS index for top {actual_k} results...")
        D, I = index.search(vec.reshape(1, -1), actual_k)
        logger.info(f"📊 Search results - Distances: {D[0]}, Indices: {I[0]}")
        
        # Convert numeric IDs back to original format using our mapping
        ids = []
        distances = []
        for i, numeric_id in enumerate(I[0]):
            if numeric_id != -1:
                try:
                    original_id = id_mapping.get(int(numeric_id), str(int(numeric_id)))
                    ids.append(original_id)
                    distances.append(float(D[0][i]))
                except (ValueError, TypeError) as e:
                    logger.warning(f"⚠️ Error processing numeric_id {numeric_id}: {e}")
                    # Skip this result if there's an error processing it
                    continue
        
        elapsed = (datetime.now() - start_time).total_seconds() * 1000
        logger.info(f"✅ Query completed in {elapsed:.2f}ms. Found {len(ids)} results: {ids}")
        
        return {"ids": ids, "distances": distances, "total_items": index.ntotal}
        
    except Exception as e:
        logger.error(f"❌ Error in query endpoint: {e}")
        return {"ids": [], "error": str(e)}

if __name__ == "__main__":
    try:
        port = int(os.getenv("VEC_PORT", 7001))
        if port < 1 or port > 65535:
            raise ValueError(f"Invalid port number: {port}")
            
        logger.info(f"🌐 Starting FastAPI server on 0.0.0.0:{port}")
        logger.info(f"📊 Service endpoints available:")
        logger.info(f"   • GET  /health  - Health check")
        logger.info(f"   • GET  /status  - Detailed status")
        logger.info(f"   • POST /add     - Add vector to index")
        logger.info(f"   • POST /query   - Search similar vectors")
        
        uvicorn.run(
            app, 
            host="0.0.0.0", 
            port=port,
            log_level="info",
            access_log=True
        )
    except KeyboardInterrupt:
        logger.info("🛑 Server stopped by user")
    except Exception as e:
        logger.error(f"❌ Failed to start server: {e}")
        raise e
