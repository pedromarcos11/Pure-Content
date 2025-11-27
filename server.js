const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const fs = require('fs');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Create temp directory for merged videos
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Serve temp files (merged videos)
app.use('/temp', express.static(TEMP_DIR));

// Rate limiting: 10 requests per minute per IP
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    message: 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Debug endpoint to fetch raw HTML (useful for debugging)
app.get('/debug/fetch', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).send('URL parameter is required');
        }

        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            timeout: 10000
        });

        // Return HTML with content-type text/plain for easy viewing
        res.set('Content-Type', 'text/plain');
        res.send(response.data);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// Main endpoint to fetch Instagram content
app.post('/api/fetch-content', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                error: 'URL is required',
                message: 'Please provide an Instagram URL'
            });
        }

        // Validate Instagram URL
        const instagramUrlPattern = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+\/?/;
        if (!instagramUrlPattern.test(url)) {
            return res.status(400).json({
                error: 'Invalid URL',
                message: 'Please provide a valid Instagram URL'
            });
        }

        console.log(`[FETCH] Fetching: ${url}`);

        // Fetch Instagram page with realistic browser headers
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'max-age=0',
                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"macOS"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'Viewport-Width': '1920'
            },
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: (status) => status < 400
        });

        const html = response.data;

        // Try multiple extraction methods
        let postData = null;

        // Method 1: Search for video_url or display_url directly in HTML (most reliable for current Instagram)
        // Try multiple patterns for video URLs
        let videoUrlMatch = html.match(/"video_url":"([^"]+)"/);

        // If no video_url, try playback_url (used in some Instagram versions)
        if (!videoUrlMatch) {
            videoUrlMatch = html.match(/"playback_url":"([^"]+)"/);
        }

        // Try video_versions array
        if (!videoUrlMatch) {
            videoUrlMatch = html.match(/"video_versions":\[\{"url":"([^"]+)"/);
        }

        const displayUrlMatch = html.match(/"display_url":"([^"]+)"/);
        const thumbnailMatch = html.match(/"thumbnail_src":"([^"]+)"/);

        // Try to find higher quality images from display_resources
        let highQualityImageUrl = null;
        // Try multiple patterns for display_resources
        const displayResourcesPatterns = [
            /"display_resources":\[(.*?)\]/s,
            /"display_resources":\s*\[(.*?)\]/s,
            /display_resources.*?\[(.*?)\]/s
        ];
        
        for (const pattern of displayResourcesPatterns) {
            const displayResourcesMatch = html.match(pattern);
            if (displayResourcesMatch) {
                try {
                    // Extract all URLs and their config_width/config_height if available
                    const resourceMatches = [...displayResourcesMatch[1].matchAll(/\{"src":"([^"]+)","config_width":(\d+),"config_height":(\d+)\}/g)];
                    
                    if (resourceMatches.length > 0) {
                        // Find the highest resolution image
                        let maxResolution = 0;
                        let bestUrl = null;
                        
                        for (const match of resourceMatches) {
                            const width = parseInt(match[2]);
                            const height = parseInt(match[3]);
                            const resolution = width * height;
                            
                            if (resolution > maxResolution) {
                                maxResolution = resolution;
                                bestUrl = match[1];
                            }
                        }
                        
                        if (bestUrl) {
                            highQualityImageUrl = bestUrl
                                .replace(/\\u0026/g, '&')
                                .replace(/\\\//g, '/')
                                .replace(/\\u003d/g, '=');
                            highQualityImageUrl = decodeUrlEntities(highQualityImageUrl);
                            console.log('[DEBUG] Found high-quality image from display_resources:', maxResolution);
                            break;
                        }
                    } else {
                        // Fallback: extract URLs without config info
                        const resourceUrls = [...displayResourcesMatch[1].matchAll(/"src":"([^"]+)"/g)];
                        if (resourceUrls.length > 0) {
                            // Last URL is typically the highest quality
                            highQualityImageUrl = resourceUrls[resourceUrls.length - 1][1]
                                .replace(/\\u0026/g, '&')
                                .replace(/\\\//g, '/')
                                .replace(/\\u003d/g, '=');
                            highQualityImageUrl = decodeUrlEntities(highQualityImageUrl);
                            console.log('[DEBUG] Found high-quality image from display_resources (fallback)');
                            break;
                        }
                    }
                } catch (e) {
                    console.log('[DEBUG] Could not parse display_resources:', e.message);
                }
            }
        }
        
        // Also try to find best_image_url or similar patterns
        if (!highQualityImageUrl) {
            const bestImageMatch = html.match(/"best_image_url":"([^"]+)"/);
            if (bestImageMatch) {
                highQualityImageUrl = bestImageMatch[1]
                    .replace(/\\u0026/g, '&')
                    .replace(/\\\//g, '/')
                    .replace(/\\u003d/g, '=');
                highQualityImageUrl = decodeUrlEntities(highQualityImageUrl);
                console.log('[DEBUG] Found best_image_url');
            }
        }

        if (videoUrlMatch || displayUrlMatch) {
            // Also try to extract caption and username
            const captionMatch = html.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"([^"]+)"/);
            const usernameMatch = html.match(/"owner":\{"id":"[^"]+","username":"([^"]+)"/);
            const timestampMatch = html.match(/"taken_at_timestamp":(\d+)/);

            // Prioritize video URL over display URL, use high-quality image if available for images
            let mediaUrl = (videoUrlMatch?.[1] || displayUrlMatch?.[1] || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\u003d/g, '=');
            mediaUrl = decodeUrlEntities(mediaUrl); // Decode HTML entities

            // Use high-quality image URL if this is an image post and we found one
            if (!videoUrlMatch && highQualityImageUrl) {
                mediaUrl = decodeUrlEntities(highQualityImageUrl);
            }
            
            // Remove size restrictions from image URLs to get full quality
            if (!videoUrlMatch && mediaUrl) {
                // Remove size parameters like s640x640, s1080x1080, etc.
                mediaUrl = mediaUrl.replace(/[?&]stp=[^&]*/g, ''); // Remove stp parameter
                mediaUrl = mediaUrl.replace(/[?&]_nc_cat=[^&]*/g, ''); // Remove _nc_cat
                mediaUrl = mediaUrl.replace(/[?&]ccb=[^&]*/g, ''); // Remove ccb
                mediaUrl = mediaUrl.replace(/[?&]_nc_sid=[^&]*/g, ''); // Remove _nc_sid
                mediaUrl = mediaUrl.replace(/[?&]efg=[^&]*/g, ''); // Remove efg
                mediaUrl = mediaUrl.replace(/[?&]_nc_ohc=[^&]*/g, ''); // Remove _nc_ohc
                mediaUrl = mediaUrl.replace(/[?&]_nc_oc=[^&]*/g, ''); // Remove _nc_oc
                mediaUrl = mediaUrl.replace(/[?&]_nc_zt=[^&]*/g, ''); // Remove _nc_zt
                mediaUrl = mediaUrl.replace(/[?&]_nc_ht=[^&]*/g, ''); // Remove _nc_ht
                mediaUrl = mediaUrl.replace(/[?&]_nc_gid=[^&]*/g, ''); // Remove _nc_gid
                // Remove size indicators from path (s640x640, s1080x1080, etc.)
                mediaUrl = mediaUrl.replace(/\/s\d+x\d+[a-z]?_[a-z]+-jpg[^?&]*/g, '');
                // Clean up multiple consecutive & or ?&
                mediaUrl = mediaUrl.replace(/[?&]+/g, (match, offset) => offset === 0 ? '?' : '&');
                mediaUrl = mediaUrl.replace(/\?$/, ''); // Remove trailing ?
                console.log('[DEBUG] Cleaned image URL to remove size restrictions');
            }

            let thumbnailUrl = (displayUrlMatch?.[1] || thumbnailMatch?.[1] || mediaUrl).replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            thumbnailUrl = decodeUrlEntities(thumbnailUrl); // Decode HTML entities

            if (mediaUrl) {
                postData = {
                    mediaUrl: mediaUrl,
                    thumbnailUrl: thumbnailUrl,
                    caption: decodeHtmlEntities(captionMatch?.[1] || ''),
                    author: usernameMatch?.[1] || 'Unknown',
                    mediaType: videoUrlMatch ? 'video' : 'image',
                    timestamp: timestampMatch?.[1] ? new Date(parseInt(timestampMatch[1]) * 1000).toISOString() : null
                };
                console.log('[SUCCESS] Extracted from direct URL search - Type:', postData.mediaType);
                console.log('[DEBUG] Video URL found:', !!videoUrlMatch);
                console.log('[DEBUG] Display URL found:', !!displayUrlMatch);
                console.log('[DEBUG] High-quality image used:', !videoUrlMatch && !!highQualityImageUrl);
            }
        }

        // Method 2: Try to extract from all <script> tags containing JSON data
        if (!postData?.mediaUrl) {
            const scriptMatches = html.matchAll(/<script[^>]*>(.*?)<\/script>/gs);
            for (const match of scriptMatches) {
                const scriptContent = match[1];

                // Look for any JSON-like structure with video_url or display_url
                if (scriptContent.includes('video_url') || scriptContent.includes('display_url')) {
                    try {
                        // Try to extract JSON objects
                        const jsonMatches = scriptContent.matchAll(/(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g);
                        for (const jsonMatch of jsonMatches) {
                            try {
                                const data = JSON.parse(jsonMatch[1]);
                                postData = extractFromRequireData(data);
                                if (postData?.mediaUrl) {
                                    console.log('[SUCCESS] Extracted from script tag JSON');
                                    break;
                                }
                            } catch (e) {
                                // Try next match
                            }
                        }
                        if (postData?.mediaUrl) break;
                    } catch (e) {
                        // Continue to next script tag
                    }
                }
            }
        }

        // Method 2: Try JSON-LD
        if (!postData?.mediaUrl) {
            const jsonLdMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
            if (jsonLdMatch) {
                try {
                    const jsonLd = JSON.parse(jsonLdMatch[1]);
                    postData = parseJsonLd(jsonLd);
                    if (postData?.mediaUrl) {
                        console.log('[SUCCESS] Extracted from JSON-LD');
                    }
                } catch (e) {
                    console.error('[DEBUG] Failed to parse JSON-LD:', e.message);
                }
            }
        }

        // Method 3: Try sharedData
        if (!postData?.mediaUrl) {
            const sharedDataMatch = html.match(/window\._sharedData = ({.*?});/s);
            if (sharedDataMatch) {
                try {
                    const sharedData = JSON.parse(sharedDataMatch[1]);
                    postData = parseSharedData(sharedData, url);
                    if (postData?.mediaUrl) {
                        console.log('[SUCCESS] Extracted from sharedData');
                    }
                } catch (e) {
                    console.error('[DEBUG] Failed to parse sharedData:', e.message);
                }
            }
        }

        // Method 4: Meta tags fallback
        if (!postData?.mediaUrl) {
            postData = parseMetaTags(html);
            if (postData?.mediaUrl) {
                console.log('[SUCCESS] Extracted from meta tags');
            }
        }

        // Method 5: Use Puppeteer if we only got image/thumbnail (for reels/videos)
        // Check if URL indicates video content but we only got an image
        const isVideoUrl = url.includes('/reel/') || url.includes('/tv/');
        if (isVideoUrl && postData?.mediaType === 'image') {
            console.log('[INFO] Detected video URL but got image, trying Puppeteer...');
            try {
                const puppeteerData = await extractWithPuppeteer(url);
                if (puppeteerData?.mediaUrl && puppeteerData.mediaType === 'video') {
                    postData = puppeteerData;
                    console.log('[SUCCESS] Extracted video with Puppeteer');
                }
            } catch (e) {
                console.error('[DEBUG] Puppeteer extraction failed:', e.message);
            }
        }

        // Debug logging
        if (!postData || !postData.mediaUrl) {
            console.error('[DEBUG] All parsing methods failed');
            console.error('[DEBUG] HTML length:', html.length);
            console.error('[DEBUG] Has video_url pattern:', html.includes('video_url'));
            console.error('[DEBUG] Has display_url pattern:', html.includes('display_url'));
            console.error('[DEBUG] Has JSON-LD:', html.includes('application/ld+json'));
            console.error('[DEBUG] Has sharedData:', html.includes('window._sharedData'));
            console.error('[DEBUG] Has og:video:', html.includes('og:video'));
            console.error('[DEBUG] Has og:image:', html.includes('og:image'));

            // Save HTML to file for debugging
            const debugPath = '/tmp/instagram-debug.html';
            try {
                fs.writeFileSync(debugPath, html);
                console.error('[DEBUG] HTML saved to:', debugPath);
            } catch (e) {
                console.error('[DEBUG] Could not save HTML:', e.message);
            }

            return res.status(404).json({
                error: 'Content not found',
                message: 'Could not extract content from Instagram. The post might be private or deleted.',
                debug: process.env.NODE_ENV === 'development' ? {
                    htmlLength: html.length,
                    hasVideoUrl: html.includes('video_url'),
                    hasDisplayUrl: html.includes('display_url'),
                    hasJsonLd: html.includes('application/ld+json'),
                    hasSharedData: html.includes('window._sharedData'),
                    hasOgVideo: html.includes('og:video'),
                    hasOgImage: html.includes('og:image')
                } : undefined
            });
        }

        // Final URL sanitization - ensure no HTML entities remain
        if (postData.mediaUrl) {
            postData.mediaUrl = decodeUrlEntities(postData.mediaUrl);
        }
        if (postData.thumbnailUrl) {
            postData.thumbnailUrl = decodeUrlEntities(postData.thumbnailUrl);
        }

        res.json({
            ...postData,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error fetching Instagram content:', error.message);

        if (error.response?.status === 404) {
            return res.status(404).json({
                error: 'Post not found',
                message: 'The Instagram post could not be found. It may be private or deleted.'
            });
        }

        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            return res.status(504).json({
                error: 'Timeout',
                message: 'Request to Instagram timed out. Please try again.'
            });
        }

        res.status(500).json({
            error: 'Server error',
            message: 'Failed to fetch content. Please try again later.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Helper function to decode HTML entities from URLs
function decodeUrlEntities(url) {
    if (!url) return url;
    // Decode HTML entities in URLs (especially &amp; -> &)
    // Handle multiple encodings (e.g., &amp;amp; -> &amp; -> &)
    let decoded = url;
    let previous = '';
    // Keep decoding until no more changes (handles double/triple encoding)
    while (decoded !== previous) {
        previous = decoded;
        decoded = decoded
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#x27;/gi, "'")
            .replace(/&#x2F;/gi, '/')
            .replace(/&#x3D;/gi, '=')
            .replace(/&#39;/gi, "'")
            .replace(/&#x2F;/gi, '/');
    }
    return decoded;
}

// Helper function to decode HTML entities
function decodeHtmlEntities(text) {
    if (!text) return '';

    // First, handle double-encoded entities (e.g., &amp;#x1f9d9; -> &#x1f9d9; -> emoji)
    // This needs to be done before decoding &amp;
    let decoded = text;
    
    // Decode double-encoded numeric entities (hex) - &amp;#x...; -> &#x...;
    decoded = decoded.replace(/&amp;#x([0-9a-f]+);/gi, (match, hex) => {
        try {
            return String.fromCodePoint(parseInt(hex, 16));
        } catch (e) {
            return String.fromCharCode(parseInt(hex, 16));
        }
    });
    
    // Decode double-encoded numeric entities (decimal) - &amp;#...; -> &#...;
    decoded = decoded.replace(/&amp;#(\d+);/g, (match, dec) => {
        try {
            return String.fromCodePoint(parseInt(dec, 10));
        } catch (e) {
            return String.fromCharCode(parseInt(dec, 10));
        }
    });
    
    // Decode double-encoded named entities - &amp;quot; -> &quot; -> "
    decoded = decoded.replace(/&amp;quot;/g, '"');
    decoded = decoded.replace(/&amp;apos;/g, "'");
    decoded = decoded.replace(/&amp;lt;/g, '<');
    decoded = decoded.replace(/&amp;gt;/g, '>');
    
    // Now decode regular HTML entities
    decoded = decoded
        // Decode common named entities
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        // Decode numeric entities (decimal)
        .replace(/&#(\d+);/g, (match, dec) => {
            try {
                return String.fromCodePoint(parseInt(dec, 10));
            } catch (e) {
                return String.fromCharCode(parseInt(dec, 10));
            }
        })
        // Decode numeric entities (hexadecimal) - use fromCodePoint for emojis
        .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
            try {
                return String.fromCodePoint(parseInt(hex, 16));
            } catch (e) {
                return String.fromCharCode(parseInt(hex, 16));
            }
        })
        // Handle escaped backslashes
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    
    return decoded;
}

// Helper function to extract from require data (Instagram's newer structure)
function extractFromRequireData(data) {
    try {
        // Navigate through the complex nested structure
        function findMediaData(obj, depth = 0) {
            if (depth > 10) return null; // Prevent infinite recursion

            if (obj && typeof obj === 'object') {
                // Look for video_url or display_url which are typical media indicators
                if (obj.video_url || obj.display_url || obj.display_resources) {
                    let mediaUrl = obj.video_url || obj.display_url;
                    let thumbnailUrl = obj.display_url || obj.thumbnail_src || obj.video_url;
                    
                    // Try to get highest quality image from display_resources
                    if (!obj.video_url && obj.display_resources && Array.isArray(obj.display_resources) && obj.display_resources.length > 0) {
                        // Find the highest resolution image
                        let maxResolution = 0;
                        let bestResource = null;
                        
                        for (const resource of obj.display_resources) {
                            if (resource.src && resource.config_width && resource.config_height) {
                                const resolution = resource.config_width * resource.config_height;
                                if (resolution > maxResolution) {
                                    maxResolution = resolution;
                                    bestResource = resource;
                                }
                            }
                        }
                        
                        if (bestResource) {
                            mediaUrl = bestResource.src;
                            thumbnailUrl = bestResource.src;
                            console.log('[DEBUG] Found high-quality image from display_resources in JSON:', maxResolution);
                        } else if (obj.display_resources.length > 0 && obj.display_resources[obj.display_resources.length - 1].src) {
                            // Fallback to last resource (usually highest quality)
                            mediaUrl = obj.display_resources[obj.display_resources.length - 1].src;
                            thumbnailUrl = mediaUrl;
                        }
                    }
                    
                    // Decode HTML entities from URLs
                    mediaUrl = decodeUrlEntities(mediaUrl);
                    thumbnailUrl = decodeUrlEntities(thumbnailUrl);
                    
                    // Remove size restrictions from image URLs
                    if (!obj.video_url && mediaUrl) {
                        mediaUrl = mediaUrl.replace(/[?&]stp=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]_nc_cat=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]ccb=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]_nc_sid=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]efg=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]_nc_ohc=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]_nc_oc=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]_nc_zt=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]_nc_ht=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]_nc_gid=[^&]*/g, '');
                        mediaUrl = mediaUrl.replace(/\/s\d+x\d+[a-z]?_[a-z]+-jpg[^?&]*/g, '');
                        mediaUrl = mediaUrl.replace(/[?&]+/g, (match, offset) => offset === 0 ? '?' : '&');
                        mediaUrl = mediaUrl.replace(/\?$/, '');
                    }
                    
                    const caption = obj.edge_media_to_caption?.edges?.[0]?.node?.text ||
                                  obj.caption?.text ||
                                  obj.accessibility_caption || '';
                    
                    return {
                        mediaUrl: mediaUrl,
                        thumbnailUrl: thumbnailUrl,
                        caption: decodeHtmlEntities(caption),
                        author: obj.owner?.username || obj.user?.username || 'Unknown',
                        mediaType: obj.video_url || obj.is_video ? 'video' : 'image',
                        timestamp: obj.taken_at_timestamp ? new Date(obj.taken_at_timestamp * 1000).toISOString() : null
                    };
                }

                // Recursively search in object properties
                for (const key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        const result = findMediaData(obj[key], depth + 1);
                        if (result) return result;
                    }
                }
            }

            return null;
        }

        return findMediaData(data);
    } catch (e) {
        console.error('Error extracting from require data:', e.message);
        return null;
    }
}

