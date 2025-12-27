const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// ✅ Environment variables untuk Glitch
const PORT = process.env.PORT || 3000;

// Express app
const app = express();

// Serve static files (viewer.html)
app.use(express.static('public'));

// Health check untuk Glitch
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        connections: {
            android: androidClients.size,
            browsers: browserClients.size
        }
    });
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocket.Server({ 
    server,
    // ✅ Path untuk WebSocket
    path: '/ws'
});

// Client tracking
let androidClients = new Map(); // Map<clientId, {ws, lastSeen}>
let browserClients = new Map(); // Map<clientId, {ws, browserId}>

const PING_INTERVAL = 30000; // 30 seconds
const CLIENT_TIMEOUT = 90000; // 90 seconds

console.log('🚀 Zeta Signaling Server (Glitch Edition)');
console.log('━'.repeat(50));

// Ping interval untuk keep-alive
setInterval(() => {
    const now = Date.now();
    
    // Ping Android clients
    androidClients.forEach((client, id) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.ping();
            console.log(`💓 Ping to Android: ${id}`);
        } else {
            cleanupAndroidClient(id);
        }
    });
    
    // Ping Browser clients
    browserClients.forEach((client, id) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.ping();
            console.log(`💓 Ping to Browser: ${id}`);
        } else {
            cleanupBrowserClient(id);
        }
    });
}, PING_INTERVAL);

// Cleanup stale connections
setInterval(() => {
    const now = Date.now();
    
    androidClients.forEach((client, id) => {
        if (now - client.lastSeen > CLIENT_TIMEOUT) {
            console.log(`⏰ Android timeout: ${id}`);
            cleanupAndroidClient(id);
        }
    });
}, 60000); // Check every minute

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const clientId = `${ip}-${Date.now()}`;
    
    console.log(`\n📱 New connection: ${clientId}`);
    
    // Track last activity
    let lastPong = Date.now();
    
    ws.on('pong', () => {
        lastPong = Date.now();
    });
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            const type = message.type;
            
            // Handle ping/pong
            if (type === 'ping') {
                ws.send(JSON.stringify({ 
                    type: 'pong', 
                    timestamp: Date.now(),
                    serverTime: new Date().toISOString()
                }));
                return;
            }
            
            if (type === 'pong') {
                lastPong = Date.now();
                return;
            }
            
            // Client identification
            if (type === 'client-type') {
                if (message.client === 'android') {
                    // Register Android client
                    androidClients.set(clientId, {
                        ws: ws,
                        lastSeen: Date.now(),
                        ip: ip
                    });
                    
                    console.log(`✅ Android registered: ${clientId}`);
                    console.log(`   Total Android clients: ${androidClients.size}`);
                    
                    // Notify all browsers
                    broadcastToBrowsers({
                        type: 'android-connected',
                        androidId: clientId,
                        timestamp: Date.now()
                    });
                    
                    // Send welcome message
                    ws.send(JSON.stringify({
                        type: 'welcome',
                        clientId: clientId,
                        message: 'Connected to Zeta Cloud Server'
                    }));
                    
                } else if (message.client === 'browser') {
                    // Register Browser client
                    const browserId = message.browserId || clientId;
                    
                    browserClients.set(clientId, {
                        ws: ws,
                        browserId: browserId,
                        lastSeen: Date.now()
                    });
                    
                    console.log(`✅ Browser registered: ${clientId}`);
                    console.log(`   Browser ID: ${browserId}`);
                    console.log(`   Total browsers: ${browserClients.size}`);
                    
                    // Notify about existing Android clients
                    if (androidClients.size > 0) {
                        ws.send(JSON.stringify({
                            type: 'android-available',
                            count: androidClients.size,
                            timestamp: Date.now()
                        }));
                        
                        // Request offer from first Android
                        const firstAndroid = androidClients.values().next().value;
                        if (firstAndroid && firstAndroid.ws.readyState === WebSocket.OPEN) {
                            firstAndroid.ws.send(JSON.stringify({
                                type: 'request-offer',
                                browserId: browserId,
                                timestamp: Date.now()
                            }));
                            console.log(`📤 Requested offer from Android for browser: ${browserId}`);
                        }
                    }
                }
                return;
            }
            
            // Route messages between Android and Browsers
            if (androidClients.has(clientId)) {
                // Message from Android → Broadcast to all browsers
                console.log(`📤 Android → Browsers: ${type}`);
                androidClients.get(clientId).lastSeen = Date.now();
                
                // Add sender info
                message.androidId = clientId;
                
                broadcastToBrowsers(message);
                
            } else if (browserClients.has(clientId)) {
                // Message from Browser → Send to target Android or broadcast
                const browser = browserClients.get(clientId);
                browser.lastSeen = Date.now();
                
                console.log(`📤 Browser → Android: ${type}`);
                
                // Add browser ID to message
                message.browserId = browser.browserId;
                
                // Send to specific Android if specified, otherwise first available
                if (message.androidId && androidClients.has(message.androidId)) {
                    const android = androidClients.get(message.androidId);
                    if (android.ws.readyState === WebSocket.OPEN) {
                        android.ws.send(JSON.stringify(message));
                    }
                } else {
                    // Send to first available Android
                    const firstAndroid = androidClients.values().next().value;
                    if (firstAndroid && firstAndroid.ws.readyState === WebSocket.OPEN) {
                        firstAndroid.ws.send(JSON.stringify(message));
                    } else {
                        console.log('⚠️ No Android available');
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'No Android device connected'
                        }));
                    }
                }
            }
            
        } catch (error) {
            console.error('❌ Parse error:', error.message);
        }
    });
    
    ws.on('close', (code, reason) => {
        console.log(`🔌 Client disconnected: ${code} - ${reason}`);
        
        if (androidClients.has(clientId)) {
            cleanupAndroidClient(clientId);
        }
        
        if (browserClients.has(clientId)) {
            cleanupBrowserClient(clientId);
        }
        
        logConnectionState();
    });
    
    ws.on('error', (error) => {
        console.error(`❌ WebSocket error (${clientId}):`, error.message);
    });
});

