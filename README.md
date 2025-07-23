# Exa Websets Streaming Demo

A Next.js frontend with Express backend that demonstrates real-time streaming of Exa websets results using Server-Sent Events.

## Features

- 🔍 **Interactive Query Interface**: Create websets with custom search queries and enrichments
- 📊 **Real-time Streaming Table**: Watch results populate in real-time as they're processed by Exa
- 🎯 **Enrichments Support**: Add custom enrichments to extract specific data from results
- 🧠 **Smart Deduplication**: Optional AI-powered duplicate detection with rejected items transparency
- 📱 **Responsive Design**: Works seamlessly on desktop and mobile devices
- ⚡ **Server-Sent Events**: Efficient real-time updates without polling

## Architecture

- **Frontend**: Next.js with React components
- **Backend**: Express.js server with Exa API integration
- **Real-time Communication**: Server-Sent Events (SSE)
- **Styling**: CSS Modules with modern responsive design

## Prerequisites

- Node.js 16+ 
- Exa API key (get one from [Exa Dashboard](https://docs.exa.ai/websets/api/get-started))

## Setup

1. **Clone and install dependencies**:
   ```bash
   npm install
   ```

2. **Create `.env` file** in the root directory:
   ```bash
   EXA_API_KEY=your_exa_api_key_here
   GOOGLE_API_KEY=your_google_ai_api_key_here  # Required for deduplication
   PORT=3000
   ENABLE_DEDUP=false  # Set to 'true' to enable intelligent deduplication
   VECTOR_URL=http://localhost:7000  # Optional: Vector service URL
   ```

3. **Setup Vector Service** (required for deduplication):
   ```bash
   cd vector-service
   pip install -r requirements.txt
   python app.py &  # Runs on port 7000
   cd ..
   ```

4. **Start the application**:
   ```bash
   npm run dev
   ```

   This will start:
   - Backend API server on `http://localhost:3000`
   - Next.js frontend on `http://localhost:3001`

## Usage

1. **Open your browser** to `http://localhost:3001`

2. **Create a webset query**:
   - Enter your search query (e.g., "Top AI research labs focusing on large language models")
   - Set the number of results you want
   - Optionally add enrichments to extract specific data

3. **Watch results stream in**: 
   - The table will populate in real-time as Exa processes your webset
   - Status indicator shows current processing state
   - New rows appear with smooth animations as results arrive

## 🧠 Intelligent Deduplication (Optional)

Set `ENABLE_DEDUP=true` in your `.env` file to activate AI-powered duplicate detection:

### How It Works:
- **Tier 0**: Exact domain/brand matches → instant rejection
- **Tier 1**: Fuzzy name matching (90% Jaro-Winkler threshold) → instant rejection  
- **Tier 2**: Ambiguous cases → Google Gemini LLM verification

### Visual Feedback:
- 🔄 **Pending**: Yellow background with spinner (LLM verification in progress)
- ✅ **Confirmed**: Blue background with checkmark (confirmed unique)
- ❌ **Rejected**: Items filtered out are collected in a separate "Rejected Items" view
- 🚫 **Rejected Items View**: Toggle to show/hide filtered items with detailed rejection reasons

### Rejected Items Tracking:
- 🎯 **Exact Match**: Same domain/brand combination
- 📊 **Similar Name**: High fuzzy matching score (>95% similarity)  
- 💾 **Previously Seen**: Cached LLM decision from earlier comparison
- 🤖 **AI Detected Duplicate**: Google Gemini determined items are duplicates
- 🔍 **Vector Similarity**: Semantic similarity detected via embeddings (FAISS + Sentence Transformers)

### Performance:
- Items process in <20ms for clear cases
- LLM batching (25 items, 300ms timeout) for ambiguous cases
- Real-time status updates via Server-Sent Events

**Note**: Requires `GOOGLE_API_KEY` for LLM verification. Disable if you want all results without filtering.

## API Endpoints

### Backend API (Port 3000)

- `POST /api/websets`: Create a new webset
- `GET /api/websets/:id/stream`: Server-Sent Events endpoint for streaming results

## Components

- **WebsetQueryForm**: Form interface for creating websets
- **StreamingResultsTable**: Real-time table displaying webset results
- **Backend Server**: Express server handling Exa API integration and SSE

## Development

### Frontend only:
```bash
npm run frontend
```

### Backend only:
```bash
npm run backend
```

### Both (recommended):
```bash
npm run dev
```

## Project Structure

```
├── backend/
│   ├── server.js          # Express server with Exa integration
│   └── package.json       # Backend-specific config
├── pages/
│   ├── index.js          # Main Next.js page
│   └── _app.js           # App wrapper with global styles
├── components/
│   ├── WebsetQueryForm.js           # Query form component
│   ├── StreamingResultsTable.js    # Streaming table component
│   └── *.module.css                # Component styles
├── styles/
│   ├── globals.css       # Global styles
│   └── Home.module.css   # Homepage styles
├── package.json          # Main project config
└── next.config.js        # Next.js configuration
```

## Technologies Used

- **Next.js** - React framework for the frontend
- **Express.js** - Backend API server
- **Server-Sent Events** - Real-time streaming communication
- **Exa API** - Websets search and enrichment
- **CSS Modules** - Scoped styling

## Notes

- The application polls the Exa API every 5 seconds to check for new results
- Results are streamed to the frontend via Server-Sent Events
- The table automatically updates with smooth animations as new items arrive
- Mobile-responsive design ensures good experience across devices 