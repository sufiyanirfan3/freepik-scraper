const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const archiver = require("archiver");

const app = express();
const upload = multer({ dest: "uploads/" });

// Create necessary directories
const outputDir = "./downloaded_images";
const tempDir = "./temp_downloads";
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}
if (!fs.existsSync("./uploads")) {
  fs.mkdirSync("./uploads");
}

// Store active processing sessions
const activeSessions = new Map();

// Track downloaded files for cleanup
const downloadedZips = new Map(); // filename -> timestamp

// Download image function
async function downloadImage(url, filepath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
    timeout: 30000,
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// Extract query from Freepik URL
function extractQueryFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const query = urlObj.searchParams.get("query");
    if (query) {
      return query.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    }
    return "images";
  } catch (error) {
    return "images";
  }
}

// Create zip file
async function createZipFile(imageFiles, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", {
      zlib: { level: 9 },
    });

    output.on("close", () => {
      resolve();
    });

    archive.on("error", (err) => {
      reject(err);
    });

    archive.pipe(output);

    imageFiles.forEach((file, index) => {
      const filename = `image_${index + 1}${path.extname(file)}`;
      archive.file(file, { name: filename });
    });

    archive.finalize();
  });
}

// Parse URLs from file
async function parseUrlsFromFile(filepath, fileExtension) {
  return new Promise((resolve, reject) => {
    const urls = [];

    if (fileExtension === ".txt") {
      const content = fs.readFileSync(filepath, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && trimmed.startsWith("http")) {
          urls.push(trimmed);
        }
      });
      resolve(urls);
    } else if (fileExtension === ".csv") {
      fs.createReadStream(filepath)
        .pipe(csv())
        .on("data", (row) => {
          const urlKey = Object.keys(row).find(
            (key) => key.toLowerCase() === "urls" || key.toLowerCase() === "url"
          );
          if (urlKey && row[urlKey] && row[urlKey].startsWith("http")) {
            urls.push(row[urlKey].trim());
          }
        })
        .on("end", () => {
          resolve(urls);
        })
        .on("error", (error) => {
          reject(error);
        });
    } else {
      reject(new Error("Unsupported file type"));
    }
  });
}

// Cleanup old ZIP files (delete after 5 minutes of being downloaded)
function cleanupOldZips() {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes

  downloadedZips.forEach((timestamp, filename) => {
    if (now - timestamp > maxAge) {
      const filepath = path.join(outputDir, filename);
      if (fs.existsSync(filepath)) {
        try {
          fs.unlinkSync(filepath);
          console.log(`🗑️  Cleaned up: ${filename}`);
          downloadedZips.delete(filename);
        } catch (error) {
          console.error(`Failed to delete ${filename}:`, error.message);
        }
      }
    }
  });
}

// Run cleanup every minute
setInterval(cleanupOldZips, 60000);

