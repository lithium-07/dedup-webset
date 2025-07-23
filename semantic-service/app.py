from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import chromadb
from chromadb.config import Settings
import google.generativeai as genai
import os
import json
from datetime import datetime
import logging
import numpy as np
from sentence_transformers import SentenceTransformer
import sys
import time

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Validate required environment variables
required_env_vars = ["GOOGLE_API_KEY", "CHROMA_HOST", "CHROMA_PORT"]
missing_vars = [var for var in required_env_vars if not os.getenv(var)]
if missing_vars:
    logger.error(f"Missing required environment variables: {', '.join(missing_vars)}")
    sys.exit(1)

# Initialize FastAPI app
app = FastAPI(title="Semantic Search Service")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Add catch-all OPTIONS handler
@app.options("/{full_path:path}")
async def options_handler(full_path: str):
    return {"message": "OK"}

# Initialize ChromaDB client with simple configuration for local server
max_retries = 5
retry_delay = 5  # seconds

for attempt in range(max_retries):
    try:
        # Use simple HttpClient for local ChromaDB without tenant configuration
        chroma_client = chromadb.HttpClient(
            host=os.getenv("CHROMA_HOST", "localhost"),
            port=int(os.getenv("CHROMA_PORT", "8000")),
            settings=Settings(anonymized_telemetry=False)
        )
        # Test connection with a simple heartbeat
        chroma_client.heartbeat()
        logger.info("Successfully connected to ChromaDB")
        break
    except Exception as e:
        if attempt < max_retries - 1:
            logger.warning(f"Failed to connect to ChromaDB (attempt {attempt + 1}/{max_retries}): {str(e)}")
            time.sleep(retry_delay)
        else:
            logger.error(f"Failed to connect to ChromaDB after {max_retries} attempts")
            sys.exit(1)

# Initialize Google Gemini
try:
    genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))
    model = genai.GenerativeModel('gemini-2.5-flash')  # Correct model name
    logger.info("Successfully initialized Gemini model")
except Exception as e:
    logger.error(f"Failed to initialize Gemini model: {str(e)}")
    sys.exit(1)

# Initialize sentence transformer
try:
    encoder = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
    logger.info("Successfully loaded sentence transformer model")
except Exception as e:
    logger.error(f"Failed to load sentence transformer model: {str(e)}")
    sys.exit(1)

class WebsetData(BaseModel):
    webset_id: str
    items: List[Dict[Any, Any]]
    metadata: Optional[Dict[str, Any]] = None

class SearchQuery(BaseModel):
    webset_id: str
    query: str
    top_k: int = 5

def prepare_item_text(item: Dict) -> str:
    """Convert an item dictionary into a searchable text representation."""
    parts = []
    
    # Add name/title
    if item.get('name'):
        parts.append(f"Name: {item['name']}")
    elif item.get('title'):
        parts.append(f"Title: {item['title']}")
        
    # Add URL
    if item.get('url'):
        parts.append(f"URL: {item['url']}")
        
    # Add properties
    if item.get('properties'):
        for key, value in item['properties'].items():
            if isinstance(value, (str, int, float, bool)):
                parts.append(f"{key}: {value}")
            elif isinstance(value, dict):
                for subkey, subvalue in value.items():
                    if isinstance(subvalue, (str, int, float, bool)):
                        parts.append(f"{key} - {subkey}: {subvalue}")
                        
    return " | ".join(parts)

@app.options("/index")
async def options_index():
    return {"message": "OK"}

@app.post("/index")
async def index_webset(data: WebsetData):
    """Index a webset's items in ChromaDB."""
    try:
        # Validate input
        if not data.items:
            raise HTTPException(status_code=400, detail="No items provided for indexing")
            
        # Create or get collection with retry
        collection = None
        for attempt in range(3):  # 3 retries
            try:
                collection = chroma_client.get_or_create_collection(
                    name=f"webset_{data.webset_id}",
                    metadata={
                        "webset_id": data.webset_id,
                        "created_at": datetime.now().isoformat(),
                        **(data.metadata or {})
                    }
                )
                break
            except Exception as e:
                if attempt == 2:  # Last attempt
                    logger.error(f"Failed to create/get collection after 3 attempts: {str(e)}")
                    raise HTTPException(status_code=500, detail="Failed to access ChromaDB collection")
                logger.warning(f"Retry {attempt + 1}/3: Failed to create/get collection: {str(e)}")
                time.sleep(1)
        
        # Prepare items for indexing
        documents = []
        metadatas = []
        ids = []
        
        for idx, item in enumerate(data.items):
            try:
                # Create searchable text
                doc_text = prepare_item_text(item)
                
                # Store original item as metadata
                metadata = {
                    "original_item": json.dumps(item),
                    "indexed_at": datetime.now().isoformat()
                }
                
                documents.append(doc_text)
                metadatas.append(metadata)
                ids.append(f"item_{idx}")
            except Exception as e:
                logger.warning(f"Skipping item {idx} due to error: {str(e)}")
                continue
                
        if not documents:
            raise HTTPException(status_code=400, detail="No valid items to index after processing")
            
        # Add items to collection with retry
        for attempt in range(3):  # 3 retries
            try:
                collection.add(
                    documents=documents,
                    metadatas=metadatas,
                    ids=ids
                )
                break
            except Exception as e:
                if attempt == 2:  # Last attempt
                    logger.error(f"Failed to add items to collection after 3 attempts: {str(e)}")
                    raise HTTPException(status_code=500, detail="Failed to index items in ChromaDB")
                logger.warning(f"Retry {attempt + 1}/3: Failed to add items: {str(e)}")
                time.sleep(1)
        
        logger.info(f"Successfully indexed {len(documents)} items for webset {data.webset_id}")
        return {"status": "success", "indexed_count": len(documents)}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error indexing webset: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.options("/search")
