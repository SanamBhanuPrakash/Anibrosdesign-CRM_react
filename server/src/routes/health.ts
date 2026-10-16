import { Router } from 'express';
import { db } from '../platform/db';

export const healthRouter = Router();

healthRouter.get('/live', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get('/ready', async (req, res) => {
  try {
    const dbRes = await db.query('SELECT 1 as alive');
    if (dbRes.rows?.[0]?.alive === 1) {
      res.status(200).json({
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
      return;
    }
    res.status(503).json({
      status: 'error',
      database: 'unexpected_response',
    });
  } catch (err: any) {
    req.logger?.error('Readiness health check failed', { error: err.message });
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
    });
  }
});
