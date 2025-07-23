import { useState } from 'react';
import { useSnackbar } from 'notistack';
import WebsetQueryForm from '../components/WebsetQueryForm';
import StreamingResultsTable from '../components/StreamingResultsTable';
import styles from '../styles/Home.module.css';

export default function Home() {
  const [activeWebsetId, setActiveWebsetId] = useState(null);
  const [searchQuery, setSearchQuery] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const { enqueueSnackbar } = useSnackbar();

  const handleQuerySubmit = async (queryData) => {
    setIsLoading(true);
    
    try {
      enqueueSnackbar('Creating webset...', { variant: 'info' });
      
      const response = await fetch('http://localhost:3000/api/websets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(queryData),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      const { websetId } = await response.json();
      setActiveWebsetId(websetId);
      setSearchQuery(queryData.query);
      enqueueSnackbar('Webset created successfully!', { variant: 'success' });
    } catch (error) {
      console.error('Error creating webset:', error);
      enqueueSnackbar(`Failed to create webset: ${error.message}`, { variant: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewQuery = () => {
    setActiveWebsetId(null);
    setSearchQuery(null);
  };

  return (
    <div className={styles.container}>
      <main className={styles.main}>
        {!activeWebsetId ? (
          <WebsetQueryForm 
            onSubmit={handleQuerySubmit} 
            isLoading={isLoading} 
          />
        ) : (
          <div className={styles.resultsContainer}>
            {searchQuery && (
              <div className={styles.searchQuery}>
                <strong>Search Query:</strong> {searchQuery}
              </div>
            )}
            <div className={styles.resultHeader}>
              <h2>Streaming Results for Webset: {activeWebsetId}</h2>
              <button 
                onClick={handleNewQuery}
                className={styles.newQueryButton}
              >
                New Query
              </button>
            </div>
            <StreamingResultsTable websetId={activeWebsetId} />
          </div>
        )}
      </main>
    </div>
  );
} 