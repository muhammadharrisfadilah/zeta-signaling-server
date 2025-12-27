const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WS_PORT = 8080;
const HTTP_PORT = 8000;
const PING_INTERVAL = 15000; // 15 seconds
const CONNECTION_TIMEOUT = 60000; // 60 seconds

// WebSocket Server
const wss = new WebSocket.Server({ port: WS_PORT });

let androidClient = null;
let browserClients = new Map(); // Menggunakan Map untuk tracking lebih baik

// ✅ FIXED: Keepalive tracking dengan timestamp
const pingIntervals = new Map();
const connectionTimestamps = new Map();

console.log('🚀 Zeta Signaling Server v2.1');
console.log('━'.repeat(50));
console.log(`📡 WebSocket: ws://0.0.0.0:${WS_PORT}`);
console.log(`🌐 HTTP: http://0.0.0.0:${HTTP_PORT}`);
console.log(`⏰ Timeout: ${CONNECTION_TIMEOUT/1000}s, Ping: ${PING_INTERVAL/1000}s`);
console.log('━'.repeat(50));

// ✅ FIXED: Enhanced ping function
function startPingInterval(ws, clientType) {
    // Hapus interval sebelumnya jika ada
    stopPingInterval(ws);
    
    const interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
                console.log(`💓 Ping to ${clientType} from ${ws._socket?.remoteAddress || 'unknown'}`);
            } catch (error) {
                console.error(`❌ Ping failed for ${clientType}:`, error.message);
                clearInterval(interval);
                pingIntervals.delete(ws);
            }
        } else {
            clearInterval(interval);
            pingIntervals.delete(ws);
        }
    }, PING_INTERVAL);
    
    pingIntervals.set(ws, interval);
    connectionTimestamps.set(ws, Date.now());
}

function stopPingInterval(ws) {
    if (pingIntervals.has(ws)) {
        clearInterval(pingIntervals.get(ws));
        pingIntervals.delete(ws);
    }
    connectionTimestamps.delete(ws);
}

