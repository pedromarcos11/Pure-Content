# Pure Content 🎯

**Because your friends won't stop sending you Instagram links, but you're trying to stay focused.**

A distraction-free Instagram viewer for those of us who quit social media but still want to see what our friends are sharing. No feed, no stories, no algorithm trying to steal your attention—just the content you actually want to see.

## The Problem

You deleted Instagram to focus on your life. Your friends keep sending you reels and posts. Opening Instagram feels like opening Pandora's box—suddenly you're scrolling for 2 hours and forgot why you opened the app in the first place. 😅

## The Solution

**Pure Content** lets you view Instagram posts and reels without all the noise. Just paste a link, see the content, and move on with your life. No account needed, no distractions, no regrets.

### Why?

- ✅ **No Instagram account required** - Just paste and view
- ✅ **No feed to get lost in** - See only what you want
- ✅ **No algorithm** - No suggestions, no "you might like"
- ✅ **No notifications** - Your phone stays quiet
- ✅ **Full quality** - High-res images and videos with audio
- ✅ **Works everywhere** - Desktop, mobile, PWA support

## Features

- 🎨 **Beautiful UI**: Modern glassmorphism design that doesn't distract
- 📱 **Works with Everything**: Posts, reels, IGTV—all supported
- 🎬 **Full Quality**: High-resolution images and videos with audio
- ⚡ **Fast & Simple**: Paste link → See content → Done
- 🔒 **Privacy First**: No accounts, no tracking, no data collection
- 🚀 **Easy Deploy**: Docker-ready, works on Railway with zero config
- 🛡️ **Rate Limited**: Protects against abuse (10 req/min per IP)

## Setup

### Option 1: Docker (Recommended)

**Build and run with Docker Compose:**

```bash
docker-compose up --build
```

**Then open in your browser:**
```
http://localhost:3000
```

**Or build manually:**

```bash
docker build -t social-media-viewer .
docker run -p 3000:3000 -e BASE_URL=http://localhost:3000 social-media-viewer
```

### Option 2: Local Development

**Prerequisites:**
- Node.js 20+
- FFmpeg installed (`brew install ffmpeg` on macOS)

**Install Dependencies:**

```bash
npm install
```

**Run Locally:**

```bash
npm start
```

**Then open in your browser:**
```
http://localhost:3000
```

The server serves both the frontend UI and the API.

## API Endpoints

### Health Check
```
GET /health
```

Returns server status.

### Fetch Content
```
POST /api/fetch-content
Content-Type: application/json

{
  "url": "https://www.instagram.com/p/..."
}
```

Returns:
```json
{
  "mediaUrl": "https://...",
  "thumbnailUrl": "https://...",
  "caption": "Post caption",
  "author": "username",
  "mediaType": "video|image",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Deploy to Railway

### Step 1: Push to GitHub

```bash
git add .
git commit -m "Add Docker support for Railway"
git push
```

### Step 2: Deploy on Railway

1. Go to [Railway](https://railway.app)
2. Create new project → Deploy from GitHub
3. Select your repository
4. Set root directory to `backend`
5. Railway will automatically detect the Dockerfile
6. Add environment variable:
   - `BASE_URL` = `https://${{RAILWAY_PUBLIC_DOMAIN}}`
7. Deploy!

Railway will automatically:
- Build the Docker image with ffmpeg and chromium
- Set the PORT variable
- Provide HTTPS URL
- Serve both frontend and backend

### Step 3: Access Your App

Once deployed, simply open your Railway URL:
```
https://your-app.railway.app
```

That's it! The frontend automatically detects the API URL, so no manual configuration needed.

## Environment Variables

- `PORT` - Server port (default: 3000) - **Set by Railway automatically**
- `BASE_URL` - Base URL for serving merged videos (e.g., `https://your-app.railway.app`)
- `NODE_ENV` - Environment (production/development)
- `PUPPETEER_EXECUTABLE_PATH` - Path to chromium (set in Dockerfile for Docker)

## Rate Limiting

- 10 requests per minute per IP
- Prevents abuse
- Protects Instagram from excessive requests
