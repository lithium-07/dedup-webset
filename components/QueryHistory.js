import { useState, useEffect } from 'react';
import { useSnackbar } from 'notistack';
import styles from './QueryHistory.module.css';

export default function QueryHistory({ websetId = null, showStats = true }) {
  const [queries, setQueries] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all', 'clustering', 'semantic_search'
  const [expandedQuery, setExpandedQuery] = useState(null);
  const { enqueueSnackbar } = useSnackbar();

  const fetchQueries = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: '50'
      });
      
      if (websetId) params.append('websetId', websetId);
      if (filter !== 'all') params.append('queryType', filter);

      const response = await fetch(`http://localhost:3000/api/query-history?${params}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setQueries(data.queries || []);
      
    } catch (err) {
      console.error('Error fetching query history:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    if (!showStats) return;
    
    try {
      const params = websetId ? `?websetId=${websetId}` : '';
      const response = await fetch(`http://localhost:3000/api/query-history/stats${params}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setStats(data.stats);
      
    } catch (err) {
      console.error('Error fetching query stats:', err);
      // Don't set error for stats failure, just log it
    }
  };

  useEffect(() => {
    fetchQueries();
    fetchStats();
  }, [websetId, filter]);

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getQueryTypeIcon = (type) => {
    return type === 'clustering' ? '🎯' : '🔍';
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'success': return '#10b981';
      case 'error': return '#ef4444';
      case 'partial': return '#f59e0b';
      default: return '#6b7280';
    }
  };

  const toggleQueryDetails = (queryId) => {
    setExpandedQuery(expandedQuery === queryId ? null : queryId);
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading query history...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Error loading query history: {error}</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          📋 Query History {websetId ? `(Webset: ${websetId.substring(0, 8)}...)` : '(All Websets)'}
        </h2>
        
        <div className={styles.controls}>
          <select 
            value={filter} 
            onChange={(e) => setFilter(e.target.value)}
            className={styles.filterSelect}
          >
            <option value="all">All Queries</option>
            <option value="clustering">🎯 Clustering</option>
            <option value="semantic_search">🔍 Semantic Search</option>
          </select>
          
          <button 
            onClick={() => { fetchQueries(); fetchStats(); }}
            className={styles.refreshButton}
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Stats Section */}
      {showStats && stats && (
        <div className={styles.statsSection}>
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{stats.overall.totalQueries}</div>
              <div className={styles.statLabel}>Total Queries</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{(stats.overall.successRate * 100).toFixed(1)}%</div>
              <div className={styles.statLabel}>Success Rate</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{formatDuration(stats.overall.avgProcessingTime || 0)}</div>
              <div className={styles.statLabel}>Avg Time</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{stats.overall.totalClustersFound}</div>
              <div className={styles.statLabel}>Clusters Created</div>
            </div>
          </div>
          
          {/* Top Queries */}
          {stats.topQueries && stats.topQueries.length > 0 && (
            <div className={styles.topQueries}>
              <h4>🔥 Most Used Queries</h4>
              <div className={styles.topQueriesList}>
                {stats.topQueries.slice(0, 3).map((topQuery, index) => (
                  <div key={index} className={styles.topQueryItem}>
                    <span className={styles.topQueryText}>"{topQuery._id}"</span>
                    <span className={styles.topQueryCount}>({topQuery.count}x)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Queries List */}
      <div className={styles.queriesList}>
        {queries.length === 0 ? (
          <div className={styles.emptyState}>
            <p>No queries found.</p>
            <p>Start by performing a semantic search or clustering operation!</p>
          </div>
        ) : (
          queries.map((query) => (
            <div key={query.queryId} className={styles.queryItem}>
              <div className={styles.queryHeader} onClick={() => toggleQueryDetails(query.queryId)}>
                <div className={styles.queryMainInfo}>
                  <span className={styles.queryIcon}>{getQueryTypeIcon(query.queryType)}</span>
                  <div className={styles.queryTextContainer}>
                    <div className={styles.queryText}>"{query.queryText}"</div>
                    <div className={styles.queryMeta}>
                      {query.queryType === 'clustering' ? 'Clustering' : 'Semantic Search'} • {formatDate(query.createdAt)}
                    </div>
                  </div>
                </div>
                
                <div className={styles.queryStatus}>
                  <div 
                    className={styles.statusDot}
                    style={{ backgroundColor: getStatusColor(query.status) }}
                  />
                  <span className={styles.expandIcon}>
                    {expandedQuery === query.queryId ? '▼' : '▶'}
                  </span>
                </div>
              </div>

              {expandedQuery === query.queryId && (
                <div className={styles.queryDetails}>
                  <div className={styles.detailsGrid}>
                    <div className={styles.detailItem}>
                      <span className={styles.detailLabel}>Entity Type:</span>
                      <span className={styles.detailValue}>{query.entityType}</span>
                    </div>
                    
                    {query.resultsMetadata.itemsProcessed > 0 && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Items Processed:</span>
                        <span className={styles.detailValue}>{query.resultsMetadata.itemsProcessed}</span>
                      </div>
                    )}
                    
                    {query.queryType === 'clustering' && query.resultsMetadata.clustersFound > 0 && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Clusters Found:</span>
                        <span className={styles.detailValue}>{query.resultsMetadata.clustersFound}</span>
                      </div>
                    )}
                    
                    {query.queryType === 'semantic_search' && query.resultsMetadata.relevantItems >= 0 && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Relevant Items:</span>
                        <span className={styles.detailValue}>{query.resultsMetadata.relevantItems}</span>
                      </div>
                    )}
                    
                    {query.resultsMetadata.confidence > 0 && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Confidence:</span>
                        <span className={styles.detailValue}>{(query.resultsMetadata.confidence * 100).toFixed(1)}%</span>
                      </div>
                    )}
                    
                    {query.resultsMetadata.processingTimeMs > 0 && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Processing Time:</span>
                        <span className={styles.detailValue}>{formatDuration(query.resultsMetadata.processingTimeMs)}</span>
                      </div>
                    )}
                  </div>
                  
                  {query.resultsSummary && (
                    <div className={styles.resultsSummary}>
                      <span className={styles.detailLabel}>Results:</span>
                      <p className={styles.summaryText}>{query.resultsSummary}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
} 