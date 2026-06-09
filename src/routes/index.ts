import { Router } from 'express';
import authRoutes from './auth';
import talentRoutes from './talent';
import invitationRoutes from './invitation';
import contentRoutes from './content';
import dataRoutes from './data';
import settlementRoutes from './settlement';
import riskRoutes from './risk';
import notificationRoutes from './notification';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({
    code: 0,
    message: 'ok',
    data: {
      timestamp: Date.now(),
      service: 'xhs-brand-cooperation-backend',
      version: '1.0.0',
    },
  });
});

router.use('/auth', authRoutes);
router.use('/talents', talentRoutes);
router.use('/invitations', invitationRoutes);
router.use('/contents', contentRoutes);
router.use('/data', dataRoutes);
router.use('/settlements', settlementRoutes);
router.use('/risks', riskRoutes);
router.use('/notifications', notificationRoutes);

export default router;
