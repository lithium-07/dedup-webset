import express from 'express';
import QueryHistory from '../models/QueryHistory.js';
import { connectToMongoDB } from '../models/database.js';

const router = express.Router();

// Middleware to ensure database connection
router.use(async (req, res, next) => {
  try {
    await connectToMongoDB();
    next();
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// POST /api/query-history - Save a new query
router.post('/', async (req, res) => {
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

// GET /api/query-history - Get query history (optionally filtered by websetId)
router.get('/', async (req, res) => {
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

// GET /api/query-history/stats - Get query statistics
router.get('/stats', async (req, res) => {
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

// GET /api/query-history/:queryId - Get specific query details
router.get('/:queryId', async (req, res) => {
  try {
    const { queryId } = req.params;

    const query = await QueryHistory.findOne({ queryId });
    if (!query) {
      return res.status(404).json({
        error: 'Query not found'
      });
    }

    res.json({
      success: true,
      query
    });

  } catch (error) {
    console.error('Error fetching query details:', error);
    res.status(500).json({
      error: 'Failed to fetch query details',
      details: error.message
    });
  }
});

// PUT /api/query-history/:queryId - Update query results
router.put('/:queryId', async (req, res) => {
  try {
    const { queryId } = req.params;
    const { resultsMetadata, resultsSummary, status, errorMessage } = req.body;

    const query = await QueryHistory.findOne({ queryId });
    if (!query) {
      return res.status(404).json({
        error: 'Query not found'
      });
    }

    // Update the query with results
    if (resultsMetadata) {
      query.resultsMetadata = { ...query.resultsMetadata, ...resultsMetadata };
    }
    if (resultsSummary !== undefined) {
      query.resultsSummary = resultsSummary;
    }
    if (status) {
      query.status = status;
    }
    if (errorMessage) {
      query.errorMessage = errorMessage;
    }

    const updatedQuery = await query.save();
    console.log(`📝 Query history updated: ${queryId}`);

    res.json({
      success: true,
      query: updatedQuery,
      message: 'Query updated successfully'
    });

  } catch (error) {
    console.error('Error updating query history:', error);
    res.status(500).json({
      error: 'Failed to update query history',
      details: error.message
    });
  }
});

// DELETE /api/query-history/:queryId - Delete a specific query
router.delete('/:queryId', async (req, res) => {
  try {
    const { queryId } = req.params;

    const deletedQuery = await QueryHistory.findOneAndDelete({ queryId });
    if (!deletedQuery) {
      return res.status(404).json({
        error: 'Query not found'
      });
    }

    console.log(`🗑️ Query history deleted: ${queryId}`);
    res.json({
      success: true,
      message: 'Query deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting query history:', error);
    res.status(500).json({
      error: 'Failed to delete query history',
      details: error.message
    });
  }
});

// DELETE /api/query-history - Clear all query history (optionally filtered)
router.delete('/', async (req, res) => {
  try {
    const { websetId, queryType, confirm } = req.query;

    // Safety check - require explicit confirmation
    if (confirm !== 'true') {
      return res.status(400).json({
        error: 'Missing confirmation. Add ?confirm=true to proceed with deletion.'
      });
    }

    let query = {};
    if (websetId) query.websetId = websetId;
    if (queryType) query.queryType = queryType;

    const result = await QueryHistory.deleteMany(query);
    console.log(`🗑️ Deleted ${result.deletedCount} query history records`);

    res.json({
      success: true,
      deletedCount: result.deletedCount,
      message: `Deleted ${result.deletedCount} query history records`
    });

  } catch (error) {
    console.error('Error clearing query history:', error);
    res.status(500).json({
      error: 'Failed to clear query history',
      details: error.message
    });
  }
});

export default router; 