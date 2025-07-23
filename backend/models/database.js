import mongoose from 'mongoose';

let isConnected = false;

export const connectToMongoDB = async () => {
  if (isConnected) {
    console.log('📊 MongoDB: Already connected');
    return;
  }

  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/exa_dedupe';
    
    console.log('📊 MongoDB: Connecting to database...');
    
    await mongoose.connect(mongoUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });

    isConnected = true;
    console.log('✅ MongoDB: Connected successfully');
    
    mongoose.connection.on('error', (error) => {
      console.error('❌ MongoDB: Connection error:', error);
      isConnected = false;
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ MongoDB: Disconnected');
      isConnected = false;
    });
    
    mongoose.connection.on('reconnected', () => {
      console.log('🔄 MongoDB: Reconnected');
      isConnected = true;
    });

  } catch (error) {
    console.error('❌ MongoDB: Connection failed:', error);
    throw error;
  }
};

export const disconnectFromMongoDB = async () => {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    console.log('📊 MongoDB: Disconnected');
  } catch (error) {
    console.error('❌ MongoDB: Disconnect error:', error);
    throw error;
  }
};

export const getConnectionStatus = () => {
  return {
    isConnected,
    readyState: mongoose.connection.readyState,
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name
  };
}; 