async def options_search():
    return {"message": "OK"}

@app.post("/search")
async def search_webset(query: SearchQuery):
    """Search a webset using natural language and return relevant items with LLM analysis."""
    try:
        # Validate input
        if not query.query.strip():
            raise HTTPException(status_code=400, detail="Empty search query")
            
        # Get collection with retry
        collection = None
        for attempt in range(3):  # 3 retries
            try:
                collection = chroma_client.get_collection(f"webset_{query.webset_id}")
                break
            except Exception as e:
                if attempt == 2:  # Last attempt
                    logger.error(f"Failed to get collection after 3 attempts: {str(e)}")
                    raise HTTPException(status_code=404, detail=f"Webset {query.webset_id} not found")
                logger.warning(f"Retry {attempt + 1}/3: Failed to get collection: {str(e)}")
                time.sleep(1)
        
        # Perform hybrid search with retry
        results = None
        for attempt in range(3):  # 3 retries
            try:
                results = collection.query(
                    query_texts=[query.query],
                    n_results=query.top_k,
                    include=["metadatas", "documents", "distances"]
                )
                break
            except Exception as e:
                if attempt == 2:  # Last attempt
                    logger.error(f"Failed to perform search after 3 retries: {str(e)}")
                    raise HTTPException(status_code=500, detail="Search operation failed")
                logger.warning(f"Retry {attempt + 1}/3: Search failed: {str(e)}")
                time.sleep(1)
        
        if not results or not results['metadatas'][0]:
            return {
                "items": [],
                "analysis": {
                    "answer": "No relevant items found",
                    "used_items": [],
                    "confidence": 0,
                    "reasoning": "The search returned no results"
                }
            }
        
        # Extract original items
        items = []
        for idx, metadata in enumerate(results['metadatas'][0]):
            try:
                item = json.loads(metadata['original_item'])
                item['_search_score'] = 1 - (results['distances'][0][idx] / max(results['distances'][0]))  # Normalize to 0-1
                items.append(item)
            except Exception as e:
                logger.warning(f"Failed to process search result {idx}: {str(e)}")
                continue
            
        # Generate LLM analysis with retry
        analysis = None
        prompt = f"""Based on the following items from a dataset, answer this question: "{query.query}"

Relevant items:
{json.dumps(items, indent=2)}

Provide your answer in the following JSON format:
{{
    "answer": "Your detailed answer here",
    "used_items": [List of indices (0-based) of items that were most relevant to your answer],
    "confidence": A number between 0 and 1 indicating your confidence in the answer,
    "reasoning": "Brief explanation of how you arrived at this answer"
}}"""

        for attempt in range(3):  # 3 retries
            try:
                print(prompt)
                print("--------------------------------")
                response = model.generate_content(prompt)
                print(response.text)
                if response.text.startswith("```json") and response.text.endswith("```"):
                    response_text = response.text.replace("```json", "").replace("```", "").strip()
                else:
                    response_text = response.text
                analysis = json.loads(response_text)
                break
            except Exception as e:
                if attempt == 2:  # Last attempt
                    logger.error(f"Failed to generate LLM analysis after 3 retries: {str(e)}")
                    analysis = {
                        "answer": "Failed to generate analysis",
                        "used_items": [],
                        "confidence": 0,
                        "reasoning": "LLM analysis failed"
                    }
                else:
                    logger.warning(f"Retry {attempt + 1}/3: LLM analysis failed: {str(e)}")
                    time.sleep(1)
        
        return {
            "items": items,
            "analysis": analysis
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error searching webset: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/collections")
async def list_collections():
    """List all indexed websets."""
    try:
        collections = chroma_client.list_collections()
        return {
            "collections": [
                {
                    "name": c.name,
                    "metadata": c.metadata,
                    "count": c.count()
                }
                for c in collections
            ]
        }
    except Exception as e:
        logger.error(f"Error listing collections: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) 