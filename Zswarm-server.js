#!/usr/bin/env node
/**
 * SwarmBuilder — All-in-one server with Real Code Support
 *
 * Usage:
 *   KIMI_API_KEY="sk-..." node swarm-server.js
 *
 * Supports:
 * - Larger payload limits for full code files
 * - Proper content-type handling for code exports
 * - Health check with model info
 */

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const PORT     = parseInt(process.env.PORT || '3456');
const ENV_KEY  = process.env.KIMI_API_KEY  || process.env.API_KEY  || '';
const ENV_URL  = process.env.KIMI_BASE_URL || process.env.BASE_URL || 'https://api.moonshot.ai/v1';
const ENV_MDL  = process.env.KIMI_MODEL    || process.env.MODEL    || 'kimi-k2-5';

// Read the HTML file (or use inline if not found)
let APP_HTML;
try {
  const htmlPath = path.join(__dirname, 'swarm-builder.html');
  APP_HTML = fs.readFileSync(htmlPath, 'utf8');
  console.log('[init] Loaded UI from swarm-builder.html');
} catch (e) {
  console.error('[init] ERROR: Could not load swarm-builder.html. Please ensure it exists in the same directory.');
  console.error('[init] Details:', e.message);
  process.exit(1);
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Enable CORS for all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // ── Serve the UI ──
  if ((req.method === 'GET' && req.url === '/') || req.url === '/index.html') {
    res.writeHead(200, { 
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(APP_HTML);
    return;
  }

  // ── Health check ──
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      ok: true, 
      model: ENV_MDL, 
      base: ENV_URL, 
      keySet: !!ENV_KEY,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // ── Proxy endpoint ──
  if (req.method === 'POST' && req.url === '/proxy') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed;
      try { 
        parsed = JSON.parse(body); 
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:'Bad JSON: ' + e.message}}));
        return;
      }

      // Pull out meta fields the browser sent, use env fallbacks
      const apiKey  = parsed._apiKey  || ENV_KEY;
      const baseUrl = parsed._baseUrl || ENV_URL;
      const model   = parsed.model    || ENV_MDL;
      delete parsed._apiKey; 
      delete parsed._baseUrl;
      parsed.model = model;

      if (!apiKey) {
        res.writeHead(401, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:'No API key. Set KIMI_API_KEY env var or enter key in the UI.'}}));
        return;
      }

      const target   = url.parse(baseUrl.replace(/\/$/, '') + '/chat/completions');
      const payload  = JSON.stringify(parsed);
      const proto    = target.protocol === 'http:' ? http : https;

      const options = {
        hostname : target.hostname,
        port     : target.port || (target.protocol === 'http:' ? 80 : 443),
        path     : target.path,
        method   : 'POST',
        timeout  : 120000, // 2 minute timeout for code generation
        headers  : {
          'Content-Type'  : 'application/json',
          'Authorization' : 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent'    : 'SwarmBuilder/2.0',
        },
      };

      console.log('[proxy]', model, '->', target.hostname + target.path, `(${payload.length} bytes)`);

      const upstream = proto.request(options, upRes => {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          const data = Buffer.concat(chunks);
          console.log('[proxy] <-', upRes.statusCode, data.length + 'b');
          
          // Forward all relevant headers
          res.writeHead(upRes.statusCode, {
            'Content-Type'                : 'application/json',
            'Access-Control-Allow-Origin' : '*',
            'X-Model-Used'                : model
          });
          res.end(data);
        });
      });

      upstream.on('error', err => {
        console.error('[proxy] upstream error:', err.message);
        res.writeHead(502, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:'Upstream error: ' + err.message}}));
      });

      upstream.on('timeout', () => {
        console.error('[proxy] request timeout');
        upstream.destroy();
        res.writeHead(504, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:'Request timeout - model took too long to respond'}}));
      });

      upstream.write(payload);
      upstream.end();
    });
    return;
  }

  // ── Export endpoint (for future ZIP generation) ──
  if (req.method === 'POST' && req.url === '/export') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { files, projectName } = JSON.parse(body);
        // For now, just echo back as JSON (client handles download)
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${projectName || 'project'}.json"`
        });
        res.end(JSON.stringify({ files, exported: new Date().toISOString() }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid export data');
      }
    });
    return;
  }

  res.writeHead(404); 
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│  SwarmBuilder v2.0 (Real Code Mode)         │');
  console.log('│                                             │');
  console.log('│  Open:  http://localhost:' + PORT + '             │');
  console.log('│                                             │');
  console.log('│  Model: ' + ENV_MDL.padEnd(36) + '│');
  console.log('│  Key:   ' + (ENV_KEY ? (ENV_KEY.slice(0,12) + '...') : '(none — enter in UI)').padEnd(36) + '│');
  console.log('│  API:   ' + ENV_URL.padEnd(36) + '│');
  console.log('│                                             │');
  console.log('│  Features:                                  │');
  console.log('│  • Full code file generation                │');
  console.log('│  • File tree navigation                     │');
  console.log('│  • Syntax highlighting                    │');
  console.log('│  • Export project manifest                │');
  console.log('└─────────────────────────────────────────────┘\n');
  
  if (!ENV_KEY) {
    console.log('⚠️  WARNING: No API key set. Set KIMI_API_KEY environment variable or enter in UI.\n');
  }
});
