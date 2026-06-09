import { Router } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../lib/prisma';
import { success, successWithPagination, ApiError } from '../utils/response';
import { handleValidation, parsePagination } from '../middleware/error';
import { authMiddleware, AuthRequest, requireRoles } from '../middleware/auth';
import { RiskLevel, RiskType, UserRole } from '../constants/enums';

const router = Router();
router.use(authMiddleware);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============ 违规词库管理 ============

router.get(
  '/prohibited-words',
  [
    query('keyword').optional().isString(),
    query('severity').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(_req);
      const { keyword, severity } = _req.query;

      const where: any = {};
      if (keyword) where.word = { contains: keyword as string };
      if (severity) where.severity = severity as RiskLevel;

      const [list, total] = await Promise.all([
        prisma.prohibitedWord.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.prohibitedWord.count({ where }),
      ]);

      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/prohibited-words',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('word').notEmpty().withMessage('违规词不能为空'),
    body('severity').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { word, category, severity } = _req.body;
      const exist = await prisma.prohibitedWord.findUnique({ where: { word } });
      if (exist) throw new ApiError(400, 7001, '违规词已存在');

      const pw = await prisma.prohibitedWord.create({
        data: { word, category, severity: (severity || 'MEDIUM') as RiskLevel },
      });
      success(res, pw, '违规词添加成功');
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/prohibited-words/:id',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [param('id').isInt(), handleValidation],
  async (_req, res, next) => {
    try {
      const { word, category, severity, enabled } = _req.body;
      const pw = await prisma.prohibitedWord.update({
        where: { id: Number(_req.params.id) },
        data: { word, category, severity: severity ? (severity as RiskLevel) : undefined, enabled },
      });
      success(res, pw, '违规词更新成功');
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/prohibited-words/:id',
  requireRoles(UserRole.ADMIN),
  [param('id').isInt(), handleValidation],
  async (_req, res, next) => {
    try {
      await prisma.prohibitedWord.delete({ where: { id: Number(_req.params.id) } });
      success(res, null, '违规词已删除');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 违规词检测 ============

router.post(
  '/scan/prohibited-words',
  [
    body('text').notEmpty().withMessage('待检测文本不能为空'),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { text, contentId } = _req.body;
      const words = await prisma.prohibitedWord.findMany({ where: { enabled: true } });

      const matches: any[] = [];
      words.forEach((pw) => {
        const safeWord = escapeRegExp(pw.word);
        const regex = new RegExp(safeWord, 'gi');
        const found = text.match(regex);
        if (found) {
          matches.push({
            word: pw.word,
            category: pw.category,
            severity: pw.severity,
            count: found.length,
            positions: [...text.matchAll(regex)].map((m: any) => m.index),
          });
        }
      });

      const highestSeverity = matches.reduce(
        (acc, m) => {
          const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
          return order[m.severity] > order[acc as keyof typeof order] ? m.severity : acc;
        },
        'LOW'
      );
      const totalCount = matches.reduce((acc, m) => acc + m.count, 0);

      const result = {
        textLength: text.length,
        totalMatches: totalCount,
        uniqueWords: matches.length,
        highestSeverity,
        isClean: totalCount === 0,
        matches,
      };

      if (contentId && totalCount > 0) {
        const content = await prisma.content.findUnique({ where: { id: contentId } });
        if (content) {
          await prisma.riskRecord.create({
            data: {
              talentId: content.talentId,
              contentId,
              type: RiskType.PROHIBITED_WORDS,
              level: highestSeverity as RiskLevel,
              title: '违规词检测告警',
              description: `检测到 ${totalCount} 处违规词，涉及 ${matches.length} 个敏感词`,
              evidence: JSON.stringify(matches),
            },
          });
        }
      }

      success(res, result, '检测完成');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 刷量识别 ============

router.post(
  '/scan/fake-traffic',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('contentId').isInt().withMessage('内容ID不能为空'),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { contentId } = _req.body;
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        include: { talent: true },
      });
      if (!content) throw new ApiError(404, 404, '内容不存在');

      const data = await prisma.performanceData.findMany({
        where: { contentId },
        orderBy: { date: 'asc' },
      });

      if (data.length < 2) {
        success(res, { message: '数据量不足，无法判断' }, '检测完成');
        return;
      }

      const alerts: any[] = [];

      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];

        if (prev.readCount > 0) {
          const readGrowth = (curr.readCount - prev.readCount) / prev.readCount;
          if (readGrowth > 2) {
            alerts.push({
              type: 'READ_SPIKE',
              date: curr.date,
              prevValue: prev.readCount,
              currValue: curr.readCount,
              growthRate: `${(readGrowth * 100).toFixed(1)}%`,
              message: '阅读量出现异常增长',
            });
          }
        }

        if (prev.likeCount > 0) {
          const likeGrowth = (curr.likeCount - prev.likeCount) / prev.likeCount;
          if (likeGrowth > 3) {
            alerts.push({
              type: 'LIKE_SPIKE',
              date: curr.date,
              prevValue: prev.likeCount,
              currValue: curr.likeCount,
              growthRate: `${(likeGrowth * 100).toFixed(1)}%`,
              message: '点赞量异常增长，疑似刷量',
            });
          }
        }

        if (prev.readCount > 0 && curr.readCount > 0) {
          const prevEngagement = (prev.likeCount + prev.commentCount) / prev.readCount;
          const currEngagement = (curr.likeCount + curr.commentCount) / curr.readCount;

          if (currEngagement > prevEngagement * 2.5 && prevEngagement > 0) {
            alerts.push({
              type: 'ENGAGEMENT_ABNORMAL',
              date: curr.date,
              message: '互动率异常波动',
            });
          }
        }
      }

      const totalLatest = data[data.length - 1];
      const totalPrev = data[0];
      if (totalLatest.readCount > 0 && totalPrev.readCount > 0) {
        const likeRatio = totalLatest.likeCount / totalLatest.readCount;
        if (likeRatio > 0.3) {
          alerts.push({
            type: 'HIGH_LIKE_RATIO',
            likeCount: totalLatest.likeCount,
            readCount: totalLatest.readCount,
            likeRatio: `${(likeRatio * 100).toFixed(1)}%`,
            message: '点赞/阅读比例过高（正常5%-15%），疑似刷量',
          });
        }

        const commentRatio = totalLatest.commentCount / totalLatest.readCount;
        if (commentRatio > 0.1) {
          alerts.push({
            type: 'HIGH_COMMENT_RATIO',
            commentCount: totalLatest.commentCount,
            readCount: totalLatest.readCount,
            commentRatio: `${(commentRatio * 100).toFixed(1)}%`,
            message: '评论/阅读比例过高（正常1%-5%），疑似刷量',
          });
        }
      }

      const riskLevel =
        alerts.filter((a) => a.type === 'READ_SPIKE' || a.type === 'LIKE_SPIKE').length >= 2
          ? 'HIGH'
          : alerts.length > 0
          ? 'MEDIUM'
          : 'LOW';

      const result = {
        contentId,
        talent: { id: content.talentId, nickname: content.talent.nickname },
        dataPoints: data.length,
        alerts,
        alertCount: alerts.length,
        riskLevel,
        isSuspicious: alerts.length > 0,
      };

      if (alerts.length > 0) {
        await prisma.riskRecord.create({
          data: {
            talentId: content.talentId,
            contentId,
            type: RiskType.FAKED_TRAFFIC,
            level: riskLevel as RiskLevel,
            title: '数据异常波动',
            description: `检测到 ${alerts.length} 项数据异常指标`,
            evidence: JSON.stringify(alerts),
          },
        });
      }

      success(res, result, '刷量检测完成');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 重复合作检测 ============

router.post(
  '/scan/duplicate-cooperation',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('talentId').isInt().withMessage('达人ID不能为空'),
    body('brandId').isInt().withMessage('品牌ID不能为空'),
    body('days').optional().isInt(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { talentId, brandId, days = 90 } = _req.body;

      const [talent, brand] = await Promise.all([
        prisma.talent.findUnique({ where: { id: talentId } }),
        prisma.brand.findUnique({ where: { id: brandId } }),
      ]);
      if (!talent) throw new ApiError(404, 7010, '达人不存在');
      if (!brand) throw new ApiError(404, 7011, '品牌不存在');

      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() - days);

      const history = await prisma.cooperation.findMany({
        where: {
          talentId,
          brandId,
          OR: [
            { endDate: { gte: thresholdDate } },
            { endDate: null, startDate: { gte: thresholdDate } },
          ],
        },
        include: {
          invitation: {
            select: { id: true, title: true, status: true, createdAt: true },
          },
        },
        orderBy: { startDate: 'desc' },
      });

      const recentInvitations = history.filter((h) => h.startDate >= thresholdDate);
      const countWithinPeriod = recentInvitations.length;

      const result = {
        talent: { id: talent.id, nickname: talent.nickname, xhsId: talent.xhsId },
        brand: { id: brand.id, name: brand.name },
        checkPeriod: {
          days,
          from: thresholdDate.toISOString().split('T')[0],
          to: new Date().toISOString().split('T')[0],
        },
        cooperationCount: countWithinPeriod,
        riskLevel: countWithinPeriod >= 5 ? 'HIGH' : countWithinPeriod >= 3 ? 'MEDIUM' : 'LOW',
        isDuplicateRisk: countWithinPeriod >= 3,
        history: recentInvitations,
        suggestion:
          countWithinPeriod >= 5
            ? '频繁合作，高风险，建议暂停合作'
            : countWithinPeriod >= 3
            ? '短期内多次合作，建议人工复核'
            : '合作频次正常',
      };

      if (countWithinPeriod >= 3) {
        await prisma.riskRecord.create({
          data: {
            talentId,
            type: RiskType.DUPLICATE_COOPERATION,
            level: (countWithinPeriod >= 5 ? 'HIGH' : 'MEDIUM') as RiskLevel,
            title: '重复合作告警',
            description: `${days}天内与品牌「${brand.name}」合作${countWithinPeriod}次`,
            evidence: JSON.stringify(recentInvitations.map((i) => ({
              invitationId: i.invitationId,
              title: i.invitation.title,
              startDate: i.startDate,
            }))),
          },
        });
      }

      success(res, result, '重复合作检测完成');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 风险记录管理 ============

router.get(
  '/records',
  [
    query('level').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    query('type').optional().isIn(['FAKED_TRAFFIC', 'PROHIBITED_WORDS', 'DUPLICATE_COOPERATION', 'ABNORMAL_BEHAVIOR']),
    query('talentId').optional().isInt(),
    query('handled').optional().isBoolean(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(_req);
      const { level, type, talentId, handled } = _req.query;

      const where: any = {};
      if (level) where.level = level as RiskLevel;
      if (type) where.type = type as RiskType;
      if (talentId) where.talentId = Number(talentId);
      if (handled !== undefined) where.handled = handled === 'true';

      const [list, total] = await Promise.all([
        prisma.riskRecord.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: {
            talent: { select: { id: true, nickname: true, avatarUrl: true } },
            handler: { select: { username: true, realName: true } },
          },
        }),
        prisma.riskRecord.count({ where }),
      ]);

      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/records/:id/handle',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    param('id').isInt(),
    body('handleRemark').notEmpty().withMessage('处理备注不能为空'),
    handleValidation,
  ],
  async (_req: AuthRequest, res, next) => {
    try {
      const id = Number(_req.params.id);
      const { handleRemark } = _req.body;

      const record = await prisma.riskRecord.update({
        where: { id },
        data: {
          handled: true,
          handlerId: _req.user!.id,
          handleRemark,
          handledAt: new Date(),
        },
      });
      success(res, record, '处理完成');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 风险统计 ============

router.get('/stats/overview', requireRoles(UserRole.ADMIN, UserRole.OPERATOR), async (_req, res, next) => {
  try {
    const [byLevel, byType, pendingCount, handledCount] = await Promise.all([
      prisma.riskRecord.groupBy({
        by: ['level'],
        _count: { level: true },
      }),
      prisma.riskRecord.groupBy({
        by: ['type'],
        _count: { type: true },
      }),
      prisma.riskRecord.count({ where: { handled: false } }),
      prisma.riskRecord.count({ where: { handled: true } }),
    ]);

    const levelMap: Record<string, number> = {};
    byLevel.forEach((item) => (levelMap[item.level] = item._count.level));

    const typeMap: Record<string, number> = {};
    byType.forEach((item) => (typeMap[item.type] = item._count.type));

    success(res, {
      total: pendingCount + handledCount,
      pendingCount,
      handledCount,
      byLevel: levelMap,
      byType: typeMap,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