// Helper function to parse JSON-LD data
function parseJsonLd(jsonLd) {
    if (!jsonLd) return null;

    let mediaUrl = jsonLd.video?.contentUrl || jsonLd.image || null;
    mediaUrl = decodeUrlEntities(mediaUrl); // Decode HTML entities
    
    // Remove size restrictions from image URLs
    if (!jsonLd.video && mediaUrl) {
        mediaUrl = mediaUrl.replace(/[?&]stp=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]_nc_cat=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]ccb=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]_nc_sid=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]efg=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]_nc_ohc=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]_nc_oc=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]_nc_zt=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]_nc_ht=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]_nc_gid=[^&]*/g, '');
        mediaUrl = mediaUrl.replace(/\/s\d+x\d+[a-z]?_[a-z]+-jpg[^?&]*/g, '');
        mediaUrl = mediaUrl.replace(/[?&]+/g, (match, offset) => offset === 0 ? '?' : '&');
        mediaUrl = mediaUrl.replace(/\?$/, '');
    }

    const thumbnailUrl = decodeUrlEntities(jsonLd.video?.thumbnailUrl || mediaUrl || null);
    const caption = jsonLd.articleBody || jsonLd.caption || jsonLd.description || '';

    return {
        mediaUrl: mediaUrl,
        thumbnailUrl: thumbnailUrl,
        caption: decodeHtmlEntities(caption),
        author: jsonLd.author?.name || jsonLd.author?.alternateName || 'Unknown',
        mediaType: jsonLd.video ? 'video' : 'image',
        timestamp: jsonLd.uploadDate || jsonLd.datePublished || null
    };
}