// Process a single URL
async function processSingleUrl(freepikUrl, urlIndex, session) {
  const { imageLimit } = session;
  const query = extractQueryFromUrl(freepikUrl);
  const timestamp = Date.now() + urlIndex;
  const urlTempDir = path.join(tempDir, `${query}_${timestamp}`);

  // Update status to processing
  session.urlsData[urlIndex].status = "processing";
  session.urlsData[urlIndex].progress = "Launching browser...";
  session.urlsData[urlIndex].progressPercent = 5;

  console.log(`\n[${urlIndex + 1}] Processing: ${freepikUrl}`);
  console.log(`Image limit: ${imageLimit ? imageLimit : "unlimited"}`);

  if (!fs.existsSync(urlTempDir)) {
    fs.mkdirSync(urlTempDir, { recursive: true });
  }

  try {
    const puppeteer = require("puppeteer");

    session.urlsData[urlIndex].progress = "Opening page...";
    session.urlsData[urlIndex].progressPercent = 10;

 const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: puppeteer.executablePath(),
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-software-rasterizer'
    ]
});

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    session.urlsData[urlIndex].progress = "Loading page...";
    session.urlsData[urlIndex].progressPercent = 15;

    await page.goto(freepikUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("figure img", { timeout: 10000 });

    // Get total results count from the page
    const totalResults = await page.evaluate(() => {
      const resultsElement = document.querySelector(
        "span.flex.items-center.whitespace-nowrap"
      );
      if (resultsElement) {
        const text = resultsElement.textContent.trim();
        const match = text.match(/(\d+)\s+results?/);
        return match ? parseInt(match[1]) : 500;
      }
      return 500;
    });

    // Apply image limit if set
    const targetImages = imageLimit
      ? Math.min(totalResults, imageLimit)
      : totalResults;

    console.log(
      `  [${
        urlIndex + 1
      }] 🎯 Total results: ${totalResults}, Target: ${targetImages}`
    );
    session.urlsData[urlIndex].progress = imageLimit
      ? `Found ${totalResults} results. Loading ${targetImages} images (limit applied)...`
      : `Found ${totalResults} results. Loading all images...`;
    session.urlsData[urlIndex].progressPercent = 20;

    // Scroll to load images
    let previousImageCount = 0;
    let attempts = 0;
    let noNewImagesCount = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await new Promise((resolve) => setTimeout(resolve, 1500));

      try {
        const loadMoreButton = await page.$(
          'button[data-testid="load-more-button"]'
        );
        if (loadMoreButton) {
          console.log(`  [${urlIndex + 1}] 🔘 Clicking "Load more" button...`);
          await loadMoreButton.click();
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (error) {}

      const currentImageCount = await page.evaluate(() => {
        return document.querySelectorAll("figure img").length;
      });

      const scrollProgress = 20 + (currentImageCount / targetImages) * 40;
      session.urlsData[
        urlIndex
      ].progress = `Loading images... ${currentImageCount}/${targetImages}`;
      session.urlsData[urlIndex].progressPercent = Math.min(
        Math.floor(scrollProgress),
        60
      );

      console.log(
        `  [${urlIndex + 1}] 📸 Attempt ${
          attempts + 1
        }: Found ${currentImageCount}/${targetImages} images`
      );

      // Check if we've reached or exceeded the target
      if (currentImageCount >= targetImages) {
        console.log(
          `  [${urlIndex + 1}] ✅ Reached target of ${targetImages} images!`
        );
        break;
      }

      // Check if new images loaded
      if (currentImageCount === previousImageCount) {
        noNewImagesCount++;
        console.log(
          `  [${urlIndex + 1}] No new images loaded (${noNewImagesCount}/5)`
        );

        if (noNewImagesCount >= 5) {
          console.log(
            `  [${
              urlIndex + 1
            }] ⚠️  No more images loading. Final count: ${currentImageCount} images`
          );
          break;
        }
      } else {
        noNewImagesCount = 0;
      }

      previousImageCount = currentImageCount;
      attempts++;
    }

    // Wait for lazy-loaded images
    await new Promise((resolve) => setTimeout(resolve, 3000));

    session.urlsData[urlIndex].progress = "Extracting image URLs...";
    session.urlsData[urlIndex].progressPercent = 60;

    const imageUrls = await page.evaluate(() => {
      const images = [];
      const figures = document.querySelectorAll("figure img");
      figures.forEach((img) => {
        const src = img.getAttribute("src");
        if (src && src.startsWith("http")) {
          images.push(src);
        }
      });
      return images;
    });

    await browser.close();

    // Apply limit to extracted URLs if needed
    const finalImageUrls = imageLimit
      ? imageUrls.slice(0, imageLimit)
      : imageUrls;

    console.log(
      `  [${urlIndex + 1}] ✅ Extracted ${
        imageUrls.length
      } images, downloading ${finalImageUrls.length} images`
    );

    session.urlsData[
      urlIndex
    ].progress = `Downloading ${finalImageUrls.length} images...`;
    session.urlsData[urlIndex].progressPercent = 65;

    // Download images
    const downloadedFiles = [];
    for (let i = 0; i < finalImageUrls.length; i++) {
      const imageUrl = finalImageUrls[i];
      const ext = path.extname(new URL(imageUrl).pathname) || ".jpg";
      const filename = `image_${i + 1}${ext}`;
      const filepath = path.join(urlTempDir, filename);

      try {
        await downloadImage(imageUrl, filepath);
        downloadedFiles.push(filepath);

        const downloadProgress = 65 + (i / finalImageUrls.length) * 25;
        if ((i + 1) % 10 === 0 || i === finalImageUrls.length - 1) {
          session.urlsData[urlIndex].progress = `Downloaded ${i + 1}/${
            finalImageUrls.length
          } images`;
          session.urlsData[urlIndex].progressPercent =
            Math.floor(downloadProgress);
        }
      } catch (error) {
        console.error(
          `  [${urlIndex + 1}] ❌ Failed to download image ${i + 1}:`,
          error.message
        );
      }
    }

    session.urlsData[urlIndex].progress = "Creating ZIP file...";
    session.urlsData[urlIndex].progressPercent = 90;

    // Create ZIP
    const zipFileName = `${query}_${timestamp}.zip`;
    const zipFilePath = path.join(outputDir, zipFileName);

    await createZipFile(downloadedFiles, zipFilePath);

    // Clean up temp directory immediately after creating ZIP
    fs.rmSync(urlTempDir, { recursive: true, force: true });
    console.log(`  [${urlIndex + 1}] 🗑️  Cleaned up temp directory`);

    session.urlsData[urlIndex].status = "completed";
    session.urlsData[
      urlIndex
    ].progress = `✅ Completed! ${downloadedFiles.length} images`;
    session.urlsData[urlIndex].progressPercent = 100;
    session.urlsData[urlIndex].zipFile = zipFileName;

    console.log(
      `  [${urlIndex + 1}] ✅ Completed: ${zipFileName} with ${
        downloadedFiles.length
      } images`
    );
  } catch (error) {
    console.error(`  [${urlIndex + 1}] ❌ Error: ${error.message}`);

    session.urlsData[urlIndex].status = "error";
    session.urlsData[urlIndex].progress = `❌ Error: ${error.message}`;
    session.urlsData[urlIndex].progressPercent = 0;

    // Clean up temp directory on error
    if (fs.existsSync(urlTempDir)) {
      fs.rmSync(urlTempDir, { recursive: true, force: true });
      console.log(
        `  [${urlIndex + 1}] 🗑️  Cleaned up temp directory after error`
      );
    }
  }
}

