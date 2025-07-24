import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useSnackbar } from 'notistack';
import WebsetQueryForm from '../components/WebsetQueryForm';
import StreamingResultsTable from '../components/StreamingResultsTable';
import styles from '../styles/Home.module.css';

export default function Home() {
  const router = useRouter();
  const [activeWebsetId, setActiveWebsetId] = useState(null);
  const [searchQuery, setSearchQuery] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [historicalData, setHistoricalData] = useState(null);
  const { enqueueSnackbar } = useSnackbar();

  // Handle loading webset from history page
  useEffect(() => {
    const { loadWebset } = router.query;
    if (loadWebset && !activeWebsetId) {
      loadHistoricalWebset(loadWebset);
    }
  }, [router.query, activeWebsetId]);

  const loadHistoricalWebset = async (websetId) => {
    setIsLoading(true);
    try {
      const response = await fetch(`http://localhost:3000/api/history/websets/${websetId}`);
      const data = await response.json();
      
      if (data.success) {
        setActiveWebsetId(websetId);
        setSearchQuery(data.webset.originalQuery || 'Historical Query');
        
        // Set historical data for StreamingResultsTable
        setHistoricalData({
          items: data.items.accepted || [],
          rejectedItems: data.items.rejected || [],
          status: 'finished',
          totalItems: data.webset.totalItems
        });
        
        // Clean up the URL
        router.replace('/', undefined, { shallow: true });
        
        enqueueSnackbar(`Loaded historical query: ${data.webset.originalQuery || 'Unknown query'} (${data.items.accepted?.length || 0} unique, ${data.items.rejected?.length || 0} duplicates)`, { 
          variant: 'success' 
        });
      } else {
        enqueueSnackbar(`Failed to load historical query: ${data.error}`, { variant: 'error' });
      }
    } catch (error) {
      console.error('Error loading historical webset:', error);
      enqueueSnackbar('Error loading historical query', { variant: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuerySubmit = async (queryData) => {
    setIsLoading(true);
    setHistoricalData(null); // Clear any historical data
    
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
    setHistoricalData(null); // Clear historical data
  };

  return (
    <div className={styles.container}>
      {!activeWebsetId ? (
        <WebsetQueryForm onSubmit={handleQuerySubmit} isLoading={isLoading} />
      ) : (
        <>
        <h2> Query: {searchQuery || 'Loading...'}</h2>
          <div className={styles.header}>
            
            <button onClick={handleNewQuery} className={styles.newQueryButton}>
              New Query
            </button>
          </div>
          <StreamingResultsTable 
            websetId={activeWebsetId} 
            historicalData={historicalData} // Pass historical data
          />
        </>
      )}
    </div>
  );
} 