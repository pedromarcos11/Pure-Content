# Docker Setup Guide

## Quick Start

### Test locally with Docker

```bash
# Build and run
docker-compose up --build

# Server will be available at http://localhost:3000
```

### Test the API

```bash
# Health check
curl http://localhost:3000/health

# Fetch Instagram content
curl -X POST http://localhost:3000/api/fetch-content \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.instagram.com/reel/YOUR_REEL_ID/"}'
```

## Docker Commands

### Build image
```bash
docker build -t social-media-backend .
```

### Run container
```bash
docker run -p 3000:3000 \
  -e BASE_URL=http://localhost:3000 \
  social-media-backend
```

### Run with volume (for persistent temp files)
```bash
docker run -p 3000:3000 \
  -e BASE_URL=http://localhost:3000 \
  -v $(pwd)/temp:/app/temp \
  social-media-backend
```

### Stop all containers
```bash
docker-compose down
```

### View logs
```bash
docker-compose logs -f
```

### Rebuild after code changes
```bash
docker-compose up --build
```

## Troubleshooting

### Container won't start
- Check if port 3000 is already in use: `lsof -i :3000`
- Check Docker logs: `docker-compose logs`

### Puppeteer errors
- The Dockerfile installs all required dependencies for chromium
- If issues persist, check the logs for missing libraries

### FFmpeg errors
- FFmpeg is installed in the Docker image
- Check logs with `docker-compose logs` to see ffmpeg output

### Permission errors
- The container runs as non-root user for security
- Temp directory is created with proper permissions

## Production Deployment

For Railway deployment, the same Dockerfile is used automatically.
Railway will:
- Build the image
- Set PORT environment variable
- Provide public URL

Just set `BASE_URL` environment variable on Railway to your app's URL.
