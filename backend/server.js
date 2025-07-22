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
        const { query, count = 10, enrichments = [] } = req.body;

        const websetParams = {
            search: {
                query,
                count: parseInt(count)
            }
        };

        if (enrichments.length > 0) {
            websetParams.enrichments = enrichments.map(e => ({
                description: e.description || 'Extract relevant information',
                format: e.format || 'text'
            }));
        }

        const webset = await exa.websets.create(websetParams);
        
        // Store the webset for streaming
        activeWebsets.set(webset.id, {
            id: webset.id,
            status: 'processing',
            items: [],
            // clients: new Map(),
            // dedup: new DedupService((wid, msg) => broadcastToClients(wid, msg))
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
        activeWebsets.set(websetId, { id: websetId, status: 'processing', items: [], clients: new Map() });
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
            timeout: 300000, // 5 minutes
            pollInterval: 3000, // 3 seconds
            onPoll: async (status) => {
                console.log(`Webset ${websetId} status: ${status}`);
                
                if (websetData) {
                    websetData.status = status;
                    broadcastToClients(websetId, { type: 'status', status });
                }

                // Get current items during polling
                try {
                    const itemsResponse = await exa.websets.items.list(websetId, { limit: 100 });
                    
                    if (websetData && itemsResponse.data) {
                        const newItems = itemsResponse.data.filter(item => 
                            !websetData.items.some(existing => existing.id === item.id)
                        );

                        // Add new items and broadcast them
                        const dedup = websetData.dedup;

                        for (const item of newItems) {
                            websetData.items.push(item);
                            await dedup.ingest(websetId, item);
                        }
                    }
                } catch (itemsError) {
                    console.error('Error fetching items during polling:', itemsError);
                }
            }
        });

        // Final status update
        const finalItems = await exa.websets.items.list(websetId, { limit: 100 });
        broadcastToClients(websetId, { 
            type: 'finished', 
            status: 'idle',
            totalItems: finalItems.data.length
        });

    } catch (error) {
        console.error('Error polling webset:', error);
        broadcastToClients(websetId, { type: 'error', error: error.message });
    }
}

// Broadcast message to all clients listening to a webset
function broadcastToClients(websetId, message) {
    const websetData = activeWebsets.get(websetId);
    if (websetData && websetData.clients) {
        websetData.clients.forEach(res => {
            try {
                res.write(`data: ${JSON.stringify(message)}\n\n`);
            } catch (error) {
                console.error('Error writing to client:', error);
            }
        });
    }
}

app.listen(PORT, () => {
    console.log(`Backend API server running on http://localhost:${PORT}`);
    console.log('Make sure your EXA_API_KEY is set in the .env file');
}); 