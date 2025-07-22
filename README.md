# Exa Websets Streaming Demo

A Next.js frontend with Express backend that demonstrates real-time streaming of Exa websets results using Server-Sent Events.

## Features

- 🔍 **Interactive Query Interface**: Create websets with custom search queries and enrichments
- 📊 **Real-time Streaming Table**: Watch results populate in real-time as they're processed by Exa
- 🎯 **Enrichments Support**: Add custom enrichments to extract specific data from results
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
   ```

3. **Start the application**:
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