// Serve HTML page
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Downloader</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            max-width: 700px;
            width: 100%;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .upload-area {
            border: 3px dashed #667eea;
            border-radius: 10px;
            padding: 40px;
            text-align: center;
            margin-bottom: 20px;
            transition: all 0.3s;
            cursor: pointer;
        }
        .upload-area:hover {
            border-color: #764ba2;
            background: #f8f9ff;
        }
        .upload-area.dragover {
            background: #e8ebff;
            border-color: #764ba2;
        }
        input[type="file"] {
            display: none;
        }
        .file-label {
            color: #667eea;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .file-info {
            margin-top: 15px;
            color: #666;
            font-size: 14px;
        }
        .limit-section {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
        }
        .limit-label {
            color: #333;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 10px;
            display: block;
        }
        .limit-input {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        .limit-input:focus {
            outline: none;
            border-color: #667eea;
        }
        .limit-hint {
            color: #666;
            font-size: 12px;
            margin-top: 5px;
        }
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 40px;
            border-radius: 50px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        .progress-section {
            margin-top: 20px;
            display: none;
        }
        .batch-info {
            background: #e3f2fd;
            border-left: 4px solid #2196f3;
            padding: 12px;
            margin-bottom: 15px;
            border-radius: 5px;
            color: #1976d2;
            font-weight: 600;
            font-size: 14px;
        }
        .url-card {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #667eea;
        }
        .url-card.processing {
            border-left-color: #ffc107;
            animation: pulse 2s infinite;
        }
        .url-card.completed {
            border-left-color: #28a745;
        }
        .url-card.error {
            border-left-color: #dc3545;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        .url-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .url-title {
            font-weight: 600;
            color: #333;
            font-size: 14px;
        }
        .url-status {
            font-size: 12px;
            padding: 4px 12px;
            border-radius: 12px;
            font-weight: 600;
        }
        .status-pending {
            background: #e9ecef;
            color: #6c757d;
        }
        .status-processing {
            background: #fff3cd;
            color: #856404;
        }
        .status-completed {
            background: #d4edda;
            color: #155724;
        }
        .status-error {
            background: #f8d7da;
            color: #721c24;
        }
        .url-progress {
            font-size: 13px;
            color: #666;
            margin-top: 5px;
            min-height: 18px;
        }
        .url-progress-bar {
            background: #e9ecef;
            border-radius: 10px;
            height: 6px;
            overflow: hidden;
            margin-top: 8px;
        }
        .url-progress-fill {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            height: 100%;
            width: 0%;
            transition: width 0.3s;
        }
        .download-message {
            color: #28a745;
            font-weight: 600;
            margin-top: 10px;
            font-size: 13px;
        }
        .note {
            background: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 8px;
            padding: 15px;
            margin-top: 20px;
            font-size: 13px;
            color: #856404;
        }
        .note strong {
            display: block;
            margin-bottom: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📥 Image Downloader</h1>
        <p class="subtitle">Upload Freepik URLs to download images as ZIP files (Parallel processing)</p>
        
        <form id="uploadForm" enctype="multipart/form-data">
            <div class="upload-area" id="uploadArea">
                <input type="file" id="fileInput" name="file" accept=".txt,.csv" required>
                <label for="fileInput" class="file-label">
                    📄 Click to select or drag & drop a file
                </label>
                <div class="file-info" id="fileInfo">Supported: .txt or .csv files</div>
            </div>
            
            <div class="limit-section">
                <label class="limit-label" for="imageLimit">🔢 Image Limit Per URL</label>
                <input 
                    type="number" 
                    id="imageLimit" 
                    name="imageLimit" 
                    class="limit-input" 
                    placeholder="Leave empty for unlimited"
                    min="1"
                >
                <div class="limit-hint">Enter a number to limit images per URL (e.g., 50). Leave empty to download all available images.</div>
            </div>
            
            <button type="submit" id="submitBtn">Start Download</button>
        </form>
        
        <div class="progress-section" id="progressSection">
            <div class="batch-info" id="batchInfo">Processing in batches of 10 URLs...</div>
            <div id="urlCards"></div>
        </div>
        
        <div class="note">
            <strong>📋 File Format:</strong>
            <strong>TXT:</strong> One Freepik URL per line<br>
            <strong>CSV:</strong> Column named "urls" or "url" with Freepik URLs<br>
            <strong>Note:</strong> ZIP files auto-download and are deleted from server after 5 minutes. Processing 10 URLs in parallel!
        </div>
    </div>

    <script>
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        const fileInfo = document.getElementById('fileInfo');
        const uploadForm = document.getElementById('uploadForm');
        const submitBtn = document.getElementById('submitBtn');
        const progressSection = document.getElementById('progressSection');
        const urlCards = document.getElementById('urlCards');
        const imageLimitInput = document.getElementById('imageLimit');
        const batchInfo = document.getElementById('batchInfo');
        
        let sessionId = null;
        let pollInterval = null;
        let downloadedFiles = new Set();

        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                fileInput.files = files;
                updateFileInfo(files[0]);
            }
        });

        uploadArea.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                updateFileInfo(e.target.files[0]);
            }
        });

        function updateFileInfo(file) {
            fileInfo.textContent = 'Selected: ' + file.name + ' (' + (file.size / 1024).toFixed(2) + ' KB)';
        }

        function createUrlCard(index, query) {
            return '<div class="url-card" id="card-' + index + '">' +
                '<div class="url-header">' +
                '<div class="url-title">🔗 ' + query + '</div>' +
                '<div class="url-status status-pending" id="status-' + index + '">Pending</div>' +
                '</div>' +
                '<div class="url-progress" id="progress-' + index + '">Waiting to start...</div>' +
                '<div class="url-progress-bar">' +
                '<div class="url-progress-fill" id="progress-fill-' + index + '"></div>' +
                '</div>' +
                '<div id="download-' + index + '"></div>' +
                '</div>';
        }

        function updateCard(index, status, progress, progressPercent, downloadLink) {
            const card = document.getElementById('card-' + index);
            const statusEl = document.getElementById('status-' + index);
            const progressEl = document.getElementById('progress-' + index);
            const progressFill = document.getElementById('progress-fill-' + index);
            const downloadEl = document.getElementById('download-' + index);

            if (card) {
                card.className = 'url-card ' + status;
            }

            if (statusEl) {
                statusEl.className = 'url-status status-' + status;
                statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
            }

            if (progressEl) {
                progressEl.textContent = progress;
            }

            if (progressFill) {
                progressFill.style.width = progressPercent + '%';
            }

            if (downloadLink && downloadEl && !downloadedFiles.has(downloadLink)) {
                downloadedFiles.add(downloadLink);
                
                const downloadUrl = '/download/' + downloadLink;
                
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = downloadLink;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                
                setTimeout(function() {
                    document.body.removeChild(a);
                }, 100);
                
                downloadEl.innerHTML = '<div class="download-message">📥 Downloaded automatically! (Will be deleted from server in 5 min)</div>';
            }
        }

        async function pollProgress() {
            if (!sessionId) return;

            try {
                const response = await fetch('/progress/' + sessionId);
                const data = await response.json();

                if (data.urls) {
                    data.urls.forEach(function(urlData, index) {
                        updateCard(
                            index,
                            urlData.status,
                            urlData.progress,
                            urlData.progressPercent,
                            urlData.zipFile
                        );
                    });
                    
                    // Update batch info
                    const processing = data.urls.filter(u => u.status === 'processing').length;
                    const completed = data.urls.filter(u => u.status === 'completed').length;
                    const total = data.urls.length;
                    batchInfo.textContent = 'Processing ' + processing + ' URLs in parallel | Completed: ' + completed + '/' + total;
                }

                if (data.completed) {
                    clearInterval(pollInterval);
                    submitBtn.disabled = false;
                    batchInfo.textContent = '✅ All URLs processed! Files will be auto-deleted in 5 minutes.';
                }
            } catch (error) {
                console.error('Poll error:', error);
            }
        }

        uploadForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const formData = new FormData(uploadForm);
            
            const limitValue = imageLimitInput.value.trim();
            if (limitValue) {
                formData.append('imageLimit', parseInt(limitValue));
            }
            
            submitBtn.disabled = true;
            progressSection.style.display = 'block';
            urlCards.innerHTML = '';
            downloadedFiles.clear();
            
            try {
                const initResponse = await fetch('/init-upload', {
                    method: 'POST',
                    body: formData
                });
                
                const initResult = await initResponse.json();
                
                if (initResult.success) {
                    sessionId = initResult.sessionId;
                    
                    initResult.urls.forEach(function(url, index) {
                        const query = new URL(url).searchParams.get('query') || 'images';
                        urlCards.innerHTML += createUrlCard(index, query);
                    });

                    pollInterval = setInterval(pollProgress, 500);

                    fetch('/process/' + sessionId, { method: 'POST' });
                } else {
                    alert('Error: ' + initResult.message);
                    submitBtn.disabled = false;
                }
            } catch (error) {
                alert('Error: ' + error.message);
                submitBtn.disabled = false;
            }
        });
    </script>
