from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import logging
import os
import json
from datetime import datetime

from clustering_engine import ClusteringEngine
from field_extractor import FieldExtractor

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Semantic Clustering Service", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure this properly in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize services
field_extractor = FieldExtractor()
clustering_engine = ClusteringEngine()

class ClusterRequest(BaseModel):
    webset_id: str
    items: List[Dict[str, Any]]
    query: str
    entity_type: Optional[str] = None

class ClusterResponse(BaseModel):
    clusters: List[Dict[str, Any]]
    processing_time_ms: int
    total_items: int
    total_clusters: int
    reasoning: str

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "clustering-service", "timestamp": datetime.now().isoformat()}

@app.post("/cluster", response_model=ClusterResponse)
async def cluster_items(request: ClusterRequest):
    """
    Cluster items based on natural language query
    """
    start_time = datetime.now()
    
    try:
        logger.info(f"🎯 CLUSTER: Processing {len(request.items)} items for webset {request.webset_id}")
        logger.info(f"🎯 CLUSTER: Query: '{request.query}', Entity type: {request.entity_type}")
        
        # Validate input
        if not request.items:
            raise HTTPException(status_code=400, detail="No items provided for clustering")
        
        if not request.query.strip():
            raise HTTPException(status_code=400, detail="Clustering query cannot be empty")
        
        # Extract relevant fields from items
        logger.info("🔍 Extracting relevant fields from items...")
        extracted_items = field_extractor.extract_fields(
            request.items, 
            request.entity_type, 
            request.query
        )
        
        logger.info(f"✅ Extracted fields from {len(extracted_items)} items")
        
        # Perform clustering
        logger.info("🤖 Performing semantic clustering...")
        clusters = await clustering_engine.cluster_items(
            extracted_items,
            request.query,
            request.entity_type
        )
        
        processing_time = int((datetime.now() - start_time).total_seconds() * 1000)
        
        logger.info(f"✅ CLUSTER: Generated {len(clusters)} clusters in {processing_time}ms")
        
        return ClusterResponse(
            clusters=clusters,
            processing_time_ms=processing_time,
            total_items=len(request.items),
            total_clusters=len(clusters),
            reasoning=f"Clustered {len(request.items)} items into {len(clusters)} groups based on: {request.query}"
        )
        
    except Exception as e:
        logger.error(f"❌ CLUSTER: Error processing request: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Clustering failed: {str(e)}")

@app.post("/extract-fields")
async def extract_fields_endpoint(request: Dict[str, Any]):
    """
    Extract and analyze fields from items (for debugging/testing)
    """
    try:
        items = request.get("items", [])
        entity_type = request.get("entity_type")
        query = request.get("query", "")
        
        extracted = field_extractor.extract_fields(items, entity_type, query)
        field_analysis = field_extractor.analyze_fields(items, entity_type)
        
        return {
            "extracted_items": extracted,
            "field_analysis": field_analysis,
            "total_items": len(items)
        }
        
    except Exception as e:
        logger.error(f"❌ EXTRACT: Error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Field extraction failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8003) 