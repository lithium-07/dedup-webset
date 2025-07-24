import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import Exa from 'exa-js';
import path from 'path';
import { fileURLToPath } from 'url';
import { DedupService } from './dedup/dedupService.js';
import { connectToMongoDB, getConnectionStatus } from './models/database.js';
import Webset from './models/Webset.js';
import Item from './models/Item.js';
import QueryHistory from './models/QueryHistory.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: 'http://localhost:3001', // Next.js frontend
    credentials: true
}));
app.use(express.json({ limit: '50mb' })); // Increased limit for large webset data
app.use(express.urlencoded({ limit: '50mb', extended: true }));

if (!process.env.EXA_API_KEY) {
    console.error('EXA_API_KEY is required in .env file');
    process.exit(1);
}

const exa = new Exa(process.env.EXA_API_KEY);

// Store active websets for streaming
const activeWebsets = new Map();

// Create webset endpoint
app.post('/api/websets', async (req, res) => {
    try {
        const { query, count = 10, entity, enrichments = [] } = req.body;

        const websetParams = {
            search: entity ? {
                query,
                count: parseInt(count),
                entity: {
                    type: "custom",
                    description: entity
                }
            }: {
                query,
                count: parseInt(count),
            }
        };

        if (enrichments.length > 0) {
            websetParams.enrichments = enrichments.map(e => ({
                description: e.description || 'Extract relevant information',
                format: e.format || 'text'
            }));
        }

        const webset = await exa.websets.create(websetParams);
        
        // Check if dedup is enabled via environment variable
        const dedupEnabled = process.env.ENABLE_DEDUP === 'true';

        // Create MongoDB record for this webset
        try {
            const websetDoc = new Webset({
                websetId: webset.id,
                originalQuery: query || '',
                entityType: entity || null,
                status: 'active'
            });
            await websetDoc.save();
            console.log(`📊 MongoDB: Created webset record ${webset.id}`);
        } catch (dbError) {
            console.error('⚠️ MongoDB: Failed to create webset record:', dbError);
            // Continue processing even if DB save fails
        }

        // Store the webset for streaming
        activeWebsets.set(webset.id, {
            id: webset.id,
            status: 'processing',
            items: [],
            processedItems: 0, // Track items actually sent to frontend
            rejectedItems: 0,  // Track items rejected by dedup
            clients: new Map(),
            nextCursor: null, // Track cursor for pagination
            dedup: dedupEnabled ? new DedupService((wid, msg) => {
                // Count items as they're broadcast to frontend
                if (msg.type === 'item') {
                    activeWebsets.get(wid).processedItems++;
                } else if (msg.type === 'rejected') {
                    activeWebsets.get(wid).rejectedItems++;
                }
                broadcastToClients(wid, msg);
            }, entity) : null
        });

        res.json({ websetId: webset.id });

        // Start polling for results
        pollWebsetResults(webset.id);

    } catch (error) {
        console.error('Error creating webset:', error);
        res.status(500).json({ error: error.message });
    }
});

// Server-sent events endpoint for streaming results
app.get('/api/websets/:id/stream', (req, res) => {
    const websetId = req.params.id;
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial message
    res.write(`data: ${JSON.stringify({ type: 'connected', websetId })}\n\n`);

    // Store client connection
    const clientId = Date.now();
    if (!activeWebsets.has(websetId)) {
        activeWebsets.set(websetId, { 
            id: websetId, 
            status: 'processing', 
            items: [], 
            clients: new Map(),
            nextCursor: null
        });
    }
    
    const websetData = activeWebsets.get(websetId);
    if (!websetData.clients) websetData.clients = new Map();
    websetData.clients.set(clientId, res);

    // Send existing items if any
    if (websetData.items.length > 0) {
        websetData.items.forEach(item => {
            res.write(`data: ${JSON.stringify({ type: 'item', item })}\n\n`);
        });
    }

    // Handle client disconnect
    req.on('close', () => {
        if (websetData.clients) {
            websetData.clients.delete(clientId);
        }
    });
});