// Helper function to parse sharedData
function parseSharedData(sharedData, url) {
    try {
        const shortcode = url.match(/\/(p|reel|tv)\/([\w-]+)/)?.[2];
        if (!shortcode) return null;

        const media = sharedData.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
        if (!media) return null;

        const isVideo = media.is_video || media.__typename === 'GraphVideo';

        let mediaUrl = isVideo ? media.video_url : media.display_url;
        let thumbnailUrl = media.display_url;
        
        // Try to get highest quality image from display_resources
        if (!isVideo && media.display_resources && Array.isArray(media.display_resources) && media.display_resources.length > 0) {
            let maxResolution = 0;
            let bestResource = null;
            
            for (const resource of media.display_resources) {
                if (resource.src && resource.config_width && resource.config_height) {
                    const resolution = resource.config_width * resource.config_height;
                    if (resolution > maxResolution) {
                        maxResolution = resolution;
                        bestResource = resource;
                    }
                }
            }
            
            if (bestResource) {
                mediaUrl = bestResource.src;
                thumbnailUrl = bestResource.src;
                console.log('[DEBUG] Found high-quality image from display_resources in sharedData:', maxResolution);
            } else if (media.display_resources.length > 0 && media.display_resources[media.display_resources.length - 1].src) {
                mediaUrl = media.display_resources[media.display_resources.length - 1].src;
                thumbnailUrl = mediaUrl;
            }
        }
        
        // Decode HTML entities from URLs
        mediaUrl = decodeUrlEntities(mediaUrl);
        thumbnailUrl = decodeUrlEntities(thumbnailUrl);

        // Remove size restrictions from image URLs
        if (!isVideo && mediaUrl) {
            mediaUrl = mediaUrl.replace(/[?&]stp=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_cat=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]ccb=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_sid=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]efg=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_ohc=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_oc=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_zt=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_ht=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_gid=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/\/s\d+x\d+[a-z]?_[a-z]+-jpg[^?&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]+/g, (match, offset) => offset === 0 ? '?' : '&');
            mediaUrl = mediaUrl.replace(/\?$/, '');
        }

        const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';

        return {
            mediaUrl: mediaUrl,
            thumbnailUrl: thumbnailUrl,
            caption: decodeHtmlEntities(caption),
            author: media.owner?.username || 'Unknown',
            mediaType: isVideo ? 'video' : 'image',
            timestamp: media.taken_at_timestamp ? new Date(media.taken_at_timestamp * 1000).toISOString() : null
        };
    } catch (e) {
        console.error('Error parsing sharedData:', e.message);
        return null;
    }
}

