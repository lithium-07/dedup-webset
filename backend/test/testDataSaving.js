import { DedupService } from '../dedup/dedupService.js';
import mongoose from 'mongoose';
import { connectToMongoDB } from '../models/database.js';
import Webset from '../models/Webset.js';
import Item from '../models/Item.js';

// Test broadcast function that logs messages
const broadcast = (websetId, message) => {
  console.log(`[BROADCAST] ${websetId}:`, message);
};

async function runTests() {
  try {
    // Connect to MongoDB
    console.log('🔄 Connecting to MongoDB...');
    await connectToMongoDB();
    
    // Clean up test data
    console.log('🧹 Cleaning up old test data...');
    await Item.deleteMany({});
    await Webset.deleteMany({});
    
    console.log('🧪 Starting data saving tests...');
    
    // Create test webset
    const websetId = 'test_webset_' + Date.now();
    const webset = new Webset({
      websetId,
      originalQuery: 'test query',
      entityType: 'movie'
    });
    await webset.save();
    console.log('✅ Created test webset:', websetId);
    
    // Initialize dedup service
    const dedupService = new DedupService(broadcast, 'movie');
    
    // Test Case 1: Complete valid item
    console.log('\n🧪 Test Case 1: Complete valid item');
    const validItem = {
      id: 'test_item_1',
      title: 'The Matrix',
      url: 'https://example.com/matrix',
      properties: {
        year: 1999,
        director: 'Wachowski Sisters'
      }
    };
    await dedupService.ingest(websetId, validItem);
    
    // Test Case 2: Missing ID
    console.log('\n🧪 Test Case 2: Missing ID');
    const noIdItem = {
      title: 'Inception',
      url: 'https://example.com/inception'
    };
    await dedupService.ingest(websetId, noIdItem);
    
    // Test Case 3: Missing title/name but has URL
    console.log('\n🧪 Test Case 3: Missing title/name');
    const noTitleItem = {
      id: 'test_item_3',
      url: 'https://movies.example.com/interstellar'
    };
    await dedupService.ingest(websetId, noTitleItem);
    
    // Test Case 4: Minimal data
    console.log('\n🧪 Test Case 4: Minimal data');
    const minimalItem = {
      id: 'test_item_4'
    };
    await dedupService.ingest(websetId, minimalItem);
    
    // Test Case 5: Null/undefined fields
    console.log('\n🧪 Test Case 5: Null/undefined fields');
    const nullFieldsItem = {
      id: 'test_item_5',
      title: null,
      url: undefined,
      properties: {
        year: null,
        rating: undefined
      }
    };
    await dedupService.ingest(websetId, nullFieldsItem);
    
    // Test Case 6: Invalid URL
    console.log('\n🧪 Test Case 6: Invalid URL');
    const invalidUrlItem = {
      id: 'test_item_6',
      title: 'Bad URL Movie',
      url: 'not-a-url'
    };
    await dedupService.ingest(websetId, invalidUrlItem);
    
    // Test Case 7: Nested title/name
    console.log('\n🧪 Test Case 7: Nested title/name');
    const nestedItem = {
      id: 'test_item_7',
      properties: {
        movie: {
          title: 'Nested Movie Title'
        }
      }
    };
    await dedupService.ingest(websetId, nestedItem);
    
    // Wait a bit for async operations to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify saved data
    console.log('\n📊 Verifying saved data...');
    const savedItems = await Item.find({ websetId });
    console.log(`Found ${savedItems.length} saved items:`);
    savedItems.forEach(item => {
      console.log(`\n📝 Item ${item.itemId}:`);
      console.log('  Name:', item.name);
      console.log('  URL:', item.url);
      console.log('  Status:', item.status);
      console.log('  Properties:', JSON.stringify(item.properties, null, 2));
    });
    
    // Verify webset counters
    const updatedWebset = await Webset.findOne({ websetId });
    console.log('\n📊 Webset counters:');
    console.log('  Total items:', updatedWebset.totalItems);
    console.log('  Unique items:', updatedWebset.uniqueItems);
    console.log('  Duplicates rejected:', updatedWebset.duplicatesRejected);
    
    console.log('\n✅ Tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Clean up
    await mongoose.connection.close();
  }
}

// Run tests
runTests(); 