// Function to poll webset results
async function pollWebsetResults(websetId) {
    try {
        const websetData = activeWebsets.get(websetId);
        
        // Use Exa's waitUntilIdle with custom polling
        await exa.websets.waitUntilIdle(websetId, {
            timeout: 3000000, // 50 minutes
            pollInterval: 3000, // 3 seconds
            onPoll: async (status) => {
                if (websetData) {
                    websetData.status = status;
                    broadcastToClients(websetId, { type: 'status', status });
                }

                // Get current items during polling using cursor pagination
                try {
                    await fetchAllItemsWithCursor(websetId, websetData);
                } catch (itemsError) {
                    console.error('Error fetching items during polling:', itemsError);
                }
            }
        });

        // Final status update - get final count using cursor pagination
        await fetchAllItemsWithCursor(websetId, websetData);
        
        // Mark webset as completed in MongoDB
        try {
            const websetDoc = await Webset.findOne({ websetId });
            if (websetDoc) {
                await websetDoc.markCompleted();
                console.log(`📊 MongoDB: Marked webset ${websetId} as completed`);
            }
        } catch (dbError) {
            console.error('⚠️ MongoDB: Failed to mark webset as completed:', dbError);
        }
        
        broadcastToClients(websetId, { 
            type: 'finished', 
            status: 'idle',
            totalItems: websetData.processedItems + websetData.rejectedItems
        });

    } catch (error) {
        console.error('Error polling webset:', error);
        broadcastToClients(websetId, { type: 'error', error: error.message });
    }
}

// Function to fetch all items using cursor pagination
async function fetchAllItemsWithCursor(websetId, websetData) {
    if (!websetData) return;

    let cursor = null;
    let hasMore = true;
    let totalFetched = 0;

    // Initialize cursor tracking if not exists
    if (!websetData.nextCursor) {
        websetData.nextCursor = null;
    }

    // Use the saved cursor to continue from where we left off
    cursor = websetData.nextCursor;

    while (hasMore) {
        try {
            const options = { limit: 100 };
            if (cursor) {
                options.cursor = cursor;
            }

            const itemsResponse = await exa.websets.items.list(websetId, options);
            
            if (itemsResponse.data && itemsResponse.data.length > 0) {
                const allItemIds = itemsResponse.data.map(item => item.id);
                const existingIds = websetData.items.map(item => item.id);
                const duplicateIds = allItemIds.filter(id => existingIds.includes(id));
                
                if (duplicateIds.length > 0) {
                    console.log(`📊 SERVER: Found ${duplicateIds.length} duplicate items from API:`, duplicateIds.slice(0, 3));
                }
                
                const newItems = itemsResponse.data.filter(item => 
                    !websetData.items.some(existing => existing.id === item.id)
                );

                console.log(`📊 SERVER: API returned ${itemsResponse.data.length} items, ${newItems.length} are new, ${duplicateIds.length} duplicates filtered`);

                if (newItems.length > 0) {
                    // Update status to show we're processing items
                    broadcastToClients(websetId, { 
                        type: 'status', 
                        status: 'processing_items',
                        itemCount: websetData.items.length + newItems.length
                    });

                    const dedup = websetData.dedup;
                    
                    for (const item of newItems) {
                        websetData.items.push(item);
                        
                        if (dedup) {
                            // Dedup service handles its own broadcasting via callback
                            try {
                                await dedup.ingest(websetId, item);
                            } catch (error) {
                                console.error(`Error processing item ${item.id} through dedup:`, error);
                                // If dedup fails, broadcast the item directly to avoid losing it
                                broadcastToClients(websetId, { type: 'item', item });
                            }
                        } else {
                            // No dedup - broadcast directly and count
                            websetData.processedItems++;
                            broadcastToClients(websetId, { type: 'item', item });
                        }
                    }
                }
                totalFetched += itemsResponse.data.length;
            }

            // Update pagination state
            hasMore = itemsResponse.hasMore || false;
            cursor = itemsResponse.nextCursor || null;
            websetData.nextCursor = cursor;

            // Break if no more pages
            if (!hasMore || !cursor) {
                break;
            }

        } catch (error) {
            console.error(`🔄 CURSOR: Error fetching page for webset ${websetId}:`, error);
            break; // Stop pagination on error
        }
    }
}

