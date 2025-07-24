import { useState } from 'react';
import { useSnackbar } from 'notistack';
import styles from './SemanticSearch.module.css';

export default function SemanticSearch({ websetId, items }) {
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isIndexed, setIsIndexed] = useState(false);
  const { enqueueSnackbar } = useSnackbar();

  const indexWebset = async () => {
    if (!items || items.length === 0) {
      enqueueSnackbar('No items to index', { variant: 'warning' });
      return;
    }

    setIsIndexing(true);
    try {
      const response = await fetch('http://localhost:3000/api/semantic/index', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webset_id: websetId,
          items: items,
          metadata: {
            indexed_at: new Date().toISOString(),
            item_count: items.length
          }
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setIsIndexed(true);
      enqueueSnackbar(`Successfully indexed ${data.indexed_count} items`, { variant: 'success' });
    } catch (error) {
      console.error('Error indexing webset:', error);
      enqueueSnackbar(`Failed to index webset: ${error.message}`, { variant: 'error' });
    } finally {
      setIsIndexing(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) {
      enqueueSnackbar('Please enter a search query', { variant: 'warning' });
      return;
    }

    setIsSearching(true);
    try {
      const response = await fetch('http://localhost:3000/api/semantic/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          webset_id: websetId,
          query: query.trim(),
          top_k: 5
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setSearchResults(data);

      // Save query to history
      try {
        await fetch('http://localhost:3000/api/query-history', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            websetId,
            queryType: 'semantic_search',
            queryText: query.trim(),
            entityType: 'unknown', // Could be improved by detecting from items
            resultsMetadata: {
              itemsProcessed: items.length,
              relevantItems: data.relevant_items?.length || 0,
              confidence: data.analysis?.confidence || 0,
              processingTimeMs: 0 // Could track this if we measure it
            },
            resultsSummary: data.analysis?.answer ? 
              `Found ${data.relevant_items?.length || 0} relevant items. ${data.analysis.answer.substring(0, 100)}...` :
              `Search completed with ${data.relevant_items?.length || 0} results`
          })
        });
        console.log('📝 Semantic search query saved to history');
      } catch (historyError) {
        console.warn('Failed to save semantic search query to history:', historyError);
        // Don't fail the main operation if history saving fails
      }
    } catch (error) {
      console.error('Error searching:', error);
      enqueueSnackbar(`Search failed: ${error.message}`, { variant: 'error' });
    } finally {
      setIsSearching(false);
    }
  };

  const renderHighlightedItems = () => {
    if (!searchResults?.items || !searchResults?.analysis?.used_items) return null;

    return searchResults.items.map((item, index) => {
      const isUsed = searchResults.analysis.used_items.includes(index);
      const score = (item._search_score * 100).toFixed(1);

      return (
        <div 
          key={index}
          className={`${styles.resultItem} ${isUsed ? styles.usedItem : ''}`}
        >
          <div className={styles.itemHeader}>
            <span className={styles.itemTitle}>
              {item.name || item.title || 'Untitled'}
            </span>
            <span className={styles.itemScore}>
              {score}% match
              {isUsed && <span className={styles.usedBadge}>Used in answer</span>}
            </span>
          </div>
          {item.url && (
            <a href={item.url} target="_blank" rel="noopener noreferrer" className={styles.itemUrl}>
              {item.url}
            </a>
          )}
          <div className={styles.itemProperties}>
            {Object.entries(item.properties || {}).map(([key, value]) => (
              <div key={key} className={styles.property}>
                <strong>{key}:</strong> {JSON.stringify(value)}
              </div>
            ))}
          </div>
        </div>
      );
    });
  };

  return (
    <div className={styles.container}>
      {!isIndexed ? (
        <div className={styles.indexPrompt}>
          <p>Index this webset to enable semantic search</p>
          <button 
            onClick={indexWebset} 
            disabled={isIndexing}
            className={styles.indexButton}
          >
            {isIndexing ? 'Indexing...' : 'Index Webset'}
          </button>
        </div>
      ) : (
        <>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask a question about your data..."
              className={styles.searchInput}
              disabled={isSearching}
            />
            <button 
              type="submit" 
              disabled={isSearching}
              className={styles.searchButton}
            >
              {isSearching ? 'Searching...' : 'Search'}
            </button>
          </form>

          {searchResults && (
            <div className={styles.results}>
              <div className={styles.analysis}>
                <h3>Analysis</h3>
                <p className={styles.answer}>{searchResults.analysis.answer}</p>
                <div className={styles.meta}>
                  <span className={styles.confidence}>
                    Confidence: {(searchResults.analysis.confidence * 100).toFixed(1)}%
                  </span>
                  <p className={styles.reasoning}>{searchResults.analysis.reasoning}</p>
                </div>
              </div>

              <div className={styles.relevantItems}>
                <h3>Relevant Items</h3>
                {renderHighlightedItems()}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
} 