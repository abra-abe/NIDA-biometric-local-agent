// File: local-fingerprint-agent/agent.js (Modified)
const http = require('http');
const path = require("path");
const { spawn } = require("child_process");
const url = require('url');
const axios = require('axios'); 
const { StringDecoder } = require('string_decoder');

// --- Configuration ---
const AGENT_PORT = 9876;
const PYTHON_SCRIPT_NAME = "demo.py";
const PYTHON_SCRIPT_PATH = path.resolve(__dirname, "scripts", PYTHON_SCRIPT_NAME);
const PYTHON_EXECUTABLE = "python";

// URL of your App 3 (Node.js SOAP Client that calls the C# service)
const APP3_SERVER_URL = "http://10.66.39.12:3030/api/v1/fingerprint"; 

console.log(`[LocalAgent] Python script expected at: ${PYTHON_SCRIPT_PATH}`);
console.log(`[LocalAgent] Python executable: ${PYTHON_EXECUTABLE}`);
console.log(`[LocalAgent] Will forward processed data to App 3 at: ${APP3_SERVER_URL}`);


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

    if (req.method === 'POST' && (parsedUrl.pathname === '/capture-and-process' || parsedUrl.pathname === '/capture')) { // Keep /capture for backward compatibility or simpler calls
        console.log('[LocalAgent] Received /capture-and-process request.');

        let requestBody = '';
        const decoder = new StringDecoder('utf-8');
        req.on('data', chunk => {
            requestBody += decoder.write(chunk);
        });

        req.on('end', async () => {
            requestBody += decoder.end();
            let clientData = {};
            try {
                if (requestBody) {
                    clientData = JSON.parse(requestBody);
                }
            } catch (e) {
                console.error("[LocalAgent] Invalid JSON in request body:", e);
                if (!res.writableEnded) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Invalid JSON in request body." }));
                }
                return;
            }

            const { nin, fingerCode } = clientData;

            if (parsedUrl.pathname === '/capture-and-process' && (!nin || !fingerCode)) {
                 if (!res.writableEnded) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    console.error("[LocalAgent] Missing NIN or FingerCode in /capture-and-process request.");
                    res.end(JSON.stringify({ error: "NIN and FingerCode are required for /capture-and-process endpoint." }));
                }
                return;
            }


            const pythonProcess = spawn(PYTHON_EXECUTABLE, [PYTHON_SCRIPT_PATH]);
            // ... (Python script spawning and output handling logic - same as before) ...
            let fingerprintImageBase64 = null;
            let pythonStdoutBuffer = "";
            let pythonStderrBuffer = "";

            pythonProcess.stdout.on("data", (data) => { 
                const outputChunk = data.toString();
                pythonStdoutBuffer += outputChunk;
                let boundary = pythonStdoutBuffer.lastIndexOf('\n');
                if (boundary === -1 && pythonStdoutBuffer.length < 3000000) {
                    if (!pythonStdoutBuffer.includes("FINGERPRINT_WSQ_B64:")) return;
                }
                if (boundary === -1) boundary = pythonStdoutBuffer.length;
                const processableOutput = pythonStdoutBuffer.substring(0, boundary);
                pythonStdoutBuffer = pythonStdoutBuffer.substring(boundary + 1);
                const lines = processableOutput.split(/[\r\n]+/);
                for (const line of lines) {
                    if (line.startsWith("FINGERPRINT_WSQ_B64:")) {
                        fingerprintImageBase64 = line.replace("FINGERPRINT_WSQ_B64:", "").trim();
                        console.log(`[LocalAgent] Extracted FP Base64 (length: ${fingerprintImageBase64?.length}).`);
                    } else if (line.trim().length > 0) console.log("[LocalAgent] Py stdout:", line.trim());
                }
            });
            pythonProcess.stderr.on("data", (data) => { 
                const errorChunk = data.toString();
                pythonStderrBuffer += errorChunk;
                console.error("[LocalAgent] Py stderr chunk:", errorChunk);
            });
            pythonProcess.on("error", (error) => { 
                 console.error("[LocalAgent] Failed to start Python process.", error);
                if (!res.writableEnded) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Agent: Py process start fail.", details: error.message }));
                }
            });
            // ON PYTHON CLOSE:
            pythonProcess.on("close", async (code) => {
                console.log(`[LocalAgent] Python script exited with code ${code}.`);
                if (pythonStderrBuffer.trim().length > 0) console.error("[LocalAgent] Python script full stderr output:", pythonStderrBuffer);

                if (!fingerprintImageBase64 && pythonStdoutBuffer.trim().length > 0) { /* ... final parse attempt ... */
                    const lines = pythonStdoutBuffer.split(/[\r\n]+/);
                    for (const line of lines) {
                        if (line.startsWith("FINGERPRINT_WSQ_B64:")) {
                            fingerprintImageBase64 = line.replace("FINGERPRINT_WSQ_B64:", "").trim();
                            console.log(`[LocalAgent] Extracted FP Base64 from final Py stdout (length: ${fingerprintImageBase64?.length}).`);
                            break;
                        }
                    }
                }

                if (res.writableEnded) return;

                if (code !== 0) { /* ... send python error to client ... */
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Agent: Py script fail.", exitCode: code, details: pythonStderrBuffer, stdout: pythonStdoutBuffer }));
                    return;
                }
                if (!fingerprintImageBase64) { /* ... send no fingerprint error to client ... */
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Agent: No FP data from script.", details: "Script ok, no FP data.", stdout: pythonStdoutBuffer, stderr: pythonStderrBuffer }));
                    return;
                }

                // If only /capture was called, return just the fingerprint
                if (parsedUrl.pathname === '/capture' || !nin || !fingerCode) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ fingerprintImageBase64 }));
                    return;
                }

                // --- NEW: Call App 3 ---
                try {
                    console.log(`[LocalAgent] Forwarding to App 3 (${APP3_SERVER_URL}) with NIN, FingerCode, and Fingerprint.`);
                    const app3Response = await axios.post(APP3_SERVER_URL, {
                        nin,
                        fingerCode,
                        fingerprintImageBase64
                    }, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 70000 // Slightly longer timeout for the whole chain
                    });

                    console.log(`[LocalAgent] Response from App 3: Status ${app3Response.status}`);
                    if (!res.writableEnded) {
                        res.writeHead(app3Response.status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(app3Response.data));
                    }
                } catch (axiosError) {
                    console.error(`[LocalAgent] Error calling App 3 at ${APP3_SERVER_URL}:`, axiosError.message);
                    if (!res.writableEnded) {
                        const status = axiosError.response ? axiosError.response.status : 502;
                        const data = axiosError.response ? axiosError.response.data : { error: "Network error or App 3 unavailable", details: axiosError.message};
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: "Failed to process via App 3.", source: "LocalAgent", details: data }));
                    }
                }
            }); // End pythonProcess.on('close')
        }); // End req.on('end')
    } else if (req.method === 'GET' && parsedUrl.pathname === '/status') {
        // ... same status endpoint as before ...
         res.writeHead(200, { 'Content-Type': 'application/json' });
         res.end(JSON.stringify({ status: "LocalFingerprintAgent is running", version: "1.1.0" })); // incremented version
    } else {
        // ... same 404 as before ...
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Not Found" }));
    }
});
server.listen(AGENT_PORT, '127.0.0.1', () => { /* ... */ });
process.on('SIGINT', () => { /* ... */ });