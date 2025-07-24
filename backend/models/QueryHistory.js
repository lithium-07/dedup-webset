import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const queryHistorySchema = new mongoose.Schema({
  queryId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => uuidv4()
  },
  websetId: {
    type: String,
    required: true,
    index: true,
    ref: 'Webset'
  },
  queryType: {
    type: String,
    required: true,
    enum: ['clustering', 'semantic_search'],
    index: true
  },
  queryText: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  entityType: {
    type: String,
    default: 'unknown'
  },
  // Results metadata
  resultsMetadata: {
    itemsProcessed: {
      type: Number,
      default: 0,
      min: 0
    },
    clustersFound: {
      type: Number,
      default: 0,
      min: 0
    },
    relevantItems: {
      type: Number,
      default: 0,
      min: 0
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 1
    },
    processingTimeMs: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  // Query execution status
  status: {
    type: String,
    enum: ['success', 'error', 'partial'],
    default: 'success'
  },
  errorMessage: {
    type: String,
    default: null
  },
  // Store a summary of results for history display
  resultsSummary: {
    type: String,
    default: '',
    maxlength: 500
  },
  // Session context (for future user management)
  sessionId: {
    type: String,
    default: null,
    index: true
  },
  userAgent: {
    type: String,
    default: null
  },
  ipAddress: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  collection: 'query_history'
});

// Indexes for efficient querying
queryHistorySchema.index({ websetId: 1, createdAt: -1 });
queryHistorySchema.index({ queryType: 1, createdAt: -1 });
queryHistorySchema.index({ createdAt: -1 });
queryHistorySchema.index({ websetId: 1, queryType: 1, createdAt: -1 });

// Static methods
queryHistorySchema.statics.getRecentQueries = function(websetId = null, limit = 20) {
  const query = websetId ? { websetId } : {};
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('queryId websetId queryType queryText entityType resultsMetadata status resultsSummary createdAt');
};

queryHistorySchema.statics.getQueryStats = function(websetId = null) {
  const matchStage = websetId ? { $match: { websetId } } : { $match: {} };
  
  return this.aggregate([
    matchStage,
    {
      $group: {
        _id: '$queryType',
        totalQueries: { $sum: 1 },
        successfulQueries: {
          $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
        },
        avgProcessingTime: { $avg: '$resultsMetadata.processingTimeMs' },
        totalItemsProcessed: { $sum: '$resultsMetadata.itemsProcessed' },
        totalClustersFound: { $sum: '$resultsMetadata.clustersFound' }
      }
    }
  ]);
};

queryHistorySchema.statics.getTopQueries = function(queryType = null, limit = 10) {
  const matchStage = queryType ? { $match: { queryType } } : { $match: {} };
  
  return this.aggregate([
    matchStage,
    {
      $group: {
        _id: '$queryText',
        count: { $sum: 1 },
        lastUsed: { $max: '$createdAt' },
        avgProcessingTime: { $avg: '$resultsMetadata.processingTimeMs' },
        successRate: {
          $avg: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
        }
      }
    },
    {
      $sort: { count: -1, lastUsed: -1 }
    },
    {
      $limit: limit
    }
  ]);
};

// Instance methods
queryHistorySchema.methods.markError = function(errorMessage) {
  this.status = 'error';
  this.errorMessage = errorMessage;
  return this.save();
};

queryHistorySchema.methods.updateResults = function(metadata, summary = '') {
  this.resultsMetadata = { ...this.resultsMetadata, ...metadata };
  this.resultsSummary = summary;
  this.status = 'success';
  return this.save();
};

export default mongoose.model('QueryHistory', queryHistorySchema); 