// Helper function to parse meta tags as fallback
function parseMetaTags(html) {
    try {
        // Try different og: tag formats - handle both quoted and HTML-encoded attributes
        const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                            html.match(/<meta\s+name=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                            html.match(/<meta\s+property=["']og:image["']\s+content=([^\s>]+)/i) ||
                            html.match(/<meta\s+name=["']og:image["']\s+content=([^\s>]+)/i);

        const ogVideoMatch = html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i) ||
                            html.match(/<meta\s+property=["']og:video:secure_url["']\s+content=["']([^"']+)["']/i) ||
                            html.match(/<meta\s+name=["']og:video["']\s+content=["']([^"']+)["']/i) ||
                            html.match(/<meta\s+property=["']og:video["']\s+content=([^\s>]+)/i);

        const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                           html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);

        const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                            html.match(/<meta\s+name=["']twitter:title["']\s+content=["']([^"']+)["']/i) ||
                            html.match(/<title>([^<]+)<\/title>/i);

        // Try to get video URL from twitter tags as well
        const twitterPlayerMatch = html.match(/<meta\s+name=["']twitter:player:stream["']\s+content=["']([^"']+)["']/i);

        const videoUrl = ogVideoMatch?.[1] || twitterPlayerMatch?.[1];
        const imageUrl = ogImageMatch?.[1];
        let mediaUrl = videoUrl || imageUrl || null;

        if (!mediaUrl) {
            return null;
        }

        // Decode HTML entities from URLs
        mediaUrl = decodeUrlEntities(mediaUrl);
        const imageUrlDecoded = decodeUrlEntities(imageUrl);

        // Remove size restrictions from image URLs
        if (!videoUrl && mediaUrl) {
            mediaUrl = mediaUrl.replace(/[?&]stp=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_cat=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]ccb=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_sid=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]efg=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_ohc=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_oc=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_zt=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_ht=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]_nc_gid=[^&]*/g, '');
            mediaUrl = mediaUrl.replace(/\/s\d+x\d+[a-z]?_[a-z]+-jpg[^?&]*/g, '');
            mediaUrl = mediaUrl.replace(/[?&]+/g, (match, offset) => offset === 0 ? '?' : '&');
            mediaUrl = mediaUrl.replace(/\?$/, '');
        }

        const caption = ogDescMatch?.[1] || '';

        return {
            mediaUrl: mediaUrl,
            thumbnailUrl: imageUrlDecoded || mediaUrl,
            caption: decodeHtmlEntities(caption),
            author: ogTitleMatch?.[1]?.split(' on Instagram')?.[0]?.split('(@')?.[0]?.trim() || 'Unknown',
            mediaType: videoUrl ? 'video' : 'image',
            timestamp: null
        };
    } catch (e) {
        console.error('Error parsing meta tags:', e.message);
        return null;
    }
}

// Puppeteer-based extraction (for videos that don't appear in HTML)
async function extractWithPuppeteer(url) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security'
            ]
        });

        const page = await browser.newPage();

        // Set realistic viewport and user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Intercept network requests to capture video and audio URLs
        let videoUrls = [];
        let audioUrls = [];
        let thumbnailUrl = null;

        await page.setRequestInterception(true);

        page.on('request', request => {
            request.continue();
        });

        page.on('response', async response => {
            const responseUrl = response.url();
            const contentType = response.headers()['content-type'] || '';

            // Capture video and audio URLs from Instagram CDN
            if (contentType.includes('video') || responseUrl.includes('.mp4')) {
                if (responseUrl.includes('.mp4')) {
                    // Detect audio by URL patterns:
                    // - Path contains /t16/ (audio) vs /t2/ (video)
                    // - Path contains /m69/ (audio) vs /m367/ (video)
                    // - URL contains 'audio' or 'heaac' keywords
                    const isAudio = responseUrl.includes('/t16/') ||
                                   responseUrl.includes('/m69/') ||
                                   responseUrl.includes('audio') ||
                                   responseUrl.includes('heaac');

                    if (isAudio) {
                        console.log('[PUPPETEER] Detected audio URL');
                        audioUrls.push(responseUrl);
                    } else {
                        videoUrls.push(responseUrl);
                    }
                }
            }

            // Capture thumbnail
            if ((contentType.includes('image') || responseUrl.includes('.jpg')) && !thumbnailUrl) {
                if (responseUrl.includes('cdninstagram.com') || responseUrl.includes('fbcdn.net')) {
                    thumbnailUrl = responseUrl;
                }
            }
        });

        console.log('[PUPPETEER] Navigating to:', url);

        // Navigate to the page
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Wait for video to load
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Extract metadata from the page
        const metadata = await page.evaluate(() => {
            // Try to get caption and username
            const captionElement = document.querySelector('h1') ||
                                  document.querySelector('[class*="Caption"]') ||
                                  document.querySelector('meta[property="og:title"]');

            const usernameElement = document.querySelector('a[href*="/"]') ||
                                   document.querySelector('meta[property="og:title"]');

            // Try to extract from scripts
            const scripts = Array.from(document.querySelectorAll('script'));
            let caption = '';
            let username = '';

            for (const script of scripts) {
                const content = script.textContent || '';
                if (content.includes('edge_media_to_caption')) {
                    const captionMatch = content.match(/"text":"([^"]+)"/);
                    if (captionMatch) {
                        caption = captionMatch[1];
                        break;
                    }
                }
                if (content.includes('"username"') && !username) {
                    const usernameMatch = content.match(/"username":"([^"]+)"/);
                    if (usernameMatch) {
                        username = usernameMatch[1];
                    }
                }
            }

            return {
                caption: caption || captionElement?.textContent || captionElement?.content || '',
                author: username || usernameElement?.textContent || usernameElement?.content || 'Unknown'
            };
        });

        await browser.close();

        // Process video URLs to find the best quality
        if (videoUrls.length > 0) {
            console.log(`[PUPPETEER] Found ${videoUrls.length} video URL(s) and ${audioUrls.length} audio URL(s)`);

            // Find the highest quality video URL
            const qualityOrder = ['q90', 'q80', 'q70', 'q60', 'q50', 'q40'];
            let bestVideoUrl = null;

            for (const quality of qualityOrder) {
                const found = videoUrls.find(url => url.includes(quality));
                if (found) {
                    bestVideoUrl = found;
                    console.log(`[PUPPETEER] Selected ${quality} quality video`);
                    break;
                }
            }

            if (!bestVideoUrl) {
                bestVideoUrl = videoUrls[0];
            }

            // Clean video URL (remove byte ranges)
            const cleanVideoUrl = cleanUrl(bestVideoUrl);

            // If we have audio, merge it with video
            if (audioUrls.length > 0) {
                console.log('[PUPPETEER] Merging video with audio using ffmpeg...');
                const cleanAudioUrl = cleanUrl(audioUrls[0]);

                try {
                    const mergedVideoPath = await mergeVideoAudio(cleanVideoUrl, cleanAudioUrl, url);
                    const serverUrl = `${BASE_URL}/temp/${path.basename(mergedVideoPath)}`;

                    return {
                        mediaUrl: serverUrl,
                        thumbnailUrl: thumbnailUrl || '',
                        caption: decodeHtmlEntities(metadata.caption.replace(/\\n/g, '\n').replace(/\\"/g, '"')),
                        author: metadata.author,
                        mediaType: 'video',
                        timestamp: null
                    };
                } catch (error) {
                    console.error('[PUPPETEER] Failed to merge audio/video:', error.message);
                    // Fallback to video without audio
                    console.log('[PUPPETEER] Falling back to video without audio');
                    return {
                        mediaUrl: cleanVideoUrl,
                        thumbnailUrl: thumbnailUrl || '',
                        caption: decodeHtmlEntities(metadata.caption.replace(/\\n/g, '\n').replace(/\\"/g, '"')),
                        author: metadata.author,
                        mediaType: 'video',
                        timestamp: null
                    };
                }
            } else {
                // No audio track found
                console.log('[PUPPETEER] No audio track found, returning video only');
                return {
                    mediaUrl: cleanVideoUrl,
                    thumbnailUrl: thumbnailUrl || '',
                    caption: decodeHtmlEntities(metadata.caption.replace(/\\n/g, '\n').replace(/\\"/g, '"')),
                    author: metadata.author,
                    mediaType: 'video',
                    timestamp: null
                };
            }
        }

        return null;

    } catch (error) {
        if (browser) {
            await browser.close();
        }
        throw error;
    }
}

// Helper function to clean URL (remove byte range parameters)
function cleanUrl(url) {
    if (!url) return url;
    const [baseUrl, queryString] = url.split('?');
    if (!queryString) return url;

    const cleanedParams = queryString
        .split('&')
        .filter(param => !param.startsWith('bytestart') && !param.startsWith('byteend'))
        .join('&');

    return `${baseUrl}?${cleanedParams}`;
}

// Helper function to download a file
async function downloadFile(url, filepath) {
    const writer = fs.createWriteStream(filepath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Helper function to merge video and audio using ffmpeg
async function mergeVideoAudio(videoUrl, audioUrl, instagramUrl) {
    return new Promise(async (resolve, reject) => {
        try {
            // Create unique filename based on Instagram URL
            const hash = crypto.createHash('md5').update(instagramUrl).digest('hex');
            const videoPath = path.join(TEMP_DIR, `${hash}_video.mp4`);
            const audioPath = path.join(TEMP_DIR, `${hash}_audio.mp4`);
            const outputPath = path.join(TEMP_DIR, `${hash}_merged.mp4`);

            // Check if already merged
            if (fs.existsSync(outputPath)) {
                console.log('[FFMPEG] Using cached merged video');
                return resolve(outputPath);
            }

            console.log('[FFMPEG] Downloading video...');
            await downloadFile(videoUrl, videoPath);

            console.log('[FFMPEG] Downloading audio...');
            await downloadFile(audioUrl, audioPath);

            console.log('[FFMPEG] Merging video and audio...');

            ffmpeg()
                .input(videoPath)
                .input(audioPath)
                .outputOptions([
                    '-c:v copy',      // Copy video codec (no re-encoding)
                    '-c:a aac',       // Convert audio to AAC
                    '-strict experimental'
                ])
                .output(outputPath)
                .on('end', () => {
                    console.log('[FFMPEG] Merge completed successfully');
                    // Cleanup temp files
                    try {
                        fs.unlinkSync(videoPath);
                        fs.unlinkSync(audioPath);
                    } catch (e) {
                        console.error('[FFMPEG] Cleanup error:', e.message);
                    }
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('[FFMPEG] Error:', err.message);
                    // Cleanup on error
                    try {
                        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                    reject(err);
                })
                .run();
        } catch (error) {
            reject(error);
        }
    });
}

// Start server
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Social Media Content Viewer`);
    console.log(`${'='.repeat(60)}\n`);
    console.log(`🌐 Application: ${BASE_URL}`);
    console.log(`📱 Frontend:    ${BASE_URL}/`);
    console.log(`🔧 Backend:     ${BASE_URL}/api/`);
    console.log(`\n💡 API Endpoints:`);
    console.log(`   GET  ${BASE_URL}/health`);
    console.log(`   POST ${BASE_URL}/api/fetch-content`);
    console.log(`   GET  ${BASE_URL}/temp/:filename`);
    console.log(`\n⚙️  Configuration:`);
    console.log(`   Rate limit:     10 requests/minute`);
    console.log(`   Puppeteer:      ✓ enabled`);
    console.log(`   FFmpeg:         ✓ enabled`);
    console.log(`\n🔧 Environment:`);
    console.log(`   NODE_ENV:       ${process.env.NODE_ENV || 'development'}`);
    console.log(`   PORT:           ${PORT}`);
    console.log(`   Chromium:       ${process.env.PUPPETEER_EXECUTABLE_PATH || 'auto-detected'}`);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✨ Ready! Open ${BASE_URL} in your browser`);
    console.log(`${'='.repeat(60)}\n`);
});
