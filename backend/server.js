import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import Exa from 'exa-js';
import path from 'path';
import { fileURLToPath } from 'url';
import { DedupService } from './dedup/dedupService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: 'http://localhost:3001', // Next.js frontend
    credentials: true
}));
app.use(express.json());

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

        // Store the webset for streaming
        activeWebsets.set(webset.id, {
            id: webset.id,
            status: 'processing',
            items: [],
            clients: new Map(),
            nextCursor: null, // Track cursor for pagination
            dedup: dedupEnabled ? new DedupService((wid, msg) => broadcastToClients(wid, msg), entity) : null
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
        broadcastToClients(websetId, { 
            type: 'finished', 
            status: 'idle',
            totalItems: websetData.items.length
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
                const newItems = itemsResponse.data.filter(item => 
                    !websetData.items.some(existing => existing.id === item.id)
                );

                if (newItems.length > 0) {
                    const dedup = websetData.dedup;
                    
                    for (const item of newItems) {
                        websetData.items.push(item);
                        
                        if (dedup) {
                            // Dedup service handles its own broadcasting via callback
                            const dedupStart = Date.now();
                            await dedup.ingest(websetId, item);
                        } else {
                            // No dedup - broadcast directly
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

app.listen(PORT, () => {
}); 