#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import { tools } from './tools/tool-definitions.js';
import { handleToolCall } from './handlers/index.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validate required environment variables
const READWISE_TOKEN = process.env.READWISE_TOKEN;
const MCP_API_KEY = process.env.MCP_API_KEY;

if (!READWISE_TOKEN) {
  console.error('ERROR: READWISE_TOKEN environment variable is required');
  console.error('Please set READWISE_TOKEN in your environment variables.');
  console.error('Get your token from: https://readwise.io/access_token');
  process.exit(1);
}

if (!MCP_API_KEY) {
  console.warn('WARNING: MCP_API_KEY not set. Server will run without API key authentication.');
  console.warn('For production use, please set MCP_API_KEY in your environment variables.');
}

const app = express();
app.use(express.json());

// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// API Key authentication middleware
const apiKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  // Skip authentication if API key is not configured
  if (!MCP_API_KEY) {
    return next();
  }

  // Check for API key in Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  const apiKeyFromHeader = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : authHeader;

  // Check for API key in X-API-Key header
  const apiKeyFromCustomHeader = req.headers['x-api-key'] as string | undefined;

  // Check for API key in query parameter (less secure, but some clients may need it)
  const apiKeyFromQuery = req.query.apiKey as string | undefined;

  const providedKey = apiKeyFromHeader || apiKeyFromCustomHeader || apiKeyFromQuery;

  if (!providedKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Unauthorized: API key required',
      },
      id: null,
    });
    return;
  }

  if (providedKey !== MCP_API_KEY) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: {
        code: -32003,
        message: 'Forbidden: Invalid API key',
      },
      id: null,
    });
    return;
  }

  next();
};

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'readwise-mcp-enhanced' });
});

// JSON-RPC endpoint for MCP protocol
app.post('/mcp', apiKeyAuth, async (req: Request, res: Response) => {
  try {
    const request = req.body;

    // Validate JSON-RPC request
    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
        id: request.id || null,
      });
      return;
    }

    let response: any;

    // Handle different MCP methods
    if (request.method === 'initialize') {
      // Handle initialize request
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'readwise-mcp-enhanced',
            version: '1.0.0',
          },
        },
      };
    } else if (request.method === 'tools/list') {
      // Handle tools/list request
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools,
        },
      };
    } else if (request.method === 'tools/call') {
      // Handle tools/call request
      const { name, arguments: args } = request.params || {};

      if (!name) {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32602,
            message: 'Invalid params: tool name is required',
          },
        };
      } else {
        try {
          const result = await handleToolCall(name, args || {});
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result,
          };
        } catch (error) {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32603,
              message: 'Internal error',
              data: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
    } else {
      // Unknown method
      response = {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      };
    }

    res.json(response);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: {
        code: -32603,
        message: 'Internal error',
        data: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

// SSE endpoint for streaming (optional, for clients that prefer SSE)
app.get('/sse', apiKeyAuth, (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial connection message
  res.write('data: {"type":"connection","status":"connected"}\n\n');

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    res.end();
  });
});

const PORT = (process.env.PORT ? parseInt(process.env.PORT, 10) : undefined) || 3000;

app.listen(PORT, () => {
  console.log(`Readwise MCP Enhanced server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API Key authentication: ${MCP_API_KEY ? 'Enabled' : 'Disabled'}`);
  console.log(`Readwise token: ${READWISE_TOKEN ? 'Configured' : 'Missing'}`);
});
