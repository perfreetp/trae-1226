import { Router } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../lib/prisma';
import { success, successWithPagination, ApiError } from '../utils/response';
import { handleValidation, parsePagination } from '../middleware/error';
import { authMiddleware, AuthRequest, requireRoles } from '../middleware/auth';
import { Prisma } from '@prisma/client';
import { UserRole } from '../constants/enums';

const router = Router();
router.use(authMiddleware);

// ============ 上报/录入数据 ============

router.post(
  '/report',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('contentId').optional().isInt(),
    body('talentId').isInt().withMessage('达人ID不能为空'),
    body('date').notEmpty().withMessage('数据日期不能为空'),
    body('readCount').optional().isInt(),
    body('likeCount').optional().isInt(),
    body('commentCount').optional().isInt(),
    body('collectCount').optional().isInt(),
    body('shareCount').optional().isInt(),
    body('followCount').optional().isInt(),
    body('clueCount').optional().isInt(),
    handleValidation,
  ],
  async (req, res, next) => {
    try {
      const { contentId, talentId, date, ...metrics } = req.body;

      const talent = await prisma.talent.findUnique({ where: { id: talentId } });
      if (!talent) throw new ApiError(404, 5010, '达人不存在');

      if (contentId) {
        const content = await prisma.content.findUnique({ where: { id: contentId } });
        if (!content) throw new ApiError(404, 5011, '内容不存在');
      }

      const dateTime = new Date(date);
      dateTime.setHours(0, 0, 0, 0);

      const total =
        (metrics.readCount || 0) +
        (metrics.likeCount || 0) +
        (metrics.commentCount || 0) +
        (metrics.collectCount || 0) +
        (metrics.shareCount || 0);
      const interaction =
        (metrics.likeCount || 0) +
        (metrics.commentCount || 0) +
        (metrics.collectCount || 0) +
        (metrics.shareCount || 0);

      const commentRate = metrics.readCount ? ((metrics.commentCount || 0) / metrics.readCount) * 100 : 0;
      const interactionRate = metrics.readCount ? (interaction / metrics.readCount) * 100 : 0;

      const data = await prisma.performanceData.upsert({
        where: contentId
          ? { contentId_date: { contentId, date: dateTime } }
          : { contentId_date: { contentId: 0, date: dateTime } },
        create: {
          contentId: contentId || null,
          talentId,
          date: dateTime,
          readCount: metrics.readCount || 0,
          likeCount: metrics.likeCount || 0,
          commentCount: metrics.commentCount || 0,
          collectCount: metrics.collectCount || 0,
          shareCount: metrics.shareCount || 0,
          followCount: metrics.followCount || 0,
          clueCount: metrics.clueCount || 0,
          commentRate: new Prisma.Decimal(commentRate.toFixed(2)),
          interactionRate: new Prisma.Decimal(interactionRate.toFixed(2)),
        },
        update: {
          readCount: metrics.readCount ?? undefined,
          likeCount: metrics.likeCount ?? undefined,
          commentCount: metrics.commentCount ?? undefined,
          collectCount: metrics.collectCount ?? undefined,
          shareCount: metrics.shareCount ?? undefined,
          followCount: metrics.followCount ?? undefined,
          clueCount: metrics.clueCount ?? undefined,
          commentRate: new Prisma.Decimal(commentRate.toFixed(2)),
          interactionRate: new Prisma.Decimal(interactionRate.toFixed(2)),
        },
      });

      success(res, data, '数据上报成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 内容维度数据 ============

router.get(
  '/content/:contentId',
  [
    param('contentId').isInt(),
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const contentId = Number(req.params.contentId);
      const { startDate, endDate } = req.query;

      const content = await prisma.content.findUnique({
        where: { id: contentId },
        include: { talent: true },
      });
      if (!content) throw new ApiError(404, 404, '内容不存在');

      if (req.user!.role === UserRole.TALENT && content.talent.userId !== req.user!.id) {
        throw new ApiError(403, 403, '无权限查看');
      }

      const where: any = { contentId };
      if (startDate) where.date = { ...where.date, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        where.date = { ...where.date, lte: eDate };
      }

      const dailyData = await prisma.performanceData.findMany({
        where,
        orderBy: { date: 'asc' },
      });

      const summary = dailyData.reduce(
        (acc, curr) => ({
          readCount: acc.readCount + curr.readCount,
          likeCount: acc.likeCount + curr.likeCount,
          commentCount: acc.commentCount + curr.commentCount,
          collectCount: acc.collectCount + curr.collectCount,
          shareCount: acc.shareCount + curr.shareCount,
          followCount: acc.followCount + curr.followCount,
          clueCount: acc.clueCount + curr.clueCount,
        }),
        { readCount: 0, likeCount: 0, commentCount: 0, collectCount: 0, shareCount: 0, followCount: 0, clueCount: 0 }
      );

      const totalInteraction =
        summary.likeCount + summary.commentCount + summary.collectCount + summary.shareCount;

      success(res, {
        content: { id: content.id, title: content.title, noteUrl: content.noteUrl },
        summary: {
          ...summary,
          totalInteraction,
          interactionRate: summary.readCount
            ? ((totalInteraction / summary.readCount) * 100).toFixed(2) + '%'
            : '0%',
          commentRate: summary.readCount
            ? ((summary.commentCount / summary.readCount) * 100).toFixed(2) + '%'
            : '0%',
        },
        daily: dailyData,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============ 达人维度数据 ============

router.get(
  '/talent/:talentId',
  [
    param('talentId').isInt(),
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const talentId = Number(req.params.talentId);
      const { startDate, endDate } = req.query;

      const talent = await prisma.talent.findUnique({ where: { id: talentId } });
      if (!talent) throw new ApiError(404, 404, '达人不存在');

      if (req.user!.role === UserRole.TALENT && talent.userId !== req.user!.id) {
        throw new ApiError(403, 403, '无权限查看');
      }

      const where: any = { talentId };
      if (startDate) where.date = { ...where.date, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        where.date = { ...where.date, lte: eDate };
      }

      const dailyData = await prisma.performanceData.findMany({
        where,
        orderBy: { date: 'asc' },
        include: { content: { select: { id: true, title: true } } },
      });

      const byContent: Record<number, any> = {};
      dailyData.forEach((d) => {
        if (!d.contentId) return;
        if (!byContent[d.contentId]) {
          byContent[d.contentId] = {
            content: d.content,
            readCount: 0, likeCount: 0, commentCount: 0,
            collectCount: 0, shareCount: 0, followCount: 0, clueCount: 0,
          };
        }
        byContent[d.contentId].readCount += d.readCount;
        byContent[d.contentId].likeCount += d.likeCount;
        byContent[d.contentId].commentCount += d.commentCount;
        byContent[d.contentId].collectCount += d.collectCount;
        byContent[d.contentId].shareCount += d.shareCount;
        byContent[d.contentId].followCount += d.followCount;
        byContent[d.contentId].clueCount += d.clueCount;
      });

      const totalSummary = dailyData.reduce(
        (acc, curr) => ({
          readCount: acc.readCount + curr.readCount,
          likeCount: acc.likeCount + curr.likeCount,
          commentCount: acc.commentCount + curr.commentCount,
          collectCount: acc.collectCount + curr.collectCount,
          shareCount: acc.shareCount + curr.shareCount,
          followCount: acc.followCount + curr.followCount,
          clueCount: acc.clueCount + curr.clueCount,
        }),
        { readCount: 0, likeCount: 0, commentCount: 0, collectCount: 0, shareCount: 0, followCount: 0, clueCount: 0 }
      );

      const totalInteraction =
        totalSummary.likeCount + totalSummary.commentCount + totalSummary.collectCount + totalSummary.shareCount;

      success(res, {
        talent: { id: talent.id, nickname: talent.nickname, xhsId: talent.xhsId },
        summary: {
          ...totalSummary,
          totalInteraction,
          interactionRate: totalSummary.readCount
            ? ((totalInteraction / totalSummary.readCount) * 100).toFixed(2) + '%'
            : '0%',
        },
        byContent: Object.values(byContent),
        daily: dailyData,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============ 种草线索查询 ============

router.get(
  '/clues',
  [
    query('talentId').optional().isInt(),
    query('brandId').optional().isInt(),
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    query('minClueCount').optional().isInt(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { talentId, brandId, startDate, endDate, minClueCount } = req.query;

      const contentWhere: any = {};
      if (talentId) contentWhere.talentId = Number(talentId);
      if (brandId) contentWhere.invitation = { brandId: Number(brandId) };

      const perfWhere: any = {};
      if (startDate) perfWhere.date = { ...perfWhere.date, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        perfWhere.date = { ...perfWhere.date, lte: eDate };
      }
      if (minClueCount) perfWhere.clueCount = { gte: Number(minClueCount) };

      const clues = await prisma.performanceData.findMany({
        where: {
          ...perfWhere,
          clueCount: { gt: 0 },
          content: contentWhere,
        },
        skip,
        take: pageSize,
        orderBy: { clueCount: 'desc' },
        include: {
          content: {
            include: {
              invitation: { include: { brand: true } },
              talent: { select: { id: true, nickname: true } },
            },
          },
        },
      });

      const total = await prisma.performanceData.count({
        where: {
          ...perfWhere,
          clueCount: { gt: 0 },
          content: contentWhere,
        },
      });

      successWithPagination(res, clues, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

// ============ 达人数据排行榜 ============

router.get(
  '/rank/talent',
  [
    query('metric').optional().isIn(['readCount', 'likeCount', 'commentCount', 'collectCount', 'shareCount', 'clueCount', 'interactionRate']),
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    query('limit').optional().isInt(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { metric = 'readCount', startDate, endDate, limit } = _req.query;
      const takeLimit = Math.min(100, Number(limit) || 20);

      const perfWhere: any = {};
      if (startDate) perfWhere.date = { ...perfWhere.date, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        perfWhere.date = { ...perfWhere.date, lte: eDate };
      }

      const allData = await prisma.performanceData.findMany({
        where: perfWhere,
        include: { talent: { select: { id: true, nickname: true, avatarUrl: true, xhsId: true } } },
      });

      const byTalent: Record<number, any> = {};
      allData.forEach((d) => {
        if (!byTalent[d.talentId]) {
          byTalent[d.talentId] = {
            talent: d.talent,
            readCount: 0, likeCount: 0, commentCount: 0,
            collectCount: 0, shareCount: 0, clueCount: 0,
          };
        }
        byTalent[d.talentId].readCount += d.readCount;
        byTalent[d.talentId].likeCount += d.likeCount;
        byTalent[d.talentId].commentCount += d.commentCount;
        byTalent[d.talentId].collectCount += d.collectCount;
        byTalent[d.talentId].shareCount += d.shareCount;
        byTalent[d.talentId].clueCount += d.clueCount;
      });

      const ranked = Object.values(byTalent).map((t) => {
        const interaction = t.likeCount + t.commentCount + t.collectCount + t.shareCount;
        return {
          ...t,
          interaction,
          interactionRate: t.readCount ? (interaction / t.readCount) * 100 : 0,
        };
      });

      ranked.sort((a: any, b: any) => {
        if (metric === 'interactionRate' || metric === 'commentRate') {
          return b[metric as keyof typeof b] - a[metric as keyof typeof a];
        }
        const m = metric as string;
        return (b as any)[m] - (a as any)[m];
      });

      success(res, {
        metric,
        rankList: ranked.slice(0, takeLimit),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============ 综合看板 ============

router.get('/dashboard/summary', async (_req, res, next) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalContents,
      totalTalents,
      totalInvitations,
      recentData,
    ] = await Promise.all([
      prisma.content.count(),
      prisma.talent.count({ where: { status: 'APPROVED' } }),
      prisma.invitation.count({ where: { status: 'COMPLETED' } }),
      prisma.performanceData.findMany({
        where: { date: { gte: thirtyDaysAgo } },
      }),
    ]);

    const metrics = recentData.reduce(
      (acc, curr) => ({
        readCount: acc.readCount + curr.readCount,
        likeCount: acc.likeCount + curr.likeCount,
        commentCount: acc.commentCount + curr.commentCount,
        collectCount: acc.collectCount + curr.collectCount,
        shareCount: acc.shareCount + curr.shareCount,
        clueCount: acc.clueCount + curr.clueCount,
      }),
      { readCount: 0, likeCount: 0, commentCount: 0, collectCount: 0, shareCount: 0, clueCount: 0 }
    );

    const byDate: Record<string, any> = {};
    recentData.forEach((d) => {
      const key = d.date.toISOString().split('T')[0];
      if (!byDate[key]) {
        byDate[key] = { readCount: 0, likeCount: 0, commentCount: 0, collectCount: 0, clueCount: 0 };
      }
      byDate[key].readCount += d.readCount;
      byDate[key].likeCount += d.likeCount;
      byDate[key].commentCount += d.commentCount;
      byDate[key].collectCount += d.collectCount;
      byDate[key].clueCount += d.clueCount;
    });

    success(res, {
      totalContents,
      totalTalents,
      totalInvitations,
      metrics,
      trend: Object.entries(byDate)
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
