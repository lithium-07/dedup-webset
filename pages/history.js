import { useState, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { SnackbarProvider, useSnackbar } from 'notistack';
import styles from '../styles/History.module.css';

function HistoryContent() {
  const [websets, setWebsets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedWebset, setSelectedWebset] = useState(null);
  const [websetDetails, setWebsetDetails] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const { enqueueSnackbar } = useSnackbar();

  useEffect(() => {
    fetchWebsets();
  }, []);

  const fetchWebsets = async () => {
    setLoading(true);
    try {
      const response = await fetch('http://localhost:3000/api/history/websets?limit=50');
      const data = await response.json();
      
      if (data.success) {
        setWebsets(data.websets);
      } else {
        setError(data.error || 'Failed to fetch websets');
      }
    } catch (err) {
      setError('Error connecting to server');
      console.error('Error fetching websets:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchWebsetDetails = async (websetId) => {
    setLoadingDetails(true);
    try {
      const response = await fetch(`http://localhost:3000/api/history/websets/${websetId}`);
      const data = await response.json();
      
      if (data.success) {
        setWebsetDetails(data);
        setSelectedWebset(websetId);
      } else {
        enqueueSnackbar(`Failed to load webset details: ${data.error}`, { variant: 'error' });
      }
    } catch (err) {
      enqueueSnackbar('Error loading webset details', { variant: 'error' });
      console.error('Error fetching webset details:', err);
    } finally {
      setLoadingDetails(false);
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const formatDuration = (createdAt, completedAt) => {
    if (!completedAt) return 'In progress';
    
    const start = new Date(createdAt);
    const end = new Date(completedAt);
    const durationMs = end - start;
    
    if (durationMs < 1000) return `${durationMs}ms`;
    if (durationMs < 60000) return `${Math.round(durationMs / 1000)}s`;
    return `${Math.round(durationMs / 60000)}m`;
  };

  const calculateDeduplicationRate = (webset) => {
    if (webset.totalItems === 0) return 0;
    return Math.round((webset.duplicatesRejected / webset.totalItems) * 100);
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>
          <div className={styles.spinner}></div>
          <p>Loading history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <h2>Error Loading History</h2>
          <p>{error}</p>
          <button onClick={fetchWebsets} className={styles.retryButton}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Query History</h1>
      </div>

      {websets.length === 0 ? (
        <div className={styles.emptyState}>
          <h2>No History Yet</h2>
          <p>Your completed webset queries will appear here.</p>
          <Link href="/" className={styles.startButton}>
            Start Your First Query
          </Link>
        </div>
      ) : (
        <div className={styles.content}>
          <div className={styles.websetList}>
            <h2>Recent Queries ({websets.length})</h2>
            
            {websets.map((webset) => (
              <div 
                key={webset.websetId}
                className={`${styles.websetItem} ${selectedWebset === webset.websetId ? styles.selectedWebset : ''}`}
                onClick={() => fetchWebsetDetails(webset.websetId)}
              >
                <div className={styles.websetHeader}>
                  <div className={styles.websetQuery}>
                    {webset.originalQuery || 'Unknown Query'}
                    {webset.entityType && (
                      <span className={styles.entityBadge}>{webset.entityType}</span>
                    )}
                  </div>
                  <div className={styles.websetStatus}>
                    <span className={`${styles.statusBadge} ${styles[webset.status]}`}>
                      {webset.status}
                    </span>
                  </div>
                </div>
                
                <div className={styles.websetStats}>
                  <div className={styles.stat}>
                    <strong>{webset.totalItems}</strong> total
                  </div>
                  <div className={styles.stat}>
                    <strong>{webset.uniqueItems}</strong> unique
                  </div>
                  <div className={styles.stat}>
                    <strong>{webset.duplicatesRejected}</strong> duplicates
                  </div>
                  <div className={styles.stat}>
                    <strong>{calculateDeduplicationRate(webset)}%</strong> dedup rate
                  </div>
                </div>
                
                <div className={styles.websetMeta}>
                  <span className={styles.date}>{formatDate(webset.createdAt)}</span>
                  <span className={styles.duration}>
                    {formatDuration(webset.createdAt, webset.completedAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {selectedWebset && (
            <div className={styles.detailsPanel}>
              {loadingDetails ? (
                <div className={styles.detailsLoading}>
                  <div className={styles.spinner}></div>
                  <p>Loading details...</p>
                </div>
              ) : websetDetails ? (
                <div className={styles.websetDetails}>
                  <div className={styles.detailsHeader}>
                    <h3>Query Details</h3>
                    <button 
                      onClick={() => setSelectedWebset(null)}
                      className={styles.closeButton}
                    >
                      ✕
                    </button>
                  </div>
                  
                  <div className={styles.detailsContent}>
                    <div className={styles.detailSection}>
                      <h4>Query Information</h4>
                      <div className={styles.detailRow}>
                        <span className={styles.label}>Query:</span>
                        <span className={styles.value}>
                          {websetDetails.webset.originalQuery || 'Unknown'}
                        </span>
                      </div>
                      <div className={styles.detailRow}>
                        <span className={styles.label}>Type:</span>
                        <span className={styles.value}>
                          {websetDetails.webset.entityType || 'Company'}
                        </span>
                      </div>
                      <div className={styles.detailRow}>
                        <span className={styles.label}>Status:</span>
                        <span className={`${styles.value} ${styles[websetDetails.webset.status]}`}>
                          {websetDetails.webset.status}
                        </span>
                      </div>
                    </div>

                    <div className={styles.detailSection}>
                      <h4>Results Summary</h4>
                      <div className={styles.statsGrid}>
                        <div className={styles.statCard}>
                          <div className={styles.statNumber}>{websetDetails.webset.totalItems}</div>
                          <div className={styles.statLabel}>Total Items</div>
                        </div>
                        <div className={styles.statCard}>
                          <div className={styles.statNumber}>{websetDetails.webset.uniqueItems}</div>
                          <div className={styles.statLabel}>Unique Items</div>
                        </div>
                        <div className={styles.statCard}>
                          <div className={styles.statNumber}>{websetDetails.webset.duplicatesRejected}</div>
                          <div className={styles.statLabel}>Duplicates Removed</div>
                        </div>
                        <div className={styles.statCard}>
                          <div className={styles.statNumber}>{calculateDeduplicationRate(websetDetails.webset)}%</div>
                          <div className={styles.statLabel}>Dedup Rate</div>
                        </div>
                      </div>
                    </div>

                    {websetDetails.duplicateGroups && websetDetails.duplicateGroups.length > 0 && (
                      <div className={styles.detailSection}>
                        <h4>Items with Most Duplicates</h4>
                        <div className={styles.duplicateList}>
                          {websetDetails.duplicateGroups.slice(0, 5).map((group, index) => (
                            <div key={group.itemId} className={styles.duplicateGroup}>
                              <div className={styles.groupHeader}>
                                <span className={styles.groupName}>{group.name}</span>
                                <span className={styles.groupCount}>+{group.duplicateCount} duplicates</span>
                              </div>
                              {group.url && (
                                <div className={styles.groupUrl}>{group.url}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className={styles.detailSection}>
                      <h4>Actions</h4>
                      <div className={styles.actionButtons}>
                        <Link 
                          href={`/?loadWebset=${selectedWebset}`}
                          className={styles.actionButton}
                        >
                          📊 View in Results Table
                        </Link>
                        <button 
                          onClick={() => window.open(`http://localhost:3000/api/history/websets/${selectedWebset}`, '_blank')}
                          className={styles.actionButton}
                        >
                          📄 Export JSON
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function History() {
  return (
    <>
      <Head>
        <title>Query History - Exa Dedupe</title>
        <meta name="description" content="View your historical webset queries and results" />
      </Head>
      
      <SnackbarProvider maxSnack={3}>
        <HistoryContent />
      </SnackbarProvider>
    </>
  );
} 