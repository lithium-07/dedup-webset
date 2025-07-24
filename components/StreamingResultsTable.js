import { useState, useEffect, useRef } from 'react';
import React from 'react';
import { useSnackbar } from 'notistack';
import styles from './StreamingResultsTable.module.css';
import SemanticSearch from './SemanticSearch';

export default function StreamingResultsTable({ websetId, historicalData }) {
  const [items, setItems] = useState([]);
  const [rejectedItems, setRejectedItems] = useState([]);
  const [showRejected, setShowRejected] = useState(false);
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [columns, setColumns] = useState([]);
  const [columnWidths, setColumnWidths] = useState({});
  const [sortConfig, setSortConfig] = useState({ key: null, direction: null });
  
  // NEW: Clustering feature state (easily removable)
  const [clusteringEnabled, setClusteringEnabled] = useState(true);
  const [expandedItems, setExpandedItems] = useState(new Set());
  const [duplicateCounts, setDuplicateCounts] = useState({});
  const [duplicateMap, setDuplicateMap] = useState({});
  
  const [showSemanticSearch, setShowSemanticSearch] = useState(false);
  
  // Semantic Clustering state
  const [showClusteringModal, setShowClusteringModal] = useState(false);
  const [clusteringQuery, setClusteringQuery] = useState('');
  const [clusters, setClusters] = useState([]);
  const [isClusteringLoading, setIsClusteringLoading] = useState(false);
  const [clusteringError, setClusteringError] = useState(null);
  // Remove viewMode - we'll just reorder the same table
  const [isClusteringActive, setIsClusteringActive] = useState(false);
  const [activeClusteringQuery, setActiveClusteringQuery] = useState(''); // Track the query used for current clustering
  const [originalItems, setOriginalItems] = useState([]); // Preserve original order for reset
  const [clusteringProgress, setClusteringProgress] = useState({ step: 0, message: '', percentage: 0 });
  const [clusterColors] = useState(['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316']);

  const eventSourceRef = useRef(null);
  const { enqueueSnackbar } = useSnackbar();

  // CORE FUNCTIONALITY: SSE Streaming
  useEffect(() => {
    // If we have historical data, use it instead of connecting to SSE
    if (historicalData) {
      setItems(historicalData.items);
      setRejectedItems(historicalData.rejectedItems);
      setStatus(historicalData.status);
      updateColumns(historicalData.items);
      return; // Skip SSE connection
    }

    if (!websetId) return;

    // Set status to processing immediately
    setStatus('processing');
    setError(null);
    setItems([]);
    setRejectedItems([]);
    setColumns([]);
    setSortConfig({ key: null, direction: null });

    // Create EventSource for streaming
    const eventSource = new EventSource(`http://localhost:3000/api/websets/${websetId}/stream`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'connected':
            setStatus('processing');
            setError(null);
            enqueueSnackbar('Stream connected, processing items...', { variant: 'success' });
            break;
            
          case 'status':
            if (data.status !== status) {  // Only update if status has changed
              setStatus(data.status);
              if (data.status === 'finished') {
                enqueueSnackbar('Processing completed', { variant: 'success' });
              }
            }
            break;
            
          case 'item':
            console.log('Received item:', JSON.stringify(data.item, null, 2));
            setItems(prev => {
              // Check if item already exists to avoid duplicates
              const exists = prev.some(item => item.id === data.item.id);
              if (exists) return prev;
              const newItems = [...prev, data.item];
              
              // Update columns based on all items we have so far
              updateColumns(newItems);
              
              // Show notification for first few items
              if (newItems.length <= 3) {
                enqueueSnackbar(`Item ${newItems.length} received`, { variant: 'info' });
              }
              
              return newItems;
            });
            break;
            
          case 'finished':
            setStatus(`finished (${data.totalItems} items)`);
            enqueueSnackbar(`Webset completed with ${data.totalItems} items`, { variant: 'success' });
            break;
            
          case 'error':
            setError(data.error);
            setStatus('error');
            enqueueSnackbar(`Stream error: ${data.error}`, { variant: 'error' });
            break;

          case 'pending':
            // Item is temporarily added but pending LLM verification
            console.log('Pending item with tmpId:', data.tmpId);
            setItems(prev => {
              // Add item with pending status
              const pendingItem = { 
                id: data.tmpId, 
                _pending: true,
                properties: { status: { value: 'Checking for duplicates...' } }
              };
              const newItems = [...prev, pendingItem];
              updateColumns(newItems);
              return newItems;
            });
            enqueueSnackbar('Checking item for duplicates...', { variant: 'info' });
            break;

          case 'drop':
            // Remove item that was determined to be duplicate
            console.log('Dropping item with tmpId:', data.tmpId);
            setItems(prev => {
              const filtered = prev.filter(item => item.id !== data.tmpId);
              updateColumns(filtered);
              return filtered;
            });
            enqueueSnackbar('Duplicate item removed', { variant: 'warning' });
            break;

          case 'confirm':
            // Replace pending item with confirmed data
            console.log('Confirming item:', JSON.stringify(data.data, null, 2));
            
            // Safety check for data.data
            if (!data.data || !data.data.id) {
              console.warn('Invalid confirm data received:', data);
              break;
            }
            
            setItems(prev => {
              const updated = prev.map(item => 
                item._pending && item.id === data.data.id 
                  ? { ...data.data, _confirmed: true }
                  : item
              );
              updateColumns(updated);
              return updated;
            });
            enqueueSnackbar('Item confirmed as unique', { variant: 'success' });
            break;

          case 'rejected':
            // Add rejected item to rejected items list
            console.log('Item rejected:', JSON.stringify(data.item, null, 2));
            setRejectedItems(prev => {
              const rejectedItem = {
                ...data.item,
                _rejectionReason: data.reason,
                _rejectionDetails: data.details,
                _existingItem: data.existingItem,
                _rejectedAt: new Date().toISOString()
              };
              return [...prev, rejectedItem];
            });
            enqueueSnackbar(`Item rejected: ${data.details}`, { variant: 'warning' });
            break;
        }
      } catch (err) {
        console.error('Error parsing SSE data:', err);
        const errorMsg = 'Error parsing server response';
        setError(errorMsg);
        enqueueSnackbar(errorMsg, { variant: 'error' });
      }
    };

    eventSource.onerror = (err) => {
      console.error('EventSource failed:', err);
      const errorMsg = 'Connection to server lost';
      setError(errorMsg);
      setStatus('error');
      enqueueSnackbar(errorMsg, { variant: 'error' });
    };

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [websetId, historicalData]);

  // ESSENTIAL UTILITY FUNCTIONS
  const formatDate = (dateString) => {
    if (!dateString) return 'Just now';
    return new Date(dateString).toLocaleString();
  };

  const truncateText = (text, maxLength = 100) => {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  // Function to update columns based on items properties data
  const updateColumns = (items) => {
    if (items.length === 0) return;
    
    const allKeys = new Set();
    
    // Add index column first, then type column
    allKeys.add('_index');
    allKeys.add('_type');
    
    items.forEach(item => {
      if (item.properties && typeof item.properties === 'object') {
        Object.keys(item.properties).forEach(propKey => {
          const propValue = item.properties[propKey];
          
          // Skip 'type' since we handle it specially as '_type'
          if (propKey === 'type') return;
          
          if (propValue && typeof propValue === 'object' && !Array.isArray(propValue)) {
            // If it's an object (like 'company'), flatten its properties
            Object.keys(propValue).forEach(nestedKey => {
              if (propValue[nestedKey] != null) {
                allKeys.add(nestedKey);
              }
            });
          } else {
            // If it's a primitive value (like 'url', 'description'), add directly
            if (propValue != null) {
              allKeys.add(propKey);
            }
          }
        });
      }
    });
    
    const columnList = Array.from(allKeys).map(key => ({
      key,
      label: key === '_index' ? '#' : key === '_type' ? 'Type' : formatColumnLabel(key),
      type: getColumnType(items, key)
    }));
    
    // Set default column widths
    const defaultWidths = {};
    columnList.forEach(col => {
      if (col.key === '_index') {
        defaultWidths[col.key] = 60;
      } else if (col.key === '_type') {
        defaultWidths[col.key] = 100;
      } else if (col.type === 'url') {
        defaultWidths[col.key] = 200;
      } else {
        defaultWidths[col.key] = 150;
      }
    });
    
    setColumnWidths(prev => ({ ...defaultWidths, ...prev }));
    setColumns(columnList);
  };

  const updateClusteringProgress = (step, message, percentage) => {
    setClusteringProgress({ step, message, percentage });
  };

  const getEstimatedDuration = (itemCount) => {
    // Estimate duration based on item count
    if (itemCount <= 10) return 'a few seconds';
    if (itemCount <= 50) return '10-15 seconds';
    if (itemCount <= 100) return '20-30 seconds';
    return '30-60 seconds';
  };

  const handleClusterItems = async () => {
    if (!clusteringQuery.trim()) {
      setClusteringError('Please enter a clustering query');
      return;
    }

    setIsClusteringLoading(true);
    setClusteringError(null);
    
    const itemCount = items.length;
    const estimatedTime = getEstimatedDuration(itemCount);
    
    try {
      // Step 1: Initial analysis
      updateClusteringProgress(1, `Analyzing ${itemCount} items... (estimated ${estimatedTime})`, 10);
      await new Promise(resolve => setTimeout(resolve, 500)); // Brief pause for UX
      
      // Step 2: Detect entity type
      updateClusteringProgress(2, 'Detecting entity type and extracting fields...', 25);
      const entityType = detectEntityType(items.slice(0, 5));
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Step 3: Prepare request
      updateClusteringProgress(3, 'Preparing data for AI processing...', 35);
      const requestData = {
        webset_id: websetId,
        items: items.map(item => item.properties || {}),
        query: clusteringQuery,
        entity_type: entityType
      };
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Step 4: Send to clustering service
      updateClusteringProgress(4, `Processing with AI (${entityType} clustering)...`, 45);
      
      const response = await fetch('http://localhost:8003/cluster', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        throw new Error(`Clustering service returned ${response.status}: ${response.statusText}`);
      }

      // Step 5: Parse response
      updateClusteringProgress(5, 'Processing clustering results...', 75);
      const result = await response.json();
      
      // Preserve original items order before clustering
      if (!isClusteringActive) {
        setOriginalItems([...items]);
      }
      
      // Step 6: Match and organize clusters
      updateClusteringProgress(6, 'Organizing clusters and matching items...', 85);
      
      // Process clusters and assign cluster info to items
      const clusteredItems = [];
      const clusterInfo = [];
      
      result.clusters.forEach((cluster, clusterIndex) => {
        const clusterColor = clusterColors[clusterIndex % clusterColors.length];
        
        cluster.items.forEach((clusterItem, itemIndex) => {
          // Find the original item that matches this clustered item
          const originalItem = items.find(item => {
            // Try to match by multiple criteria
            const props = item.properties || {};
            return (
              // Match by name/title
              (props.name === clusterItem.name) ||
              (props.title === clusterItem.title) ||
              (props.company?.name === clusterItem.name) ||
              (props.book?.title === clusterItem.title) ||
              (props.movie?.title === clusterItem.title) ||
              // Match by URL if available
              (props.url === clusterItem.url) ||
              // Match by any nested property containing the name
              JSON.stringify(props).includes(clusterItem.name || clusterItem.title || '') ||
              // Fallback: try to match by description/content similarity
              (clusterItem.description && props.description === clusterItem.description)
            );
          });
          
          if (originalItem) {
            clusteredItems.push({
              ...originalItem,
              _cluster: {
                id: clusterIndex,
                name: cluster.name,
                reasoning: cluster.reasoning,
                color: clusterColor,
                position: itemIndex + 1,
                total: cluster.count
              }
            });
          } else {
            console.warn('Could not match clustered item back to original:', clusterItem);
          }
        });
        
        clusterInfo.push({
          ...cluster,
          color: clusterColor
        });
      });
      
      // Step 7: Final organization
      updateClusteringProgress(7, 'Reordering table...', 95);
      
      // Add items that weren't clustered (if any) at the end
      const clusteredItemIds = new Set(clusteredItems.map(item => item.id));
      const unclusteredItems = items.filter(item => !clusteredItemIds.has(item.id));
      
      if (unclusteredItems.length > 0) {
        console.log(`${unclusteredItems.length} items could not be clustered and will appear at the end`);
      }
      
      setClusters(clusterInfo);
      // Update the items array with clustered items + unclustered items
      setItems([...clusteredItems, ...unclusteredItems]);
      setIsClusteringActive(true);
      setShowClusteringModal(false);
      setActiveClusteringQuery(clusteringQuery); // Save the query before clearing
      setClusteringQuery(''); // Clear input for next use
      
      // Step 8: Complete
      updateClusteringProgress(8, 'Clustering complete!', 100);
      
      // Save query to history
      try {
        await fetch('http://localhost:3000/api/query-history', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            websetId,
            queryType: 'clustering',
            queryText: clusteringQuery,
            entityType,
            resultsMetadata: {
              itemsProcessed: clusteredItems.length,
              clustersFound: result.clusters.length,
              processingTimeMs: result.processing_time_ms || 0
            },
            resultsSummary: `Created ${result.clusters.length} clusters from ${clusteredItems.length} items`
          })
        });
        console.log('📝 Clustering query saved to history');
      } catch (historyError) {
        console.warn('Failed to save clustering query to history:', historyError);
        // Don't fail the main operation if history saving fails
      }
      
      enqueueSnackbar(
        `Successfully clustered ${clusteredItems.length} items into ${result.clusters.length} groups`, 
        { variant: 'success' }
      );
      
    } catch (error) {
      console.error('Clustering error:', error);
      setClusteringError(error.message);
      enqueueSnackbar(`Clustering failed: ${error.message}`, { variant: 'error' });
    } finally {
      setIsClusteringLoading(false);
      setClusteringProgress({ step: 0, message: '', percentage: 0 });
    }
  };

  const detectEntityType = (items) => {
    if (!items || items.length === 0) return 'unknown';
    
    // Analyze first few items to detect type
    const sample = items.slice(0, Math.min(5, items.length));
    const fieldCounts = {};
    
    sample.forEach(item => {
      if (item.properties) {
        Object.keys(item.properties).forEach(key => {
          const nestedProps = item.properties[key];
          if (typeof nestedProps === 'object' && nestedProps !== null) {
            Object.keys(nestedProps).forEach(nestedKey => {
              fieldCounts[nestedKey.toLowerCase()] = (fieldCounts[nestedKey.toLowerCase()] || 0) + 1;
            });
          }
          fieldCounts[key.toLowerCase()] = (fieldCounts[key.toLowerCase()] || 0) + 1;
        });
      }
    });
    
    // Check for movie indicators
    const movieFields = ['director', 'genre', 'cast', 'runtime', 'imdb'];
    if (movieFields.some(field => fieldCounts[field])) {
      return 'movie';
    }
    
    // Check for company indicators
    const companyFields = ['industry', 'employees', 'revenue', 'headquarters'];
    if (companyFields.some(field => fieldCounts[field])) {
      return 'company';
    }
    
    return 'movie'; // Default fallback
  };

  const resetClustering = () => {
    // Restore original items order
    if (originalItems.length > 0) {
      setItems([...originalItems]);
    } else {
      // Fallback: remove cluster info from current items
      const cleanedItems = items.map(item => {
        const { _cluster, ...originalItem } = item;
        return originalItem;
      });
      setItems(cleanedItems);
    }
    
    setClusters([]);
    setIsClusteringActive(false);
    setClusteringQuery('');
    setClusteringError(null);
    setActiveClusteringQuery('');
    setOriginalItems([]); // Clear preserved items
    enqueueSnackbar('Clustering cleared - table restored to original order', { variant: 'info' });
  };

  const formatColumnLabel = (key) => {
    return key
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  };

  // Determine column type based on data from properties
  const getColumnType = (items, key) => {
    if (key === '_index') return 'number';
    if (key === '_type') return 'text';
    
    const values = items
      .map(item => {
        if (item.properties && typeof item.properties === 'object') {
          // First check if it's a direct property
          if (item.properties[key] != null) {
            return item.properties[key];
          }
          
          // Then check in nested objects
          for (const propKey of Object.keys(item.properties)) {
            const propValue = item.properties[propKey];
            if (propValue && typeof propValue === 'object' && !Array.isArray(propValue)) {
              if (propValue[key] != null) {
                return propValue[key];
              }
            }
          }
        }
        return null;
      })
      .filter(val => val != null);
    
    if (values.length === 0) return 'text';
    
    const firstValue = values[0];
    if (typeof firstValue === 'string' && (firstValue.startsWith('http://') || firstValue.startsWith('https://'))) {
      return 'url';
    } else if (Array.isArray(firstValue)) {
      return 'array';
    } else if (typeof firstValue === 'object') {
      return 'object';
    } else if (typeof firstValue === 'boolean') {
      return 'boolean';
    } else if (typeof firstValue === 'number') {
      return 'number';
    } else if (key.includes('date') || key.includes('time') || key.includes('created') || key.includes('updated')) {
      return 'date';
    }
    return 'text';
  };

  // Format cell value based on type
  const formatCellValue = (value, type, maxLength = 100) => {
    if (value == null) return <span className={styles.nullValue}>—</span>;
    
    switch (type) {
      case 'url':
        try {
          const hostname = new URL(value).hostname;
          return (
            <a href={value} target="_blank" rel="noopener noreferrer" className={styles.link}>
              {hostname}
            </a>
          );
        } catch {
          return truncateText(value, maxLength);
        }
      case 'array':
        if (value.length === 0) return <span className={styles.emptyValue}>Empty array</span>;
        return (
          <div className={styles.arrayValue}>
            {value.slice(0, 3).map((item, idx) => (
              <div key={idx} className={styles.arrayItem}>
                {truncateText(typeof item === 'object' ? JSON.stringify(item) : String(item), 50)}
              </div>
            ))}
            {value.length > 3 && <div className={styles.arrayMore}>+{value.length - 3} more</div>}
          </div>
        );
      case 'object':
        return (
          <div className={styles.objectValue}>
            {Object.entries(value).map(([key, val]) => (
              <div key={key} className={styles.objectItem}>
                <strong>{formatColumnLabel(key)}:</strong> {String(val)}
              </div>
            ))}
          </div>
        );
      case 'boolean':
        return <span className={value ? styles.trueValue : styles.falseValue}>{String(value)}</span>;
      case 'number':
        return <span className={styles.numberValue}>{value.toLocaleString()}</span>;
      case 'date':
        return formatDate(value);
      default:
        return <span className={styles.textValue}>{truncateText(String(value), maxLength)}</span>;
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'processing': return '#2563eb';
      case 'processing_items': return '#2563eb';
      case 'connecting': return '#f59e0b';
      case 'error': return '#dc2626';
      default: return status.startsWith('finished') ? '#16a34a' : '#2563eb';
    }
  };

  // Column resizing functionality
  const handleMouseDown = (columnKey) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = columnWidths[columnKey] || 150;

    const handleMouseMove = (e) => {
      const currentX = e.clientX;
      const diffX = currentX - startX;
      const newWidth = Math.max(50, startWidth + diffX);
      
      setColumnWidths(prev => ({
        ...prev,
        [columnKey]: newWidth
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Get sortable value from item for a given column key
  const getSortValue = (item, columnKey) => {
    if (columnKey === '_index') {
      return items.indexOf(item) + 1;
    } else if (columnKey === '_type') {
      return item.properties ? item.properties.type : null;
    } else if (item.properties) {
      // First check if it's a direct property
      if (item.properties[columnKey] != null) {
        return item.properties[columnKey];
      }
      
      // Then check in nested objects
      for (const propKey of Object.keys(item.properties)) {
        const propValue = item.properties[propKey];
        if (propValue && typeof propValue === 'object' && !Array.isArray(propValue)) {
          if (propValue[columnKey] != null) {
            return propValue[columnKey];
          }
        }
      }
    }
    return null;
  };

  // Sort items based on current sort config
  const sortedItems = [...items].sort((a, b) => {
    if (!sortConfig.key || !sortConfig.direction) return 0;

    const aValue = getSortValue(a, sortConfig.key);
    const bValue = getSortValue(b, sortConfig.key);

    // Handle null/undefined values
    if (aValue == null && bValue == null) return 0;
    if (aValue == null) return sortConfig.direction === 'asc' ? 1 : -1;
    if (bValue == null) return sortConfig.direction === 'asc' ? -1 : 1;

    // Sort based on data type
    let comparison = 0;
    if (typeof aValue === 'number' && typeof bValue === 'number') {
      comparison = aValue - bValue;
    } else if (typeof aValue === 'string' && typeof bValue === 'string') {
      comparison = aValue.toLowerCase().localeCompare(bValue.toLowerCase());
    } else {
      // Convert to string for mixed types
      comparison = String(aValue).toLowerCase().localeCompare(String(bValue).toLowerCase());
    }

    return sortConfig.direction === 'asc' ? comparison : -comparison;
  });

  // Handle column header clicks for sorting
  const handleSort = (columnKey) => {
    let direction = 'asc';
    
    if (sortConfig.key === columnKey) {
      if (sortConfig.direction === 'asc') {
        direction = 'desc';
      } else if (sortConfig.direction === 'desc') {
        direction = null;
        columnKey = null;
      }
    }
    
    setSortConfig({ key: columnKey, direction });
  };

  // Get sort indicator for column header
  const getSortIndicator = (columnKey) => {
    if (sortConfig.key !== columnKey) return '';
    if (sortConfig.direction === 'asc') return ' ↑';
    if (sortConfig.direction === 'desc') return ' ↓';
    return '';
  };

  // NEW: Clustering helper functions (easily removable)
  const buildDuplicateMaps = () => {
    if (!clusteringEnabled) return;
    
    const counts = {};
    const duplicatesByParent = {};
    
    rejectedItems.forEach(rejectedItem => {
      const parentId = rejectedItem._existingItem?.id;
      if (parentId) {
        // Count duplicates per parent
        counts[parentId] = (counts[parentId] || 0) + 1;
        
        // Group duplicates by parent
        if (!duplicatesByParent[parentId]) {
          duplicatesByParent[parentId] = [];
        }
        duplicatesByParent[parentId].push(rejectedItem);
      }
    });
    
    setDuplicateCounts(counts);
    setDuplicateMap(duplicatesByParent);
  };

  const toggleItemExpansion = (itemId) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  // NEW: Expand/collapse all functionality
  const expandAllItems = () => {
    const itemsWithDuplicates = Object.keys(duplicateCounts);
    setExpandedItems(new Set(itemsWithDuplicates));
  };

  const collapseAllItems = () => {
    setExpandedItems(new Set());
  };

  const hasAnyExpanded = expandedItems.size > 0;
  const canExpandCollapse = Object.keys(duplicateCounts).length > 0;



  // Render duplicate count badge (now clickable)
  const renderDuplicateBadge = (item) => {
    if (!clusteringEnabled || !duplicateCounts[item.id]) return null;
    
    const count = duplicateCounts[item.id];
    const isExpanded = expandedItems.has(item.id);
    
    return (
      <button
        className={styles.duplicateBadge}
        onClick={() => toggleItemExpansion(item.id)}
        title={`${count} duplicate${count > 1 ? 's' : ''} found. Click to ${isExpanded ? 'collapse' : 'expand'}.`}
      >
        🔗 +{count}
      </button>
    );
  };

  // Render expand/collapse button for items with duplicates
  const renderExpandButton = (item) => {
    if (!clusteringEnabled || !duplicateCounts[item.id]) return null;
    
    const isExpanded = expandedItems.has(item.id);
    
    return (
      <button
        className={styles.expandButton}
        onClick={() => toggleItemExpansion(item.id)}
        title={`Click to ${isExpanded ? 'collapse' : 'expand'} duplicates`}
      >
        {isExpanded ? '▲' : '▼'}
      </button>
    );
  };

  // Render duplicate rows for expanded items
  const renderDuplicateRows = (parentItem) => {
    if (!clusteringEnabled || !expandedItems.has(parentItem.id) || !duplicateMap[parentItem.id]) {
      return null;
    }

    return duplicateMap[parentItem.id].map((duplicate, index) => {
      const reasonLabels = {
        'exact_match': 'Exact Match',
        'fuzzy_match': 'Similar Name',
        'cache_hit': 'Previously Seen',
        'llm_duplicate': 'AI Detected Duplicate',
        'near_duplicate': 'Vector Similarity',
        'exact_url_duplicate': 'Exact URL Match',
        'normalized_title_duplicate': 'Identical Title',
        'entity_llm_duplicate': 'AI Entity Duplicate'
      };

      const reasonIcons = {
        'exact_match': '🎯',
        'fuzzy_match': '📊',
        'cache_hit': '💾',
        'llm_duplicate': '🤖',
        'near_duplicate': '🔍',
        'exact_url_duplicate': '🔗',
        'normalized_title_duplicate': '🛡️',
        'entity_llm_duplicate': '🧠'
      };

      return (
        <tr key={`duplicate-${parentItem.id}-${index}`} className={styles.duplicateRow}>
          <td className={styles.duplicateIndicator}>
            <span className={styles.duplicateIcon}>
              {reasonIcons[duplicate._rejectionReason]} {reasonLabels[duplicate._rejectionReason]}
            </span>
          </td>
          {columns.slice(1).map(column => {
            let cellValue;
            
            if (column.key === '_type') {
              cellValue = duplicate.properties ? duplicate.properties.type : null;
            } else if (duplicate.properties) {
              // First check if it's a direct property
              if (duplicate.properties[column.key] != null) {
                cellValue = duplicate.properties[column.key];
              } else {
                // Then check in nested objects
                for (const propKey of Object.keys(duplicate.properties)) {
                  const propValue = duplicate.properties[propKey];
                  if (propValue && typeof propValue === 'object' && !Array.isArray(propValue)) {
                    if (propValue[column.key] != null) {
                      cellValue = propValue[column.key];
                      break;
                    }
                  }
                }
              }
            }
            
            return (
              <td 
                key={column.key} 
                className={`${styles.cell} ${styles.duplicateCell}`}
                data-label={column.label}
              >
                {formatCellValue(cellValue, column.type)}
              </td>
            );
          })}
        </tr>
      );
    });
  };

  // Update duplicate maps whenever rejected items change
  useEffect(() => {
    if (clusteringEnabled) {
      buildDuplicateMaps();
    } else {
      // Clear expansion state when clustering is disabled
      setExpandedItems(new Set());
      setDuplicateCounts({});
      setDuplicateMap({});
    }
  }, [rejectedItems, clusteringEnabled]);



  return (
    <div className={styles.container}>
      <div className={styles.statusBar}>
        <div className={styles.statusIndicator}>
          <div 
            className={styles.statusDot} 
            style={{ backgroundColor: getStatusColor() }}
          />
          <span>Status: {status === 'processing_items' ? 'Processing Items' : status}</span>
        </div>
        <div className={styles.itemCount}>
          Items received: {items.length}
          {rejectedItems.length > 0 && (
            <span className={styles.rejectedCount}>
              • Rejected: {rejectedItems.length}
            </span>
          )}
        </div>

        {/* Add semantic search toggle when processing is complete */}
        {status.startsWith('finished') && items.length > 0 && (
          <button
            onClick={() => setShowSemanticSearch(!showSemanticSearch)}
            className={`${styles.toggleButton} ${showSemanticSearch ? styles.activeToggle : ''}`}
          >
            {showSemanticSearch ? '📊 Show Table' : '🔍 Ask Questions'}
          </button>
        )}

        {/* Show rejected toggle only when clustering is OFF */}
        {!clusteringEnabled && rejectedItems.length > 0 && (
          <div className={styles.rejectedToggle}>
            <button 
              onClick={() => setShowRejected(!showRejected)}
              className={styles.toggleButton}
            >
              {showRejected ? 'Hide' : 'Show'} Rejected ({rejectedItems.length})
            </button>
          </div>
        )}

        {/* NEW: Expand/collapse all button when clustering is ON */}
        {clusteringEnabled && canExpandCollapse && (
          <div className={styles.expandAllToggle}>
            <button 
              onClick={hasAnyExpanded ? collapseAllItems : expandAllItems}
              className={`${styles.toggleButton} ${styles.expandAllButton}`}
            >
              {hasAnyExpanded ? '🔼 Collapse All' : '🔽 Expand All'}
            </button>
          </div>
        )}

        {/* NEW: Clustering toggle (easily removable) */}
        {rejectedItems.length > 0 && (
          <div className={styles.clusteringToggle}>
            <button 
              onClick={() => setClusteringEnabled(!clusteringEnabled)}
              className={`${styles.toggleButton} ${clusteringEnabled ? styles.activeToggle : ''}`}
            >
              {clusteringEnabled ? '🔗 Clustering On' : '📋 List View'}
            </button>
          </div>
        )}

        {/* Semantic Clustering Controls */}
        <div className={styles.clusteringControls}>
          <button
            onClick={() => setShowClusteringModal(true)}
            className={styles.clusterButton}
            disabled={items.length === 0 || status === 'processing'}
            title="Cluster items semantically"
          >
            🎯 Semantic Clustering
          </button>
          
          {isClusteringActive && (
            <button
              onClick={resetClustering}
              className={styles.resetButton}
              title="Return to table view"
            >
              📋 Table View
            </button>
          )}
        </div>


      </div>

      {error && (
        <div className={styles.error}>
          Error: {error}
        </div>
      )}

      {/* Clustering Modal */}
      {showClusteringModal && (
        <div className={styles.modal}>
          <div className={styles.modalContent}>
            <div className={styles.modalHeader}>
              <h3>🎯 Semantic Clustering</h3>
              <button 
                onClick={() => setShowClusteringModal(false)}
                className={styles.closeButton}
              >
                ×
              </button>
            </div>
            
            <div className={styles.modalBody}>
              <p>How would you like to cluster these {items.length} items?</p>
              
              <textarea
                value={clusteringQuery}
                onChange={(e) => setClusteringQuery(e.target.value)}
                placeholder="Example: 'group movies by same director' or 'cluster companies in similar industries'"
                className={styles.clusteringInput}
                rows={3}
              />
              
              <div className={styles.exampleQueries}>
                <p><strong>Example queries:</strong></p>
                <div className={styles.examples}>
                  <button onClick={() => setClusteringQuery('group by director')}>group by director</button>
                  <button onClick={() => setClusteringQuery('same genre')}>same genre</button>
                  <button onClick={() => setClusteringQuery('cluster by decade')}>cluster by decade</button>
                  <button onClick={() => setClusteringQuery('same industry')}>same industry</button>
                </div>
              </div>
              
              {clusteringError && (
                <div className={styles.error}>
                  {clusteringError}
                </div>
              )}
              
              {/* Progress Loader */}
              {isClusteringLoading && (
                <div className={styles.progressContainer}>
                  <div className={styles.progressHeader}>
                    <span className={styles.progressTitle}>
                      Step {clusteringProgress.step}/8: {clusteringProgress.message}
                    </span>
                  </div>
                  <div className={styles.progressBarContainer}>
                    <div 
                      className={styles.progressBar}
                      style={{ width: `${clusteringProgress.percentage}%` }}
                    />
                  </div>
                  <div className={styles.progressPercentage}>
                    {clusteringProgress.percentage}%
                  </div>
                  <div className={styles.progressSteps}>
                    {[
                      'Analyzing items',
                      'Detecting entity type', 
                      'Preparing data',
                      'AI processing',
                      'Processing results',
                      'Organizing clusters',
                      'Reordering table',
                      'Complete'
                    ].map((stepName, index) => (
                      <div 
                        key={index}
                        className={`${styles.progressStep} ${
                          index + 1 <= clusteringProgress.step ? styles.progressStepComplete : 
                          index + 1 === clusteringProgress.step ? styles.progressStepActive : 
                          styles.progressStepPending
                        }`}
                      >
                        <div className={styles.progressStepNumber}>{index + 1}</div>
                        <div className={styles.progressStepName}>{stepName}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            
            <div className={styles.modalFooter}>
              <button 
                onClick={() => setShowClusteringModal(false)}
                className={styles.cancelButton}
              >
                Cancel
              </button>
              <button 
                onClick={handleClusterItems}
                className={styles.clusterButton}
                disabled={isClusteringLoading || !clusteringQuery.trim()}
              >
                {isClusteringLoading ? '🔄 Clustering...' : '🎯 Cluster Items'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Show either semantic search or table view */}
      {showSemanticSearch ? (
        <SemanticSearch websetId={websetId} items={items} />
      ) : (
        <div>
          {/* Cluster Summary - Show when clustering is active */}
          {isClusteringActive && clusters.length > 0 && (
            <div className={styles.clusterSummary}>
              <div className={styles.clusterSummaryHeader}>
                <h4 className={styles.clusterSummaryTitle}>
                  📊 Semantic Clustering Active - Table Reordered by: "{activeClusteringQuery || 'No Query'}" 
                </h4>
                <button onClick={resetClustering} className={styles.resetClusteringButton}>
                  ↺ Reset Order
                </button>
              </div>
              <div className={styles.clustersList}>
                {clusters.map((cluster, index) => (
                  <div key={index} className={styles.clusterSummaryItem}>
                    <div 
                      className={styles.clusterColorIndicator} 
                      style={{ backgroundColor: cluster.color }}
                    />
                    <span className={styles.clusterSummaryText}>
                      <strong>{cluster.name}</strong> ({cluster.count} items)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {items.length === 0 && !error ? (
            status === 'processing' || status === 'processing_items' || status === 'connecting' ? (
              // Show skeleton table while streaming
              <div className={styles.tableContainer}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {[...Array(6)].map((_, index) => (
                        <th key={`skeleton-header-${index}`} className={styles.resizableHeader}>
                          <div className={styles.headerContent}>
                            <span className={styles.sortableHeader}>
                              <div className={styles.skeletonHeader}></div>
                            </span>
                          </div>
                          <div className={styles.resizeHandle}></div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...Array(3)].map((_, index) => (
                      <tr key={`skeleton-${index}`} className={styles.skeletonRow}>
                        <td><div className={styles.skeleton}></div></td>
                        <td><div className={styles.skeleton}></div></td>
                        <td><div className={styles.skeleton}></div></td>
                        <td><div className={styles.skeletonLong}></div></td>
                        <td><div className={styles.skeleton}></div></td>
                        <td><div className={styles.skeleton}></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.loading}>
                <div className={styles.spinner} />
                <p>Waiting to receive items...</p>
              </div>
            )
          ) : columns.length === 0 ? (
            <div className={styles.loading}>
              <p>No properties found in results...</p>
            </div>
          ) : (
            <div className={styles.tableContainer}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {columns.map(column => (
                      <th 
                        key={column.key} 
                        className={styles.resizableHeader}
                        style={{ width: columnWidths[column.key] || 'auto' }}
                      >
                        <div 
                          className={styles.headerContent}
                          onClick={() => handleSort(column.key)}
                        >
                          <span className={styles.sortableHeader}>
                            {column.label}{getSortIndicator(column.key)}
                          </span>
                        </div>
                        <div 
                          className={styles.resizeHandle}
                          onMouseDown={handleMouseDown(column.key)}
                        ></div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map((item, index) => {
                    // Debug logging
                    console.log(`Row ${index + 1}:`, {
                      hasProperties: !!item.properties,
                      propertiesKeys: item.properties ? Object.keys(item.properties) : [],
                      typeValue: item.properties ? item.properties.type : null,
                      properties: item.properties
                    });
                    
                    // Determine row CSS classes based on item status
                    const getRowClassName = () => {
                      let className = styles.itemRow;
                      if (item._pending) {
                        className += ` ${styles.pendingRow}`;
                      } else if (item._confirmed) {
                        className += ` ${styles.confirmedRow}`;
                      }
                      // NEW: Add clustering row class
                      if (clusteringEnabled && duplicateCounts[item.id]) {
                        className += ` ${styles.hasDuplicates}`;
                      }
                      return className;
                    };
                    
                    return (
                      <React.Fragment key={item.id || index}>
                        <tr className={getRowClassName()}>
                          {columns.map((column, colIndex) => {
                            let cellValue;
                            
                            if (column.key === '_index') {
                              // Use original position in items array for sorting, but display index as received order
                              cellValue = items.indexOf(item) + 1;
                            } else if (column.key === '_type') {
                              cellValue = item.properties ? item.properties.type : null;
                            } else if (item.properties) {
                              // First check if it's a direct property
                              if (item.properties[column.key] != null) {
                                cellValue = item.properties[column.key];
                              } else {
                                // Then check in nested objects
                                for (const propKey of Object.keys(item.properties)) {
                                  const propValue = item.properties[propKey];
                                  if (propValue && typeof propValue === 'object' && !Array.isArray(propValue)) {
                                    if (propValue[column.key] != null) {
                                      cellValue = propValue[column.key];
                                      break;
                                    }
                                  }
                                }
                              }
                            }
                            
                            return (
                              <td 
                                key={column.key} 
                                className={`${styles.cell} ${styles[`${column.type}Cell`] || ''}`}
                                data-label={column.label}
                                style={item._cluster && colIndex === 0 ? { borderLeft: `4px solid ${item._cluster.color}` } : {}}
                              >
                                <div className={styles.cellContent}>
                                  <div className={styles.cellValue}>
                                    {formatCellValue(cellValue, column.type)}
                                    {/* Add cluster badge to first column when clustering is active */}
                                    {colIndex === 0 && item._cluster && (
                                      <div className={styles.clusterBadge} style={{ backgroundColor: item._cluster.color }}>
                                        {item._cluster.name} ({item._cluster.position}/{item._cluster.total})
                                      </div>
                                    )}
                                    {/* Keep existing duplicate badge */}
                                    {colIndex === 0 && renderDuplicateBadge(item)}
                                  </div>
                                  {/* Add expand button to last column */}
                                  {colIndex === columns.length - 1 && renderExpandButton(item)}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                        {/* Render duplicate rows if expanded */}
                        {renderDuplicateRows(item)}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Rejected Items Section - Only show when clustering is disabled */}
          {!clusteringEnabled && showRejected && rejectedItems.length > 0 && (
            <div className={styles.rejectedSection}>
              <h3 className={styles.rejectedTitle}>
                🚫 Rejected Items ({rejectedItems.length})
              </h3>
              <div className={styles.tableContainer}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Rejection Reason</th>
                      <th>Item Name</th>
                      <th>URL</th>
                      <th>Details</th>
                      <th>Rejected At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rejectedItems.map((item, index) => {
                      const reasonLabels = {
                        'exact_match': 'Exact Match',
                        'fuzzy_match': 'Similar Name',
                        'cache_hit': 'Previously Seen',
                        'llm_duplicate': 'AI Detected Duplicate',
                        'near_duplicate': 'Vector Similarity',
                        // Enhanced entity rejection types
                        'exact_url_duplicate': 'Exact URL Match',
                        'normalized_title_duplicate': 'Identical Title',
                        'entity_llm_duplicate': 'AI Entity Duplicate'
                      };
                      
                      const reasonIcons = {
                        'exact_match': '🎯',
                        'fuzzy_match': '📊',
                        'cache_hit': '💾',
                        'llm_duplicate': '🤖',
                        'near_duplicate': '🔍',
                        // BULLETPROOF: New entity rejection icons  
                        'exact_url_duplicate': '🔗',
                        'normalized_title_duplicate': '🛡️',
                        'entity_llm_duplicate': '🧠'
                      };
                      
                      return (
                        <tr key={`rejected-${index}`} className={styles.rejectedRow}>
                          <td className={styles.reasonCell}>
                            {reasonIcons[item._rejectionReason]} {reasonLabels[item._rejectionReason]}
                          </td>
                          <td>
                            {item.properties?.company?.name || item.name || item.title || 'No name'}
                          </td>
                          <td className={styles.urlCell}>
                            {item.properties?.url ? (
                              <a href={item.properties.url} target="_blank" rel="noopener noreferrer">
                                {item.properties.url.replace('https://', '').substring(0, 30)}...
                              </a>
                            ) : (
                              'No URL'
                            )}
                          </td>
                          <td className={styles.detailsCell}>
                            {item._rejectionDetails}
                          </td>
                          <td className={styles.timeCell}>
                            {new Date(item._rejectedAt).toLocaleTimeString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
} 