// ✅ FIXED: Connection timeout handler
function setupConnectionTimeout(ws, clientType) {
    const timeout = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
            console.log(`⏰ ${clientType} connection timeout, closing`);
            ws.close(1001, 'Connection timeout');
        }
    }, CONNECTION_TIMEOUT);
    
    ws._timeout = timeout;
}

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const clientId = `${ip}-${Date.now()}`;
    
    console.log(`\n📱 New connection from ${ip} (ID: ${clientId})`);
    
    // ✅ FIXED: Setup connection timeout
    setupConnectionTimeout(ws, 'New Client');
    
    // ✅ FIXED: Handle pong responses
    ws.on('pong', () => {
        connectionTimestamps.set(ws, Date.now());
    });

    ws.on('message', (data) => {
        try {
            // Update last activity timestamp
            connectionTimestamps.set(ws, Date.now());
            
            const messageStr = data.toString();
            const message = JSON.parse(messageStr);
            const type = message.type;

            // ✅ FIXED: Handle ping/pong from clients
            if (type === 'ping') {
                ws.send(JSON.stringify({ 
                    type: 'pong', 
                    timestamp: Date.now(),
                    serverTime: new Date().toISOString()
                }));
                return;
            }
            
            if (type === 'pong') {
                return;
            }

            // Client identification
            if (type === 'client-type') {
                if (message.client === 'android') {
                    // Close previous Android connection if exists
                    if (androidClient && androidClient !== ws) {
                        console.log(`🔄 Replacing previous Android connection`);
                        stopPingInterval(androidClient);
                        if (androidClient._timeout) clearTimeout(androidClient._timeout);
                        androidClient.close(1000, 'Replaced by new connection');
                    }
                    
                    androidClient = ws;
                    ws._clientType = 'android';
                    ws._clientId = clientId;
                    console.log('✅ Android client registered:', clientId);
                    
                    // Start keepalive for Android
                    startPingInterval(ws, 'Android');
                    
                    // Notify all browsers
                    broadcastToBrowsers({
                        type: 'android-connected',
                        timestamp: Date.now(),
                        id: clientId,
                        ip: ip
                    });
                    
                    // Log connection state
                    logConnectionState();
                    
                } else if (message.client === 'browser') {
                    browserClients.set(ws, {
                        id: clientId,
                        ip: ip,
                        connectedAt: Date.now()
                    });
                    ws._clientType = 'browser';
                    ws._clientId = clientId;
                    
                    console.log(`✅ Browser client registered (${browserClients.size} total):`, clientId);
                    
                    // Start keepalive for browser
                    startPingInterval(ws, 'Browser');
                    
                    // Request offer from Android if available
                    if (androidClient && androidClient.readyState === WebSocket.OPEN) {
                        androidClient.send(JSON.stringify({
                            type: 'request-offer',
                            timestamp: Date.now(),
                            browserId: clientId
                        }));
                        console.log('📤 Requested offer from Android for browser:', clientId);
                    } else {
                        // Notify browser that Android is not available
                        ws.send(JSON.stringify({
                            type: 'android-status',
                            status: 'disconnected',
                            timestamp: Date.now()
                        }));
                    }
                }
                return;
            }

            // ✅ FIXED: Handle camera status from Android
            if (type === 'camera-status') {
                console.log(`📸 Camera ${message.status}: ${message.camera || 'N/A'}`);
                broadcastToBrowsers(message);
                return;
            }
            
            if (type === 'camera-error') {
                console.error(`❌ Camera error: ${message.message}`);
                broadcastToBrowsers(message);
                return;
            }

            // Relay signaling messages
            if (ws === androidClient) {
                // Android → Browsers
                console.log(`📤 Android → Browsers: ${type}`);
                broadcastToBrowsers(message);
            } else if (browserClients.has(ws)) {
                // Browser → Android
                console.log(`📤 Browser → Android: ${type}`);
                if (androidClient && androidClient.readyState === WebSocket.OPEN) {
                    androidClient.send(JSON.stringify(message));
                } else {
                    // If Android is not connected, notify browser
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Android client not connected',
                        timestamp: Date.now()
                    }));
                }
            }

        } catch (error) {
            console.error('❌ Parse error:', error.message);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format',
                timestamp: Date.now()
            }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: ${code} - ${reason || 'No reason'}`);
        
        // Clear timeout and intervals
        stopPingInterval(ws);
        if (ws._timeout) clearTimeout(ws._timeout);
        
        if (ws === androidClient) {
            androidClient = null;
            console.log('❌ Android disconnected');
            
            broadcastToBrowsers({
                type: 'android-disconnected',
                timestamp: Date.now(),
                reason: reason || 'Unknown'
            });
        }
        
        if (browserClients.has(ws)) {
            browserClients.delete(ws);
            console.log(`❌ Browser disconnected (${browserClients.size} remaining)`);
        }
        
        logConnectionState();
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
        stopPingInterval(ws);
        if (ws._timeout) clearTimeout(ws._timeout);
    });
});

function broadcastToBrowsers(message) {
    const data = JSON.stringify(message);
    let successCount = 0;
    let errorCount = 0;
    
    browserClients.forEach((info, client) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(data);
                successCount++;
            } catch (error) {
                console.error(`❌ Broadcast failed to ${info.id}:`, error.message);
                errorCount++;
            }
        }
    });
    
    if (successCount > 0) {
        console.log(`✅ Broadcast to ${successCount} browser(s)`);
    }
    if (errorCount > 0) {
        console.warn(`⚠️ Failed to broadcast to ${errorCount} browser(s)`);
    }
}

function logConnectionState() {
    console.log('━━━━━━━━ CONNECTION STATE ━━━━━━━━');
    console.log(`Android: ${androidClient ? 'CONNECTED' : 'DISCONNECTED'}`);
    console.log(`Browsers: ${browserClients.size} connected`);
    
    browserClients.forEach((info, client) => {
        const state = client.readyState === WebSocket.OPEN ? 'OPEN' : 
                     client.readyState === WebSocket.CLOSED ? 'CLOSED' : 
                     client.readyState === WebSocket.CLOSING ? 'CLOSING' : 'CONNECTING';
        console.log(`  - ${info.id} (${info.ip}): ${state}`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// HTTP Server for viewer page
const server = http.createServer((req, res) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'viewer.html');
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }
            
            res.writeHead(200, { 
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache'
            });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`\n💡 Open browser: http://localhost:${HTTP_PORT}`);
    console.log(`📱 Android should connect to: ws://YOUR_IP:${WS_PORT}`);
    console.log('⏳ Waiting for connections...\n');
});

// ✅ FIXED: Enhanced cleanup of dead connections
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean up dead browser connections
    browserClients.forEach((info, client) => {
        if (client.readyState !== WebSocket.OPEN) {
            stopPingInterval(client);
            if (client._timeout) clearTimeout(client._timeout);
            browserClients.delete(client);
            cleaned++;
        } else {
            // Check last activity
            const lastActivity = connectionTimestamps.get(client);
            if (lastActivity && (now - lastActivity) > CONNECTION_TIMEOUT) {
                console.log(`⏰ Browser ${info.id} inactive, closing`);
                client.close(1001, 'Inactive timeout');
                cleaned++;
            }
        }
    });
    
    // Check Android connection
    if (androidClient && androidClient.readyState !== WebSocket.OPEN) {
        stopPingInterval(androidClient);
        if (androidClient._timeout) clearTimeout(androidClient._timeout);
        androidClient = null;
        console.log('⚠️ Android connection was dead, cleaned up');
        cleaned++;
    } else if (androidClient) {
        // Check Android activity
        const lastActivity = connectionTimestamps.get(androidClient);
        if (lastActivity && (now - lastActivity) > CONNECTION_TIMEOUT) {
            console.log(`⏰ Android inactive, closing`);
            androidClient.close(1001, 'Inactive timeout');
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} dead connections`);
    }
}, 30000); // Every 30 seconds

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Clear all intervals and timeouts
    pingIntervals.forEach((interval) => {
        clearInterval(interval);
    });
    pingIntervals.clear();
    
    connectionTimestamps.clear();
    
    // Close all connections
    if (androidClient) androidClient.close(1000, 'Server shutdown');
    browserClients.forEach((info, client) => {
        client.close(1000, 'Server shutdown');
    });
    
    setTimeout(() => {
        wss.close();
        server.close();
        console.log('✅ Server shutdown complete');
        process.exit(0);
    }, 1000);
});