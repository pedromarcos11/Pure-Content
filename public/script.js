// Configuration - automatically uses current origin (works locally and on Railway)
const API_URL = `${window.location.origin}/api/fetch-content`;

// UI Elements
const urlInput = document.getElementById('contentUrl');
const loadBtn = document.getElementById('loadBtn');
const clearBtn = document.getElementById('clearBtn');
const errorMessage = document.getElementById('errorMessage');
const loadingMessage = document.getElementById('loadingMessage');
const contentDisplay = document.getElementById('contentDisplay');
const themeToggle = document.getElementById('themeToggle');
const installPrompt = document.getElementById('installPrompt');
const installBtn = document.getElementById('installBtn');
const dismissInstall = document.getElementById('dismissInstall');

// Theme Management
function initTheme() {
    // Check localStorage first, then system preference
    const savedTheme = localStorage.getItem('theme');

    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    } else {
        // Use system preference
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
}

// Theme toggle button
if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    // Only apply if user hasn't manually set a theme
    if (!localStorage.getItem('theme')) {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
});

// PWA Install Prompt
let deferredPrompt;

window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later
    deferredPrompt = e;

    // Check if user has dismissed the prompt before
    const dismissed = localStorage.getItem('installPromptDismissed');
    const dismissedTime = localStorage.getItem('installPromptDismissedTime');

    // Show prompt if not dismissed, or if dismissed more than 7 days ago
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    if (!dismissed || (dismissedTime && parseInt(dismissedTime) < sevenDaysAgo)) {
        // Show install prompt after 3 seconds
        setTimeout(() => {
            installPrompt.classList.add('visible');
        }, 3000);
    }
});

// Install button click
if (installBtn) {
    installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;

        // Show the install prompt
        deferredPrompt.prompt();

        // Wait for the user to respond to the prompt
        const { outcome } = await deferredPrompt.userChoice;

        console.log(`User response to the install prompt: ${outcome}`);

        // Hide the install prompt
        installPrompt.classList.remove('visible');

        // Clear the deferredPrompt
        deferredPrompt = null;
    });
}

// Dismiss install prompt
if (dismissInstall) {
    dismissInstall.addEventListener('click', () => {
        installPrompt.classList.remove('visible');
        localStorage.setItem('installPromptDismissed', 'true');
        localStorage.setItem('installPromptDismissedTime', Date.now().toString());
    });
}

// Clear button functionality
function updateClearButton() {
    if (urlInput.value.trim()) {
        clearBtn.classList.add('visible');
    } else {
        clearBtn.classList.remove('visible');
    }
}

urlInput.addEventListener('input', updateClearButton);

if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        urlInput.value = '';
        updateClearButton();
        urlInput.focus();
        hideContent();
        hideError();
    });
}

// Allow Enter key to trigger load
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        loadContent();
    }
});

// Main function to load content
async function loadContent() {
    const url = urlInput.value.trim();

    // Reset UI
    hideError();
    hideContent();

    // Validate URL
    if (!url) {
        showError('Por favor, insira um link do Instagram');
        return;
    }

    if (!isValidInstagramUrl(url)) {
        showError('Por favor, insira um link válido do Instagram (ex: https://www.instagram.com/p/...)');
        return;
    }

    // Show loading
    showLoading();

    try {
        // Call our backend API
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || 'Falha ao buscar conteúdo');
        }

        // Display the content
        displayContent(data);
        hideLoading();

    } catch (error) {
        console.error('Error loading content:', error);

        let errorMsg = 'Não foi possível carregar o conteúdo do Instagram. ';

        if (error.message.includes('Failed to fetch')) {
            errorMsg += 'O servidor não está em execução. Por favor, inicie o backend primeiro.';
        } else {
            errorMsg += error.message;
        }

        showError(errorMsg);
        hideLoading();
    }
}

// Helper function to decode HTML entities in URLs
function decodeUrl(url) {
    if (!url) return url;
    // Decode HTML entities (especially &amp; -> &)
    return url
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
}

// Display content from backend response
function displayContent(data) {
    const { mediaUrl, thumbnailUrl, caption, author, mediaType, timestamp } = data;

    // Decode URLs to ensure they're properly formatted
    const decodedMediaUrl = decodeUrl(mediaUrl);
    const decodedThumbnailUrl = decodeUrl(thumbnailUrl);

    let mediaHtml = '';

    if (mediaType === 'video') {
        mediaHtml = `
            <video controls autoplay muted loop playsinline>
                <source src="${decodedMediaUrl}" type="video/mp4">
                Seu navegador não suporta a tag de vídeo.
            </video>
        `;
    } else {
        mediaHtml = `<img src="${decodedMediaUrl}" alt="Conteúdo do Instagram">`;
    }

    const timestampText = timestamp
        ? new Date(timestamp).toLocaleDateString('pt-BR', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          })
        : 'Data desconhecida';

    contentDisplay.innerHTML = `
        <div class="content-card">
            <div class="content-header">
                <div class="content-meta">
                    <div class="content-author">@${escapeHtml(author)}</div>
                    <div class="content-timestamp">${timestampText}</div>
                </div>
            </div>

            <div class="content-media">
                ${mediaHtml}
            </div>

            ${caption ? `
                <div class="content-caption">${escapeHtml(caption)}</div>
            ` : ''}
        </div>
    `;

    contentDisplay.classList.add('visible');

    // Scroll to content smoothly
    setTimeout(() => {
        contentDisplay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 200);
}

// Validate Instagram URL
function isValidInstagramUrl(url) {
    const patterns = [
        /^https?:\/\/(www\.)?instagram\.com\/p\/[\w-]+\/?/,
        /^https?:\/\/(www\.)?instagram\.com\/reel\/[\w-]+\/?/,
        /^https?:\/\/(www\.)?instagram\.com\/tv\/[\w-]+\/?/
    ];

    return patterns.some(pattern => pattern.test(url));
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// UI Helper functions
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.add('visible');
    setTimeout(() => {
        errorMessage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}

function hideError() {
    errorMessage.classList.remove('visible');
    setTimeout(() => {
        errorMessage.textContent = '';
    }, 300);
}

function showLoading() {
    loadingMessage.classList.add('visible');
    loadBtn.disabled = true;
}

function hideLoading() {
    loadingMessage.classList.remove('visible');
    loadBtn.disabled = false;
}

function hideContent() {
    contentDisplay.classList.remove('visible');
    setTimeout(() => {
        contentDisplay.innerHTML = '';
    }, 300);
}

// Check backend health
async function checkBackendHealth() {
    try {
        const response = await fetch(API_URL.replace('/api/fetch-content', '/health'));
        if (response.ok) {
            console.log('✅ Backend está em execução');
        }
    } catch (error) {
        console.warn('⚠️ O servidor backend não está em execução. Por favor, inicie com: npm start');
    }
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
    // Initialize theme
    initTheme();

    // Auto-focus input
    urlInput.focus();

    // Check if backend is running
    checkBackendHealth();

    // Initialize clear button state
    updateClearButton();
});

// Add visual feedback for paste events
urlInput.addEventListener('paste', () => {
    setTimeout(() => {
        if (isValidInstagramUrl(urlInput.value.trim())) {
            urlInput.style.borderColor = 'var(--accent-primary)';
            setTimeout(() => {
                urlInput.style.borderColor = '';
            }, 1000);
        }
    }, 100);
});
