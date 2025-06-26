// File: local-fingerprint-agent/agent.js (Advanced Version)
const http = require('http');
const path = require("path");
const { spawn } = require("child_process");
const url = require('url');
const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto'); // For generating a unique job ID

// --- Configuration ---
const AGENT_PORT = 9876;
const PYTHON_SCRIPT_NAME = "demo.py";
const PYTHON_SCRIPT_PATH = path.resolve(__dirname, "scripts", PYTHON_SCRIPT_NAME);
const PYTHON_EXECUTABLE = "python";
const APP3_SERVER_URL = "http://10.66.39.12:3030/api/v1/fingerprint";

// --- State Management ---
let isProcessing = false; // Flag to prevent concurrent requests
const jobs = {}; // In-memory object to store job status

console.log(`[LocalAgent] Python script expected at: ${PYTHON_SCRIPT_PATH}`);
console.log(`[LocalAgent] Python executable: ${PYTHON_EXECUTABLE}`);
console.log(`[LocalAgent] Will forward processed data to App 3 at: ${APP3_SERVER_URL}`);

// --- Helper Functions ---
function updateJobStatus(jobId, status, details = {}) {
    if (jobs[jobId]) {
        jobs[jobId].status = status;
        jobs[jobId].details = details;
        jobs[jobId].lastUpdate = Date.now();
        console.log(`[LocalAgent] Job ${jobId} status updated to: ${status}`);
    }
}

// --- Main Server Logic ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathParts = parsedUrl.pathname.split('/');

    // --- Endpoint for starting a new job ---
    if (req.method === 'POST' && parsedUrl.pathname === '/capture-and-process') {
        if (isProcessing) {
            console.warn("[LocalAgent] Rejected new request: A process is already running.");
            res.writeHead(503, { 'Content-Type': 'application/json' }); // 503 Service Unavailable
            res.end(JSON.stringify({ error: "Agent is busy with a previous request. Please wait." }));
            return;
        }

        let requestBody = '';
        const decoder = new StringDecoder('utf-8');
        req.on('data', chunk => { requestBody += decoder.write(chunk); });
        req.on('end', () => {
            requestBody += decoder.end();
            let clientData = {};
            try { if (requestBody) clientData = JSON.parse(requestBody); }
            catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Invalid JSON in request body." }));
                return;
            }

            const { nin, fingerCode } = clientData;
            if (!nin || !fingerCode) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "NIN and FingerCode are required." }));
                return;
            }

            // --- Start the job ---
            isProcessing = true;
            const jobId = crypto.randomUUID();
            jobs[jobId] = { status: 'pending', createdAt: Date.now(), lastUpdate: Date.now() };

            // Respond immediately with 202 Accepted and the jobId
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jobId, message: "Request accepted for processing." }));

            // --- Run the actual process in the background ---
            processFingerprintJob(jobId, nin, fingerCode);
        });

    // --- Endpoint for checking job status ---
    } else if (req.method === 'GET' && pathParts[1] === 'status' && pathParts[2]) {
        const jobId = pathParts[2];
        const job = jobs[jobId];

        if (job) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(job));
            // Clean up job if it's complete or errored to prevent memory buildup
            if (job.status === 'complete' || job.status === 'error') {
                setTimeout(() => delete jobs[jobId], 2000); // Remove after 2 seconds
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Job not found." }));
        }

    // --- Simple agent status endpoint ---
    } else if (req.method === 'GET' && parsedUrl.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: "LocalFingerprintAgent is running", version: "2.0.0", isProcessing }));
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Not Found" }));
    }
});

// --- Background Job Processor ---
async function processFingerprintJob(jobId, nin, fingerCode) {
    try {
        updateJobStatus(jobId, 'capturing_fingerprint', { message: 'Waiting for fingerprint from device...' });

        // Step 1: Run Python Script
        const { fingerprintImageBase64 } = await runPythonCapture();
        updateJobStatus(jobId, 'capture_complete', { message: 'Fingerprint captured successfully.' });

        // Step 2: Call App 3
        updateJobStatus(jobId, 'forwarding_to_server', { message: `Sending data to ${APP3_SERVER_URL}...` });
        const app3Response = await axios.post(APP3_SERVER_URL, {
            nin,
            fingerCode,
            fingerprintImageBase64
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 70000
        });

        // Step 3: Job is complete with a successful result
        updateJobStatus(jobId, 'complete', { result: app3Response.data });

    } catch (error) {
        // Handle any error from Python or Axios and update job status
        console.error(`[LocalAgent] Error in job ${jobId}:`, error);
        const errorDetails = {
            message: error.message,
            statusCode: error.response?.status,
            responseData: error.response?.data
        };
        updateJobStatus(jobId, 'error', { error: errorDetails });
    } finally {
        // IMPORTANT: Reset the processing flag when the job is done.
        isProcessing = false;
        console.log(`[LocalAgent] Processing finished for job ${jobId}. Agent is now free.`);
    }
}

// Promisified function to run the Python script
function runPythonCapture() {
    return new Promise((resolve, reject) => {
        const pythonProcess = spawn(PYTHON_EXECUTABLE, [PYTHON_SCRIPT_PATH]);
        let fingerprintImageBase64 = null;
        let pythonStdoutBuffer = "";
        let pythonStderrBuffer = "";

        pythonProcess.stdout.on("data", (data) => {
            pythonStdoutBuffer += data.toString();
            // ... parsing logic from before ...
            if (pythonStdoutBuffer.includes("FINGERPRINT_WSQ_B64:")) {
                const line = pythonStdoutBuffer.split(/[\r\n]+/).find(l => l.startsWith("FINGERPRINT_WSQ_B64:"));
                if (line) {
                    fingerprintImageBase64 = line.replace("FINGERPRINT_WSQ_B64:", "").trim();
                }
            }
        });
        pythonProcess.stderr.on("data", (data) => { pythonStderrBuffer += data.toString(); });
        pythonProcess.on("error", (error) => { reject(new Error(`Failed to start Python process: ${error.message}`)); });
        pythonProcess.on("close", (code) => {
            if (code !== 0) {
                return reject(new Error(`Python script failed with code ${code}. Stderr: ${pythonStderrBuffer}`));
            }
            if (!fingerprintImageBase64) {
                return reject(new Error(`No fingerprint data received from script. Stdout: ${pythonStdoutBuffer}`));
            }
            resolve({ fingerprintImageBase64 });
        });
    });
}


server.listen(AGENT_PORT, '127.0.0.1', () => { /* ... */ });
process.on('SIGINT', () => { /* ... */ });