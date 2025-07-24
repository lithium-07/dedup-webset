import re
import logging
from typing import List, Dict, Any, Set, Optional
from collections import Counter

logger = logging.getLogger(__name__)

class FieldExtractor:
    """
    Intelligently extracts relevant fields from items for clustering
    """
    
    def __init__(self):
        # Predefined field mappings for different entity types
        self.entity_field_maps = {
            'movie': {
                'core_fields': ['title', 'name', 'director', 'genre', 'year', 'studio', 'cast'],
                'clustering_keywords': {
                    'director': ['director', 'directed by', 'filmmaker'],
                    'genre': ['genre', 'category', 'type', 'style'],
                    'year': ['year', 'release', 'date', 'decade'],
                    'studio': ['studio', 'production', 'distributor'],
                    'cast': ['actor', 'cast', 'star', 'starring'],
                    'rating': ['rating', 'mpaa', 'certification'],
                    'country': ['country', 'origin', 'language']
                }
            },
            'company': {
                'core_fields': ['name', 'industry', 'location', 'size', 'founded', 'type'],
                'clustering_keywords': {
                    'industry': ['industry', 'sector', 'business', 'field'],
                    'location': ['location', 'country', 'city', 'region', 'headquarters'],
                    'size': ['size', 'employees', 'revenue', 'scale'],
                    'type': ['type', 'structure', 'organization'],
                    'founded': ['founded', 'established', 'started', 'created']
                }
            },
            'book': {
                'core_fields': ['title', 'author', 'genre', 'publisher', 'year', 'isbn'],
                'clustering_keywords': {
                    'author': ['author', 'writer', 'written by'],
                    'genre': ['genre', 'category', 'fiction', 'non-fiction'],
                    'publisher': ['publisher', 'published by'],
                    'year': ['year', 'published', 'publication date']
                }
            }
        }
    
    def extract_fields(self, items: List[Dict[str, Any]], entity_type: Optional[str], query: str) -> List[Dict[str, Any]]:
        """
        Extract relevant fields from items based on entity type and clustering query
        """
        if not items:
            return []
        
        # Analyze query to determine relevant fields
        relevant_fields = self._analyze_query_for_fields(query, entity_type)
        
        # Auto-detect entity type if not provided
        if not entity_type:
            entity_type = self._detect_entity_type(items)
            logger.info(f"🔍 Auto-detected entity type: {entity_type}")
        
        # Extract fields from each item
        extracted_items = []
        for item in items:
            extracted_item = self._extract_item_fields(item, relevant_fields, entity_type)
            if extracted_item:  # Only include items with extracted data
                extracted_items.append(extracted_item)
        
        logger.info(f"✅ Extracted {len(extracted_items)} items with relevant fields: {relevant_fields}")
        return extracted_items
    
    def _analyze_query_for_fields(self, query: str, entity_type: Optional[str]) -> Set[str]:
        """
        Analyze the natural language query to determine which fields are relevant
        """
        query_lower = query.lower()
        relevant_fields = set()
        
        # Get entity-specific keywords
        entity_config = self.entity_field_maps.get(entity_type or 'movie', {})
        clustering_keywords = entity_config.get('clustering_keywords', {})
        
        # Check for direct field mentions
        for field, keywords in clustering_keywords.items():
            for keyword in keywords:
                if keyword in query_lower:
                    relevant_fields.add(field)
        
        # Add core fields based on query patterns
        if any(word in query_lower for word in ['group', 'cluster', 'organize', 'arrange']):
            # Add commonly clustered fields
            if entity_type == 'movie':
                relevant_fields.update(['director', 'genre', 'year'])
            elif entity_type == 'company':
                relevant_fields.update(['industry', 'location', 'size'])
        
        # Fallback: if no specific fields detected, use core fields
        if not relevant_fields:
            core_fields = entity_config.get('core_fields', ['name', 'title'])
            relevant_fields.update(core_fields[:3])  # Use first 3 core fields
        
        # Always include name/title for identification
        relevant_fields.add('name')
        relevant_fields.add('title')
        
        return relevant_fields
    
    def _detect_entity_type(self, items: List[Dict[str, Any]]) -> str:
        """
        Auto-detect entity type based on item properties
        """
        field_counter = Counter()
        
        # Analyze first few items to detect common fields
        sample_items = items[:min(10, len(items))]
        
        for item in sample_items:
            fields = self._get_all_fields(item)
            field_counter.update(fields)
        
        # Check for movie indicators
        movie_indicators = ['director', 'genre', 'cast', 'runtime', 'imdb', 'movie']
        if any(indicator in field_counter for indicator in movie_indicators):
            return 'movie'
        
        # Check for company indicators
        company_indicators = ['industry', 'employees', 'revenue', 'headquarters', 'ceo']
        if any(indicator in field_counter for indicator in company_indicators):
            return 'company'
        
        # Check for book indicators
        book_indicators = ['author', 'isbn', 'publisher', 'pages']
        if any(indicator in field_counter for indicator in book_indicators):
            return 'book'
        
        # Default to movie
        return 'movie'
    
    def _extract_item_fields(self, item: Dict[str, Any], relevant_fields: Set[str], entity_type: str) -> Dict[str, Any]:
        """
        Extract specific fields from a single item
        """
        extracted = {
            'id': item.get('id', ''),
            'original_item': item  # Keep reference to original for final display
        }
        
        # Get all available fields from the item
        all_fields = self._get_all_fields_with_values(item)
        
        # Extract relevant fields
        for field in relevant_fields:
            value = self._find_field_value(all_fields, field)
            if value:
                extracted[field] = value
        
        # Ensure we have at least a name/title for identification
        if not extracted.get('name') and not extracted.get('title'):
            extracted['name'] = item.get('name') or item.get('title') or 'Unknown'
        
        return extracted
    
    def _get_all_fields(self, item: Dict[str, Any]) -> List[str]:
        """
        Get all field names from an item (including nested fields)
        """
        fields = []
        
        def extract_keys(obj, prefix=''):
            if isinstance(obj, dict):
                for key, value in obj.items():
                    full_key = f"{prefix}.{key}" if prefix else key
                    fields.append(key.lower())
                    fields.append(full_key.lower())
                    if isinstance(value, dict):
                        extract_keys(value, full_key)
        
        extract_keys(item)
        return fields
    
    def _get_all_fields_with_values(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """
        Get all field names and values from an item (flattened)
        """
        fields = {}
        
        def extract_fields(obj, prefix=''):
            if isinstance(obj, dict):
                for key, value in obj.items():
                    full_key = f"{prefix}.{key}" if prefix else key
                    
                    # Store both the simple key and full path
                    if isinstance(value, (str, int, float, bool)) and value:
                        fields[key.lower()] = value
                        fields[full_key.lower()] = value
                    elif isinstance(value, dict):
                        extract_fields(value, full_key)
                    elif isinstance(value, list) and value:
                        # Handle lists by joining string elements
                        if all(isinstance(v, str) for v in value):
                            fields[key.lower()] = ', '.join(value)
                            fields[full_key.lower()] = ', '.join(value)
        
        extract_fields(item)
        return fields
    
    def _find_field_value(self, all_fields: Dict[str, Any], target_field: str) -> Any:
        """
        Find the value for a target field using fuzzy matching
        """
        target_lower = target_field.lower()
        
        # Direct match
        if target_lower in all_fields:
            return all_fields[target_lower]
        
        # Fuzzy matching for common variations
        field_variations = {
            'director': ['director', 'directed_by', 'directors'],
            'genre': ['genre', 'genres', 'category', 'categories'],
            'year': ['year', 'release_year', 'date', 'release_date'],
            'title': ['title', 'name', 'movie_title'],
            'name': ['name', 'title', 'company_name'],
            'industry': ['industry', 'sector', 'business_type'],
            'location': ['location', 'country', 'headquarters', 'address']
        }
        
        variations = field_variations.get(target_lower, [target_lower])
        
        for variation in variations:
            if variation in all_fields:
                return all_fields[variation]
            
            # Check for partial matches
            for field_key in all_fields:
                if variation in field_key or field_key in variation:
                    return all_fields[field_key]
        
        return None
    
    def analyze_fields(self, items: List[Dict[str, Any]], entity_type: Optional[str]) -> Dict[str, Any]:
        """
        Analyze fields across all items to provide insights
        """
        if not items:
            return {}
        
        all_fields = Counter()
        field_values = {}
        
        for item in items:
            fields_with_values = self._get_all_fields_with_values(item)
            all_fields.update(fields_with_values.keys())
            
            for field, value in fields_with_values.items():
                if field not in field_values:
                    field_values[field] = set()
                field_values[field].add(str(value)[:50])  # Limit value length
        
        # Get top fields
        top_fields = dict(all_fields.most_common(20))
        
        # Sample values for each field
        field_samples = {}
        for field, values in field_values.items():
            if field in top_fields:
                field_samples[field] = list(values)[:5]  # Top 5 sample values
        
        return {
            'total_items': len(items),
            'detected_entity_type': self._detect_entity_type(items),
            'top_fields': top_fields,
            'field_samples': field_samples,
            'recommended_clustering_fields': self._get_recommended_fields(top_fields, entity_type)
        }
    
    def _get_recommended_fields(self, top_fields: Dict[str, int], entity_type: Optional[str]) -> List[str]:
        """
        Recommend fields for clustering based on analysis
        """
        entity_config = self.entity_field_maps.get(entity_type or 'movie', {})
        core_fields = entity_config.get('core_fields', [])
        
        # Find intersection of core fields and available fields
        available_core_fields = [field for field in core_fields if field in top_fields]
        
        # Sort by frequency
        available_core_fields.sort(key=lambda x: top_fields.get(x, 0), reverse=True)
        
        return available_core_fields[:5]  # Top 5 recommended fields 