function broadcastToBrowsers(message) {
    const data = JSON.stringify(message);
    let successCount = 0;
    
    browserClients.forEach((client, id) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(data);
                successCount++;
            } catch (error) {
                console.error(`❌ Broadcast failed to ${id}:`, error.message);
            }
        }
    });
    
    if (successCount > 0) {
        console.log(`✅ Broadcast to ${successCount} browser(s)`);
    }
}

function cleanupAndroidClient(clientId) {
    androidClients.delete(clientId);
    console.log(`❌ Android disconnected: ${clientId}`);
    console.log(`   Remaining Android clients: ${androidClients.size}`);
    
    // Notify all browsers
    broadcastToBrowsers({
        type: 'android-disconnected',
        androidId: clientId,
        timestamp: Date.now()
    });
}

function cleanupBrowserClient(clientId) {
    browserClients.delete(clientId);
    console.log(`❌ Browser disconnected: ${clientId}`);
    console.log(`   Remaining browsers: ${browserClients.size}`);
}

function logConnectionState() {
    console.log('\n━━━━━━━━ CONNECTION STATE ━━━━━━━━');
    console.log(`Android: ${androidClients.size} connected`);
    androidClients.forEach((client, id) => {
        console.log(`  - ${id} (${client.ip}): ${client.ws.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'}`);
    });
    console.log(`Browsers: ${browserClients.size} connected`);
    browserClients.forEach((client, id) => {
        console.log(`  - ${client.browserId} (${id}): ${client.ws.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'}`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// Start server
server.listen(PORT, () => {
    console.log(`\n💡 Server running on port ${PORT}`);
    console.log(`🌐 WebSocket endpoint: wss://your-app.glitch.me/ws`);
    console.log(`🎥 Viewer page: https://your-app.glitch.me`);
    console.log('⏳ Waiting for connections...\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Close all connections
    androidClients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.close(1000, 'Server shutting down');
        }
    });
    
    browserClients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.close(1000, 'Server shutting down');
        }
    });
    
    wss.close(() => {
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });
    });
});