// Broadcast message to all clients listening to a webset
function broadcastToClients(websetId, message) {
    const websetData = activeWebsets.get(websetId);
    if (websetData && websetData.clients) {
        const clientCount = websetData.clients.size;
        
        websetData.clients.forEach((res, clientId) => {
            try {
                res.write(`data: ${JSON.stringify(message)}\n\n`);
            } catch (error) {
                console.error(`📡 BROADCAST: Error writing to client ${clientId}:`, error);
            }
        });
    } else {
        console.log(`📡 BROADCAST: No clients found for webset ${websetId}`, { 
            hasWebsetData: !!websetData, 
            hasClients: !!(websetData?.clients) 
        });
    }
}

// URL resolution statistics endpoint
app.get('/api/stats/url-resolution', (req, res) => {
    try {
        const stats = DedupService.getUrlResolutionStats();
        const isEnabled = process.env.ENABLE_URL_RESOLUTION === 'true';
        res.json({
            success: true,
            enabled: isEnabled,
            stats,
            description: isEnabled 
                ? "URL resolution cache statistics - shows how many URLs were resolved vs cached"
                : "URL resolution is disabled. Set ENABLE_URL_RESOLUTION=true to enable."
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Database status endpoint
app.get('/api/stats/database', (req, res) => {
    try {
        const status = getConnectionStatus();
        res.json({
            success: true,
            mongodb: status,
            description: status.isConnected 
                ? "MongoDB is connected and ready"
                : "MongoDB is not connected"
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Historical websets endpoint
app.get('/api/history/websets', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const websets = await Webset.getRecentWebsets(limit);
        res.json({
            success: true,
            websets,
            total: websets.length
        });
    } catch (error) {
        console.error('Error fetching websets:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get specific webset details
app.get('/api/history/websets/:websetId', async (req, res) => {
    try {
        const { websetId } = req.params;
        const webset = await Webset.findOne({ websetId });
        
        if (!webset) {
            return res.status(404).json({ error: 'Webset not found' });
        }

        // Get items for this webset
        const items = await Item.getItemsByWebset(websetId);
        const duplicateGroups = await Item.getDuplicateGroups(websetId);
        const rejectionStats = await Item.getRejectionStats(websetId);

        res.json({
            success: true,
            webset,
            items: {
                total: items.length,
                accepted: items.filter(item => item.status === 'accepted'),
                rejected: items.filter(item => item.status === 'rejected')
            },
            duplicateGroups,
            rejectionStats
        });
    } catch (error) {
        console.error('Error fetching webset details:', error);
        res.status(500).json({ error: error.message });
    }
});

// Overall statistics endpoint
app.get('/api/stats/overview', async (req, res) => {
    try {
        const stats = await Webset.getWebsetStats();
        res.json({
            success: true,
            stats: stats[0] || {
                totalWebsets: 0,
                totalItems: 0,
                totalUnique: 0,
                totalDuplicates: 0,
                avgDuplicationRate: 0
            }
        });
    } catch (error) {
        console.error('Error fetching overview stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy routes for semantic search service
app.post('/api/semantic/index', async (req, res) => {
    try {
        const response = await fetch('http://localhost:9001/index', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req.body)
        });

        if (!response.ok) {
            throw new Error(`Semantic service error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error proxying to semantic service:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/semantic/search', async (req, res) => {
    try {
        const response = await fetch('http://localhost:9001/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req.body)
        });

        if (!response.ok) {
            throw new Error(`Semantic service error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error proxying to semantic service:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/semantic/collections', async (req, res) => {
    try {
        const response = await fetch('http://localhost:9001/collections');

        if (!response.ok) {
            throw new Error(`Semantic service error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Error proxying to semantic service:', error);
        res.status(500).json({ error: error.message });
    }
});

// Query History Routes
app.post('/api/query-history', async (req, res) => {
    try {
        const {
            websetId,
            queryType,
            queryText,
            entityType,
            resultsMetadata,
            resultsSummary,
            sessionId
        } = req.body;

        // Validation
        if (!websetId || !queryType || !queryText) {
            return res.status(400).json({
                error: 'Missing required fields: websetId, queryType, queryText'
            });
        }

        if (!['clustering', 'semantic_search'].includes(queryType)) {
            return res.status(400).json({
                error: 'Invalid queryType. Must be "clustering" or "semantic_search"'
            });
        }

        // Create query history record
        const queryHistory = new QueryHistory({
            websetId,
            queryType,
            queryText: queryText.trim(),
            entityType: entityType || 'unknown',
            resultsMetadata: resultsMetadata || {},
            resultsSummary: resultsSummary || '',
            sessionId: sessionId || null,
            userAgent: req.get('User-Agent'),
            ipAddress: req.ip || req.connection.remoteAddress
        });

        const savedQuery = await queryHistory.save();
        console.log(`📝 Query history saved: ${queryType} - "${queryText}" for webset ${websetId}`);

        res.status(201).json({
            success: true,
            queryId: savedQuery.queryId,
            message: 'Query saved to history'
        });

    } catch (error) {
        console.error('Error saving query history:', error);
        res.status(500).json({
            error: 'Failed to save query history',
            details: error.message
        });
    }
});

app.get('/api/query-history', async (req, res) => {
    try {
        const { websetId, queryType, limit = 20 } = req.query;
        const limitNum = Math.min(parseInt(limit) || 20, 100); // Cap at 100

        let query = {};
        if (websetId) query.websetId = websetId;
        if (queryType) query.queryType = queryType;

        const queries = await QueryHistory.find(query)
            .sort({ createdAt: -1 })
            .limit(limitNum)
            .select('queryId websetId queryType queryText entityType resultsMetadata status resultsSummary createdAt');

        res.json({
            success: true,
            queries,
            total: queries.length,
            filters: { websetId, queryType, limit: limitNum }
        });

    } catch (error) {
        console.error('Error fetching query history:', error);
        res.status(500).json({
            error: 'Failed to fetch query history',
            details: error.message
        });
    }
});

app.get('/api/query-history/stats', async (req, res) => {
    try {
        const { websetId } = req.query;

        const stats = await QueryHistory.getQueryStats(websetId);
        const topQueries = await QueryHistory.getTopQueries(null, 5);

        // Calculate overall statistics
        const overallStats = await QueryHistory.aggregate([
            ...(websetId ? [{ $match: { websetId } }] : []),
            {
                $group: {
                    _id: null,
                    totalQueries: { $sum: 1 },
                    avgProcessingTime: { $avg: '$resultsMetadata.processingTimeMs' },
                    successRate: {
                        $avg: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
                    },
                    totalItemsProcessed: { $sum: '$resultsMetadata.itemsProcessed' },
                    totalClustersFound: { $sum: '$resultsMetadata.clustersFound' }
                }
            }
        ]);

        res.json({
            success: true,
            stats: {
                byType: stats,
                overall: overallStats[0] || {
                    totalQueries: 0,
                    avgProcessingTime: 0,
                    successRate: 0,
                    totalItemsProcessed: 0,
                    totalClustersFound: 0
                },
                topQueries
            },
            websetId
        });

    } catch (error) {
        console.error('Error fetching query stats:', error);
        res.status(500).json({
            error: 'Failed to fetch query statistics',
            details: error.message
        });
    }
});

// Initialize MongoDB connection and start server
const startServer = async () => {
    try {
        // Connect to MongoDB
        await connectToMongoDB();
        
        // Start the Express server
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`📊 URL Resolution Stats: http://localhost:${PORT}/api/stats/url-resolution`);
            console.log(`📊 Database Status: http://localhost:${PORT}/api/stats/database`);
        });
    } catch (error) {
        console.error('💥 Failed to start server:', error);
        process.exit(1);
    }
};

startServer(); 