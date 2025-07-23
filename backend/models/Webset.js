import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const websetSchema = new mongoose.Schema({
  websetId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    default: () => uuidv4()
  },
  originalQuery: {
    type: String,
    default: ''
  },
  entityType: {
    type: String,
    default: 'unknown',
    validate: {
      validator: function(v) {
        return v === null || v.length > 0;
      },
      message: 'Entity type cannot be an empty string'
    }
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'error'],
    default: 'active'
  },
  totalItems: {
    type: Number,
    default: 0,
    min: 0
  },
  uniqueItems: {
    type: Number,
    default: 0,
    min: 0
  },
  duplicatesRejected: {
    type: Number,
    default: 0,
    min: 0
  },
  rejectionReasons: {
    type: Map,
    of: Number,
    default: () => new Map(),
    validate: {
      validator: function(v) {
        return v instanceof Map;
      },
      message: 'Rejection reasons must be a Map'
    }
  },
  processingTimeMs: {
    type: Number,
    default: 0,
    min: 0
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  completedAt: {
    type: Date,
    default: null
  },
  errorMessage: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  collection: 'websets'
});

websetSchema.index({ createdAt: -1 });
websetSchema.index({ status: 1, createdAt: -1 });
websetSchema.index({ entityType: 1, createdAt: -1 });

websetSchema.methods.incrementTotalItems = function() {
  this.totalItems += 1;
  return this.save();
};

websetSchema.methods.incrementUniqueItems = function() {
  this.uniqueItems += 1;
  return this.save();
};

websetSchema.methods.incrementDuplicatesRejected = function(reason) {
  this.duplicatesRejected += 1;
  const currentCount = this.rejectionReasons.get(reason) || 0;
  this.rejectionReasons.set(reason, currentCount + 1);
  return this.save();
};

websetSchema.methods.markCompleted = function() {
  this.status = 'completed';
  this.completedAt = new Date();
  return this.save();
};

websetSchema.methods.markError = function(errorMessage) {
  this.status = 'error';
  this.errorMessage = errorMessage;
  return this.save();
};

websetSchema.statics.getRecentWebsets = function(limit = 10) {
  return this.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('websetId originalQuery entityType status totalItems uniqueItems duplicatesRejected createdAt');
};

websetSchema.statics.getWebsetStats = function() {
  return this.aggregate([
    {
      $group: {
        _id: null,
        totalWebsets: { $sum: 1 },
        totalItems: { $sum: '$totalItems' },
        totalUnique: { $sum: '$uniqueItems' },
        totalDuplicates: { $sum: '$duplicatesRejected' },
        avgDuplicationRate: { 
          $avg: { 
            $cond: [
              { $gt: ['$totalItems', 0] },
              { $divide: ['$duplicatesRejected', '$totalItems'] },
              0
            ]
          }
        }
      }
    }
  ]);
};

export default mongoose.model('Webset', websetSchema); 