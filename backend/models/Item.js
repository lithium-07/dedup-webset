import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const itemSchema = new mongoose.Schema({
  websetId: {
    type: String,
    required: true,
    index: true
  },
  itemId: {
    type: String,
    default: function() { return uuidv4(); }, // Generate UUID if missing
    index: true
  },
  name: {
    type: String,
    default: function() { 
      return this.url || this.itemId || 'Unknown Item';
    },
    index: true
  },
  url: {
    type: String,
    default: ''
  },
  properties: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  rawData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['accepted', 'rejected', 'pending'],
    default: 'pending',
    index: true
  },
  rejectedBy: {
    type: String,
    default: null,
    index: true
  },
  rejectionReason: {
    type: String,
    default: null,
    index: true
  },
  rejectionMessage: {
    type: String,
    default: null
  },
  normalizedTitle: {
    type: String,
    default: '',
    index: true
  },
  similarity: {
    jaroWinkler: Number,
    vectorSimilarity: Number
  },
  processingTimeMs: {
    type: Number,
    default: 0
  },
  layersProcessed: [{
    layer: String,
    result: String,
    timeMs: Number
  }],
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  collection: 'items'
});

itemSchema.index({ websetId: 1, status: 1 });
itemSchema.index({ websetId: 1, createdAt: 1 });
itemSchema.index({ normalizedTitle: 1, websetId: 1 });
itemSchema.index({ rejectedBy: 1 });
itemSchema.index({ rejectionReason: 1, websetId: 1 });

itemSchema.methods.markAccepted = function() {
  this.status = 'accepted';
  return this.save();
};

itemSchema.methods.markRejected = function(rejectedByItemId, reason, message, similarity = {}) {
  this.status = 'rejected';
  this.rejectedBy = rejectedByItemId;
  this.rejectionReason = reason;
  this.rejectionMessage = message;
  
  if (similarity.jaroWinkler !== undefined) {
    this.similarity.jaroWinkler = similarity.jaroWinkler;
  }
  if (similarity.vectorSimilarity !== undefined) {
    this.similarity.vectorSimilarity = similarity.vectorSimilarity;
  }
  
  return this.save();
};

itemSchema.methods.addProcessingLayer = function(layer, result, timeMs) {
  this.layersProcessed.push({
    layer,
    result,
    timeMs
  });
  return this.save();
};

itemSchema.statics.getItemsByWebset = function(websetId, status = null) {
  const query = { websetId };
  if (status) {
    query.status = status;
  }
  return this.find(query).sort({ createdAt: 1 });
};

itemSchema.statics.getDuplicateGroups = function(websetId) {
  return this.aggregate([
    { $match: { websetId, status: 'accepted' } },
    {
      $lookup: {
        from: 'items',
        localField: 'itemId',
        foreignField: 'rejectedBy',
        as: 'duplicates'
      }
    },
    {
      $match: {
        'duplicates.0': { $exists: true }
      }
    },
    {
      $project: {
        itemId: 1,
        name: 1,
        url: 1,
        duplicateCount: { $size: '$duplicates' },
        duplicates: {
          $map: {
            input: '$duplicates',
            as: 'dup',
            in: {
              itemId: '$$dup.itemId',
              name: '$$dup.name',
              url: '$$dup.url',
              rejectionReason: '$$dup.rejectionReason',
              rejectionMessage: '$$dup.rejectionMessage',
              similarity: '$$dup.similarity'
            }
          }
        }
      }
    },
    { $sort: { duplicateCount: -1 } }
  ]);
};

itemSchema.statics.getRejectionStats = function(websetId) {
  return this.aggregate([
    { $match: { websetId, status: 'rejected' } },
    {
      $group: {
        _id: '$rejectionReason',
        count: { $sum: 1 },
        avgJaroWinkler: { $avg: '$similarity.jaroWinkler' },
        avgVectorSimilarity: { $avg: '$similarity.vectorSimilarity' }
      }
    },
    { $sort: { count: -1 } }
  ]);
};

export default mongoose.model('Item', itemSchema); 