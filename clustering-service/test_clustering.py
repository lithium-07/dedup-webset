#!/usr/bin/env python3
"""
Simple test script for the clustering service
"""

import asyncio
import json
from field_extractor import FieldExtractor
from clustering_engine import ClusteringEngine

# Mock test data
MOVIE_ITEMS = [
    {
        'id': '1',
        'name': 'The Dark Knight',
        'properties': {
            'movie': {
                'director': 'Christopher Nolan',
                'genre': 'Action',
                'year': 2008
            }
        }
    },
    {
        'id': '2', 
        'name': 'Inception',
        'properties': {
            'movie': {
                'director': 'Christopher Nolan',
                'genre': 'Sci-Fi',
                'year': 2010
            }
        }
    },
    {
        'id': '3',
        'name': 'The Matrix',
        'properties': {
            'movie': {
                'director': 'Wachowski Sisters',
                'genre': 'Sci-Fi', 
                'year': 1999
            }
        }
    },
    {
        'id': '4',
        'name': 'Pulp Fiction',
        'properties': {
            'movie': {
                'director': 'Quentin Tarantino',
                'genre': 'Crime',
                'year': 1994
            }
        }
    }
]

async def test_field_extraction():
    """Test field extraction functionality"""
    print("🔍 Testing Field Extraction...")
    
    extractor = FieldExtractor()
    
    # Test 1: Extract fields for director query
    print("\n--- Test 1: Director Query ---")
    extracted = extractor.extract_fields(MOVIE_ITEMS, 'movie', 'group by director')
    print(f"Extracted {len(extracted)} items")
    for item in extracted:
        print(f"  {item.get('name', 'Unknown')}: director={item.get('director', 'N/A')}")
    
    # Test 2: Analyze fields
    print("\n--- Test 2: Field Analysis ---")
    analysis = extractor.analyze_fields(MOVIE_ITEMS, 'movie')
    print(f"Detected entity type: {analysis.get('detected_entity_type')}")
    print(f"Recommended fields: {analysis.get('recommended_clustering_fields')}")
    
    return extracted

async def test_clustering():
    """Test clustering functionality"""
    print("\n🤖 Testing Clustering Engine...")
    
    # Note: This requires GOOGLE_API_KEY environment variable
    try:
        clustering_engine = ClusteringEngine()
        extractor = FieldExtractor()
        
        # Extract fields first
        extracted_items = extractor.extract_fields(MOVIE_ITEMS, 'movie', 'group by director')
        
        # Test clustering
        print("\n--- Test: Cluster by Director ---")
        clusters = await clustering_engine.cluster_items(
            extracted_items,
            'group by director',
            'movie'
        )
        
        print(f"Generated {len(clusters)} clusters:")
        for i, cluster in enumerate(clusters):
            print(f"  Cluster {i+1}: {cluster['name']} ({cluster['count']} items)")
            print(f"    Reasoning: {cluster['reasoning']}")
            for item in cluster['items']:
                print(f"    - {item.get('name', 'Unknown')}")
        
    except Exception as e:
        print(f"❌ Clustering test failed (likely missing API key): {e}")
        print("This is expected if GOOGLE_API_KEY is not set")

async def main():
    """Run all tests"""
    print("🧪 Starting Clustering Service Tests")
    print("=" * 50)
    
    try:
        # Test field extraction (doesn't require API key)
        await test_field_extraction()
        
        # Test clustering (requires API key)
        await test_clustering()
        
        print("\n✅ Tests completed!")
        
    except Exception as e:
        print(f"❌ Test failed: {e}")

if __name__ == "__main__":
    asyncio.run(main()) 