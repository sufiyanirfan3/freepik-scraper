const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Create output directory if it doesn't exist
const outputDir = './output';
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

// Function to modify image URL parameters
function modifyImageUrl(url) {
    try {
        const urlObj = new URL(url);
        
        // // Update or set the width parameter
        // urlObj.searchParams.set('w', width);
        
        // // Update or set the quality parameter
        // urlObj.searchParams.set('q', quality);
        
        return urlObj.toString();
    } catch (error) {
        console.error('Error modifying URL:', error.message);
        return url; // Return original URL if modification fails
    }
}

async function downloadImage(url, filepath) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Function to auto-scroll and click "Load more" button
async function autoScrollWithLoadMore(page, targetImages = 600, maxAttempts = 100) {
    let previousImageCount = 0;
    let attempts = 0;
    let noNewImagesCount = 0;
    
    while (attempts < maxAttempts && noNewImagesCount < 5) {
        // Scroll down to trigger lazy loading
        await page.evaluate(() => {
            window.scrollBy(0, 1200);
        });
        
        // Wait a bit for content to load
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Check for "Load more" button and click it
        try {
            const loadMoreButton = await page.$('button[data-testid="load-more-button"]');
            if (loadMoreButton) {
                console.log('🔘 Found "Load more" button, clicking...');
                await loadMoreButton.click();
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for new images to load
            }
        } catch (error) {
            // Button not found or not clickable, continue scrolling
        }
        
        // Count current images
        const currentImageCount = await page.evaluate(() => {
            return document.querySelectorAll('figure img').length;
        });
        
        console.log(`Attempt ${attempts + 1}: Found ${currentImageCount} images`);
        
        // Check if new images loaded
        if (currentImageCount === previousImageCount) {
            noNewImagesCount++;
            console.log(`No new images loaded (${noNewImagesCount}/5)`);
            
            if (noNewImagesCount >= 5) {
                console.log(`\n⚠️  No more images loading. Final count: ${currentImageCount} images`);
                break;
            }
        } else {
            noNewImagesCount = 0; // Reset counter when new images are found
        }
        
        previousImageCount = currentImageCount;
        attempts++;
        
        // Stop if we've reached target
        if (currentImageCount >= targetImages) {
            console.log(`✅ Reached target of ${targetImages} images!`);
            break;
        }
    }
    
    console.log(`\nFinal count: ${previousImageCount} images after ${attempts} attempts`);
    return previousImageCount;
}

async function scrapeImages() {
    let browser;
    try {
        console.log('Launching browser...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        
        // Set viewport and user agent
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        const url = 'https://www.freepik.com/search?ai=excluded&format=search&last_filter=orientation&last_value=square&orientation=square&query=Karachi';
        
        console.log('Navigating to page...');
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
        
        // Wait for initial images to load
        console.log('Waiting for initial images to load...');
        await page.waitForSelector('figure img', { timeout: 10000 });
        
        // Get total results count from the page
        const totalResults = await page.evaluate(() => {
            const resultsElement = document.querySelector('span.flex.items-center.whitespace-nowrap');
            if (resultsElement) {
                const text = resultsElement.textContent.trim();
                const match = text.match(/(\d+)\s+results?/);
                return match ? parseInt(match[1]) : 500; // Default to 500 if not found
            }
            return 500;
        });
        
        console.log(`🎯 Target: ${totalResults} results found on page`);
        
        // Scroll to load more images (it will stop when no new images load)
        console.log('Scrolling to load all images...');
        await autoScrollWithLoadMore(page, totalResults, 100); // Use dynamic count, max 100 attempts
        
        // Wait a bit more for lazy-loaded images
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Extract image URLs
        const imageUrls = await page.evaluate(() => {
            const images = [];
            const figures = document.querySelectorAll('figure img');
            
            figures.forEach((img) => {
                const src = img.getAttribute('src');
                if (src && src.startsWith('http')) {
                    images.push(src);
                }
            });
            
            return images;
        });
        
        console.log(`Found ${imageUrls.length} images`);
        
        // Modify URLs to get higher quality and larger size
        const modifiedUrls = imageUrls.map(url => modifyImageUrl(url));
        
        // Console log original and modified URLs
        console.log('\n📸 Original URLs:');
        console.log('================');
        imageUrls.forEach((url, index) => {
            console.log(`${index + 1}. ${url}`);
        });
        console.log('================\n');
        
        console.log('🎨 Modified URLs (w=2000, q=100):');
        console.log('================');
        modifiedUrls.forEach((url, index) => {
            console.log(`${index + 1}. ${url}`);
        });
        console.log('================\n');
        
        await browser.close();
        
        if (modifiedUrls.length === 0) {
            console.log('No images found. The page structure might have changed.');
            return;
        }
        
        // Download each image with modified URL
        for (let i = 0; i < modifiedUrls.length; i++) {
            const imageUrl = modifiedUrls[i];
            const filename = `image_${i + 1}_2000x_q100.jpg`;
            const filepath = path.join(outputDir, filename);
            
            console.log(`Downloading ${i + 1}/${modifiedUrls.length}: ${filename}`);
            
            try {
                await downloadImage(imageUrl, filepath);
                console.log(`✓ Saved: ${filename}`);
            } catch (error) {
                console.error(`✗ Failed to download ${filename}:`, error.message);
            }
        }
        
        console.log('\n✨ Done! High-quality images saved to ./output folder');
        
    } catch (error) {
        console.error('Error:', error.message);
        if (browser) {
            await browser.close();
        }
    }
}

scrapeImages();