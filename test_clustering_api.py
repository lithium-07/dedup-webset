#!/usr/bin/env python3
"""
Test the clustering service API with real HTTP requests
"""

import requests
import json

# Test data - movies
test_movies = [
    {
        "id": "1",
        "name": "The Dark Knight",
        "properties": {
            "movie": {
                "director": "Christopher Nolan",
                "genre": "Action",
                "year": 2008
            }
        }
    },
    {
        "id": "2", 
        "name": "Inception",
        "properties": {
            "movie": {
                "director": "Christopher Nolan",
                "genre": "Sci-Fi",
                "year": 2010
            }
        }
    },
    {
        "id": "3",
        "name": "Interstellar",
        "properties": {
            "movie": {
                "director": "Christopher Nolan",
                "genre": "Sci-Fi",
                "year": 2014
            }
        }
    },
    {
        "id": "4",
        "name": "The Matrix",
        "properties": {
            "movie": {
                "director": "Wachowski Sisters",
                "genre": "Sci-Fi", 
                "year": 1999
            }
        }
    },
    {
        "id": "5",
        "name": "Pulp Fiction",
        "properties": {
            "movie": {
                "director": "Quentin Tarantino",
                "genre": "Crime",
                "year": 1994
            }
        }
    },
    {
        "id": "6",
        "name": "Kill Bill",
        "properties": {
            "movie": {
                "director": "Quentin Tarantino",
                "genre": "Action",
                "year": 2003
            }
        }
    }
]

def test_health():
    """Test health endpoint"""
    print("🔍 Testing health endpoint...")
    try:
        response = requests.get("http://localhost:8003/health")
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Health check passed: {data['status']}")
            return True
        else:
            print(f"❌ Health check failed: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Health check error: {e}")
        return False

def test_field_extraction():
    """Test field extraction endpoint"""
    print("\n🔍 Testing field extraction...")
    try:
        payload = {
            "items": test_movies,
            "entity_type": "movie",
            "query": "group by director"
        }
        
        response = requests.post(
            "http://localhost:8003/extract-fields",
            json=payload,
            headers={"Content-Type": "application/json"}
        )
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Field extraction successful:")
            print(f"   - Detected entity type: {data['field_analysis']['detected_entity_type']}")
            print(f"   - Recommended fields: {data['field_analysis']['recommended_clustering_fields']}")
            print(f"   - Extracted {len(data['extracted_items'])} items")
            
            # Show sample extracted data
            for item in data['extracted_items'][:3]:
                name = item.get('name', 'Unknown')
                director = item.get('director', 'N/A')
                print(f"   - {name}: director={director}")
            
            return True
        else:
            print(f"❌ Field extraction failed: {response.status_code}")
            print(response.text)
            return False
            
    except Exception as e:
        print(f"❌ Field extraction error: {e}")
        return False

def test_clustering():
    """Test clustering endpoint"""
    print("\n🤖 Testing clustering endpoint...")
    
    # Test different queries
    test_queries = [
        "group by director",
        "cluster by genre", 
        "same decade"
    ]
    
    for query in test_queries:
        print(f"\n--- Testing query: '{query}' ---")
        try:
            payload = {
                "webset_id": "test_webset",
                "items": test_movies,
                "query": query,
                "entity_type": "movie"
            }
            
            response = requests.post(
                "http://localhost:8003/cluster",
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=30  # Give it time for LLM processing
            )
            
            if response.status_code == 200:
                data = response.json()
                print(f"✅ Clustering successful:")
                print(f"   - Processing time: {data['processing_time_ms']}ms")
                print(f"   - Generated {data['total_clusters']} clusters from {data['total_items']} items")
                
                # Show clusters
                for i, cluster in enumerate(data['clusters']):
                    print(f"   📁 Cluster {i+1}: {cluster['name']} ({cluster['count']} items)")
                    print(f"      Reasoning: {cluster['reasoning']}")
                    for item in cluster['items'][:3]:  # Show first 3 items
                        print(f"      - {item.get('name', 'Unknown')}")
                    if cluster['count'] > 3:
                        print(f"      - ... and {cluster['count'] - 3} more items")
                print()
                
            else:
                print(f"❌ Clustering failed: {response.status_code}")
                print(response.text)
                
        except requests.exceptions.Timeout:
            print(f"⏱️ Clustering timed out (this might happen without API key)")
        except Exception as e:
            print(f"❌ Clustering error: {e}")

def main():
    """Run all tests"""
    print("🧪 Testing Clustering Service API")
    print("=" * 50)
    
    # Test 1: Health check
    if not test_health():
        print("❌ Service is not healthy, stopping tests")
        return
    
    # Test 2: Field extraction (doesn't need API key)
    test_field_extraction()
    
    # Test 3: Clustering (needs API key)
    print("\n" + "=" * 50)
    print("📝 Note: Clustering tests require GOOGLE_API_KEY environment variable")
    print("If you see timeouts or API errors, this is expected without the API key")
    print("=" * 50)
    
    test_clustering()
    
    print("\n✅ API testing completed!")
    print("\n💡 Next steps:")
    print("   1. Set GOOGLE_API_KEY environment variable for full clustering")
    print("   2. Start your main application and test the UI integration")
    print("   3. Try the '🎯 Semantic Clustering' button in the results table")

if __name__ == "__main__":
    main() 