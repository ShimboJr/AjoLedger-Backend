import { Router } from 'express';
import { getDBStatus } from '../config/db.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    data: {
      status: 'ok',
      db: getDBStatus(),
      time: new Date().toISOString(),
    },
  });
});

export default router;