</body>
</html>`);
});

// Initialize upload and create session
app.post("/init-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ success: false, message: "No file uploaded" });
    }

    const filePath = req.file.path;
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    const imageLimit = req.body.imageLimit
      ? parseInt(req.body.imageLimit)
      : null;

    // Parse URLs from file
    const urls = await parseUrlsFromFile(filePath, fileExtension);

    if (urls.length === 0) {
      fs.unlinkSync(filePath);
      return res.json({
        success: false,
        message: "No valid URLs found in file",
      });
    }

    // Create session
    const sessionId = Date.now().toString();
    activeSessions.set(sessionId, {
      filePath,
      urls,
      imageLimit,
      urlsData: urls.map((url, index) => ({
        url,
        query: extractQueryFromUrl(url),
        status: "pending",
        progress: "Waiting to start...",
        progressPercent: 0,
        zipFile: null,
      })),
      completed: false,
    });

    console.log(
      `\nImage limit set to: ${imageLimit ? imageLimit : "unlimited"}`
    );
    console.log(`Processing ${urls.length} URLs in batches of 10\n`);

    res.json({
      success: true,
      sessionId,
      urls,
    });
  } catch (error) {
    console.error("Init error:", error);
    res.json({ success: false, message: error.message });
  }
});

// Get progress for a session
app.get("/progress/:sessionId", (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (session) {
    res.json({
      urls: session.urlsData,
      completed: session.completed,
    });
  } else {
    res.json({ error: "Session not found" });
  }
});

// Process URLs in batches of 10
app.post("/process/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.json({ success: false, message: "Session not found" });
  }

  // Send immediate response
  res.json({ success: true, message: "Processing started" });

  // Process in background
  const { urls, filePath } = session;
  const BATCH_SIZE = 10;

  // Split URLs into batches
  for (let batchStart = 0; batchStart < urls.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, urls.length);
    const batch = urls.slice(batchStart, batchEnd);

    console.log(
      `\n🔄 Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}: URLs ${
        batchStart + 1
      }-${batchEnd}`
    );

    // Process batch in parallel
    const batchPromises = batch.map((url, batchIndex) => {
      const urlIndex = batchStart + batchIndex;
      return processSingleUrl(url, urlIndex, session);
    });

    // Wait for current batch to complete before starting next batch
    await Promise.all(batchPromises);

    console.log(
      `\n✅ Batch ${Math.floor(batchStart / BATCH_SIZE) + 1} completed\n`
    );
  }

  // Clean up uploaded file
  fs.unlinkSync(filePath);
  session.completed = true;

  console.log("\n🎉 All URLs processed!\n");

  // Clean up session after 1 hour
  setTimeout(() => {
    activeSessions.delete(sessionId);
  }, 3600000);
});

// Serve ZIP files for download
app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(outputDir, filename);

  if (fs.existsSync(filepath)) {
    // Mark file as downloaded for cleanup
    downloadedZips.set(filename, Date.now());

    res.download(filepath, filename, (err) => {
      if (err) {
        console.error("Download error:", err);
      } else {
        console.log(
          `📥 Downloaded: ${filename} (will be deleted in 5 minutes)`
        );
      }
    });
  } else {
    res.status(404).send("File not found");
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`📁 ZIP files will be saved to: ${path.resolve(outputDir)}`);
  console.log(`⚡ Parallel processing: 10 URLs at a time`);
  console.log(`🗑️  Auto-cleanup: ZIP files deleted 5 minutes after download\n`);
});
