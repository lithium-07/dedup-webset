import json
import logging
import asyncio
from typing import List, Dict, Any, Optional
from google.generativeai import GenerativeModel
import google.generativeai as genai
import os
from datetime import datetime

logger = logging.getLogger(__name__)

class ClusteringEngine:
    """
    Core engine for semantic clustering using LLM
    """
    
    def __init__(self):
        # Configure Gemini API
        api_key = os.getenv('GOOGLE_API_KEY')
        if not api_key:
            raise ValueError("GOOGLE_API_KEY environment variable is required")
        
        genai.configure(api_key=api_key)
        self.model = GenerativeModel('gemini-2.5-flash')
        
        # Clustering configuration
        self.max_items_per_batch = 50  # Process in batches to avoid token limits
        self.max_clusters = 20  # Maximum clusters to generate
    
    async def cluster_items(self, items: List[Dict[str, Any]], query: str, entity_type: Optional[str]) -> List[Dict[str, Any]]:
        """
        Cluster items based on natural language query
        """
        if not items:
            return []
        
        logger.info(f"🤖 CLUSTERING: Processing {len(items)} items with query: '{query}'")
        
        # Process in batches if needed
        if len(items) <= self.max_items_per_batch:
            return await self._cluster_batch(items, query, entity_type)
        else:
            return await self._cluster_large_dataset(items, query, entity_type)
    
    async def _cluster_batch(self, items: List[Dict[str, Any]], query: str, entity_type: Optional[str]) -> List[Dict[str, Any]]:
        """
        Cluster a single batch of items
        """
        try:
            # Build clustering prompt
            prompt = self._build_clustering_prompt(items, query, entity_type)
            
            logger.info(f"🤖 Sending clustering request to LLM for {len(items)} items")
            
            # Call LLM
            response = await asyncio.to_thread(
                self.model.generate_content, 
                prompt
            )
            
            # Parse response
            clusters = self._parse_clustering_response(response.text, items)
            
            logger.info(f"✅ Generated {len(clusters)} clusters")
            return clusters
            
        except Exception as e:
            logger.error(f"❌ Clustering failed: {str(e)}")
            # Fallback: create single cluster with all items
            return self._create_fallback_cluster(items, f"Clustering failed: {str(e)}")
    
    async def _cluster_large_dataset(self, items: List[Dict[str, Any]], query: str, entity_type: Optional[str]) -> List[Dict[str, Any]]:
        """
        Handle large datasets by clustering in multiple passes
        """
        logger.info(f"🔄 Large dataset detected ({len(items)} items), using multi-pass clustering")
        
        # First pass: Create initial clusters in batches
        initial_clusters = []
        batch_size = self.max_items_per_batch
        
        for i in range(0, len(items), batch_size):
            batch = items[i:i + batch_size]
            batch_clusters = await self._cluster_batch(batch, query, entity_type)
            initial_clusters.extend(batch_clusters)
        
        # Second pass: Merge similar clusters if we have too many
        if len(initial_clusters) > self.max_clusters:
            initial_clusters = await self._merge_similar_clusters(initial_clusters, query, entity_type)
        
        return initial_clusters
    
    def _build_clustering_prompt(self, items: List[Dict[str, Any]], query: str, entity_type: Optional[str]) -> str:
        """
        Build the LLM prompt for clustering
        """
        # Prepare item data for the prompt (only relevant fields)
        item_data = []
        for i, item in enumerate(items):
            # Remove original_item to reduce prompt size
            clean_item = {k: v for k, v in item.items() if k != 'original_item'}
            clean_item['index'] = i  # Add index for reference
            item_data.append(clean_item)
        
        entity_examples = self._get_entity_specific_examples(entity_type)
        
        prompt = f"""You are an expert at semantic clustering. Your task is to group items based on the user's request.

USER REQUEST: "{query}"
ENTITY TYPE: {entity_type or 'unknown'}
ITEMS TO CLUSTER: {len(items)}

{entity_examples}

ITEMS DATA:
{json.dumps(item_data, indent=2)}

INSTRUCTIONS:
1. Analyze the user's request to understand the clustering criteria
2. Group items that share the specified characteristic
3. Create meaningful cluster names that describe the grouping
4. Provide a brief reasoning for each cluster
5. Each item should belong to exactly one cluster
6. Aim for 2-8 clusters (avoid too many small clusters)

RESPONSE FORMAT (JSON):
{{
  "clusters": [
    {{
      "name": "Descriptive Cluster Name",
      "reasoning": "Why these items belong together",
      "item_indices": [0, 1, 5, 8]
    }},
    {{
      "name": "Another Cluster Name", 
      "reasoning": "Reasoning for this grouping",
      "item_indices": [2, 3, 4]
    }}
  ]
}}

Respond with valid JSON only."""
        
        return prompt
    
    def _get_entity_specific_examples(self, entity_type: Optional[str]) -> str:
        """
        Get entity-specific clustering examples and guidelines
        """
        examples = {
            'movie': """
MOVIE CLUSTERING EXAMPLES:
- "group by director" → Cluster movies by their director
- "same genre" → Group movies with similar genres
- "by decade" → Group by release decade (1990s, 2000s, etc.)
- "same franchise" → Group movies from same series/franchise
- "by rating" → Group by MPAA rating (PG, PG-13, R, etc.)
""",
            'company': """
COMPANY CLUSTERING EXAMPLES:
- "same industry" → Group companies in similar business sectors
- "by location" → Group companies from the same country/region
- "by size" → Group by company size (startup, small, large, enterprise)
- "tech companies" → Group technology-focused companies
- "by founding era" → Group by when companies were established
""",
            'book': """
BOOK CLUSTERING EXAMPLES:
- "by author" → Group books by the same author
- "same genre" → Group books with similar genres
- "by publisher" → Group books from the same publisher
- "by publication decade" → Group by when books were published
"""
        }
        
        return examples.get(entity_type or 'movie', examples['movie'])
    
    def _parse_clustering_response(self, response_text: str, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Parse LLM response and create cluster objects
        """
        try:
            # Clean the response text (remove markdown formatting if present)
            clean_response = response_text.strip()
            if clean_response.startswith('```json'):
                clean_response = clean_response[7:]
            if clean_response.endswith('```'):
                clean_response = clean_response[:-3]
            clean_response = clean_response.strip()
            
            # Parse JSON
            response_data = json.loads(clean_response)
            clusters_data = response_data.get('clusters', [])
            
            # Build final clusters with original items
            final_clusters = []
            used_indices = set()
            
            for cluster_data in clusters_data:
                cluster_name = cluster_data.get('name', 'Unnamed Cluster')
                reasoning = cluster_data.get('reasoning', 'No reasoning provided')
                item_indices = cluster_data.get('item_indices', [])
                
                # Get items for this cluster
                cluster_items = []
                for idx in item_indices:
                    if 0 <= idx < len(items) and idx not in used_indices:
                        original_item = items[idx].get('original_item', items[idx])
                        cluster_items.append(original_item)
                        used_indices.add(idx)
                
                if cluster_items:  # Only add clusters with items
                    final_clusters.append({
                        'name': cluster_name,
                        'reasoning': reasoning,
                        'items': cluster_items,
                        'count': len(cluster_items)
                    })
            
            # Handle unclustered items
            unclustered_items = []
            for i, item in enumerate(items):
                if i not in used_indices:
                    original_item = item.get('original_item', item)
                    unclustered_items.append(original_item)
            
            if unclustered_items:
                final_clusters.append({
                    'name': 'Other Items',
                    'reasoning': 'Items that did not fit into other clusters',
                    'items': unclustered_items,
                    'count': len(unclustered_items)
                })
            
            return final_clusters
            
        except json.JSONDecodeError as e:
            logger.error(f"❌ Failed to parse clustering response as JSON: {e}")
            logger.error(f"Response text: {response_text}")
            return self._create_fallback_cluster(items, "Failed to parse clustering response")
        except Exception as e:
            logger.error(f"❌ Error parsing clustering response: {e}")
            return self._create_fallback_cluster(items, f"Parsing error: {str(e)}")
    
    async def _merge_similar_clusters(self, clusters: List[Dict[str, Any]], query: str, entity_type: Optional[str]) -> List[Dict[str, Any]]:
        """
        Merge similar clusters when there are too many
        """
        logger.info(f"🔄 Merging {len(clusters)} clusters down to maximum of {self.max_clusters}")
        
        # Simple merging strategy: combine clusters with similar names
        # In production, you might want more sophisticated merging
        
        merged_clusters = []
        processed_indices = set()
        
        for i, cluster in enumerate(clusters):
            if i in processed_indices:
                continue
            
            current_cluster = {
                'name': cluster['name'],
                'reasoning': cluster['reasoning'], 
                'items': cluster['items'].copy(),
                'count': cluster['count']
            }
            
            # Look for similar clusters to merge
            for j, other_cluster in enumerate(clusters[i+1:], i+1):
                if j in processed_indices:
                    continue
                
                # Simple similarity check based on name
                if self._are_clusters_similar(cluster['name'], other_cluster['name']):
                    current_cluster['items'].extend(other_cluster['items'])
                    current_cluster['count'] += other_cluster['count']
                    current_cluster['reasoning'] += f" | Merged with: {other_cluster['reasoning']}"
                    processed_indices.add(j)
            
            processed_indices.add(i)
            merged_clusters.append(current_cluster)
            
            if len(merged_clusters) >= self.max_clusters:
                break
        
        # Add remaining items to last cluster if needed
        if len(processed_indices) < len(clusters):
            remaining_items = []
            for i, cluster in enumerate(clusters):
                if i not in processed_indices:
                    remaining_items.extend(cluster['items'])
            
            if remaining_items and merged_clusters:
                merged_clusters[-1]['items'].extend(remaining_items)
                merged_clusters[-1]['count'] += len(remaining_items)
        
        logger.info(f"✅ Merged down to {len(merged_clusters)} clusters")
        return merged_clusters
    
    def _are_clusters_similar(self, name1: str, name2: str) -> bool:
        """
        Simple similarity check for cluster names
        """
        name1_words = set(name1.lower().split())
        name2_words = set(name2.lower().split())
        
        # Check for common words
        common_words = name1_words.intersection(name2_words)
        total_words = name1_words.union(name2_words)
        
        if not total_words:
            return False
        
        similarity = len(common_words) / len(total_words)
        return similarity > 0.4  # 40% similarity threshold
    
    def _create_fallback_cluster(self, items: List[Dict[str, Any]], reason: str) -> List[Dict[str, Any]]:
        """
        Create a single cluster containing all items (fallback strategy)
        """
        original_items = []
        for item in items:
            original_item = item.get('original_item', item)
            original_items.append(original_item)
        
        return [{
            'name': 'All Items',
            'reasoning': f'Fallback cluster: {reason}',
            'items': original_items,
            'count': len(original_items)
        }] 