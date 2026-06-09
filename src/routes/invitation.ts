import { Router } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../lib/prisma';
import { success, successWithPagination, ApiError } from '../utils/response';
import { handleValidation, parsePagination } from '../middleware/error';
import { authMiddleware, AuthRequest, requireRoles } from '../middleware/auth';
import { InvitationStatus, UserRole, TalentStatus } from '../constants/enums';

const router = Router();
router.use(authMiddleware);

// ============ 品牌管理 ============

router.get(
  '/brands',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  async (_req, res, next) => {
    try {
      const brands = await prisma.brand.findMany({ orderBy: { createdAt: 'desc' } });
      success(res, brands);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/brands',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('name').notEmpty().withMessage('品牌名称不能为空'),
    handleValidation,
  ],
  async (req, res, next) => {
    try {
      const exist = await prisma.brand.findUnique({ where: { name: req.body.name } });
      if (exist) throw new ApiError(400, 3001, '品牌已存在');

      const brand = await prisma.brand.create({ data: req.body });
      success(res, brand, '品牌创建成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 邀约需求 ============

router.get(
  '/',
  [
    query('status').optional().isIn(Object.values(InvitationStatus)),
    query('brandId').optional().isInt(),
    query('talentId').optional().isInt(),
    query('keyword').optional().isString(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { status, brandId, talentId, keyword } = req.query;

      const where: any = {};
      if (status) where.status = status as InvitationStatus;
      if (brandId) where.brandId = Number(brandId);
      if (talentId) where.talentId = Number(talentId);
      if (keyword) {
        where.OR = [
          { title: { contains: keyword as string } },
          { description: { contains: keyword as string } },
        ];
      }

      if (req.user!.role === UserRole.TALENT) {
        const talent = await prisma.talent.findUnique({ where: { userId: req.user!.id } });
        if (talent) where.talentId = talent.id;
      }

      const [list, total] = await Promise.all([
        prisma.invitation.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: {
            brand: true,
            talent: { select: { id: true, nickname: true, avatarUrl: true } },
            operator: { select: { id: true, username: true, realName: true } },
          },
        }),
        prisma.invitation.count({ where }),
      ]);

      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', [param('id').isInt(), handleValidation], async (req, res, next) => {
  try {
    const invitation = await prisma.invitation.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        brand: true,
        talent: {
          include: { tags: { include: { tag: true } }, quotations: true },
        },
        operator: true,
        contents: true,
        settlements: true,
        statusLogs: {
          orderBy: { createdAt: 'desc' },
          include: { operator: { select: { username: true, realName: true } } },
        },
      },
    });
    if (!invitation) throw new ApiError(404, 404, '邀约不存在');
    success(res, invitation);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('brandId').isInt().withMessage('请选择品牌'),
    body('talentId').isInt().withMessage('请选择达人'),
    body('title').notEmpty().withMessage('需求标题不能为空'),
    body('contentType').notEmpty().withMessage('内容类型不能为空'),
    body('deadline').notEmpty().withMessage('截止日期不能为空'),
    body('budget').isDecimal().withMessage('预算必须为数字'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { talentId, ...data } = req.body;

      const talent = await prisma.talent.findUnique({ where: { id: talentId } });
      if (!talent) throw new ApiError(404, 3010, '达人不存在');
      if (talent.status === TalentStatus.BLACKLISTED) {
        throw new ApiError(400, 3011, '该达人已被拉黑，无法合作');
      }
      if (talent.status !== TalentStatus.APPROVED) {
        throw new ApiError(400, 3012, '该达人未通过审核，无法合作');
      }

      const invitation = await prisma.$transaction(async (tx) => {
        const inv = await tx.invitation.create({
          data: {
            ...data,
            deadline: new Date(data.deadline),
            talentId,
            operatorId: req.user!.id,
            status: InvitationStatus.DRAFT,
          },
          include: { brand: true, talent: true },
        });

        await tx.statusLog.create({
          data: {
            invitationId: inv.id,
            fromStatus: InvitationStatus.DRAFT,
            toStatus: InvitationStatus.DRAFT,
            operatorId: req.user!.id,
            remark: '创建邀约需求',
          },
        });

        return inv;
      });

      success(res, invitation, '邀约创建成功');
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/:id',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [param('id').isInt(), handleValidation],
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const invitation = await prisma.invitation.findUnique({ where: { id } });
      if (!invitation) throw new ApiError(404, 404, '邀约不存在');

      const editableStatuses = [
        InvitationStatus.DRAFT,
        InvitationStatus.PUBLISHED,
        InvitationStatus.PENDING_TALENT_CONFIRM,
      ];
      if (!editableStatuses.includes(invitation.status)) {
        throw new ApiError(400, 3020, '当前状态不允许修改');
      }

      const { deadline, ...rest } = req.body;
      const updated = await prisma.invitation.update({
        where: { id },
        data: {
          ...rest,
          deadline: deadline ? new Date(deadline) : undefined,
        },
      });
      success(res, updated, '邀约更新成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 状态流转 ============

const recordStatusChange = async (
  tx: any,
  invitationId: number,
  fromStatus: InvitationStatus,
  toStatus: InvitationStatus,
  operatorId: number | null,
  remark: string
) => {
  await tx.statusLog.create({
    data: { invitationId, fromStatus, toStatus, operatorId, remark },
  });
};

router.post(
  '/:id/publish',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [param('id').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const invitation = await prisma.invitation.findUnique({ where: { id } });
      if (!invitation) throw new ApiError(404, 404, '邀约不存在');
      if (invitation.status !== InvitationStatus.DRAFT) {
        throw new ApiError(400, 3030, '仅草稿状态可发布');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const inv = await tx.invitation.update({
          where: { id },
          data: { status: InvitationStatus.PENDING_TALENT_CONFIRM },
        });
        await recordStatusChange(
          tx, id, InvitationStatus.DRAFT, InvitationStatus.PENDING_TALENT_CONFIRM,
          req.user!.id, '发布邀约，等待达人确认'
        );
        return inv;
      });

      success(res, updated, '邀约已发布');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/confirm',
  [
    param('id').isInt(),
    body('scheduledAt').notEmpty().withMessage('请选择档期时间'),
    body('accepted').isBoolean().withMessage('请选择是否接受'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const { accepted, scheduledAt, remark } = req.body;

      const invitation = await prisma.invitation.findUnique({
        where: { id },
        include: { talent: true },
      });
      if (!invitation) throw new ApiError(404, 404, '邀约不存在');

      if (req.user!.role === UserRole.TALENT) {
        if (invitation.talent.userId !== req.user!.id) {
          throw new ApiError(403, 403, '无权限操作');
        }
        if (invitation.status !== InvitationStatus.PENDING_TALENT_CONFIRM) {
          throw new ApiError(400, 3040, '当前状态不可确认');
        }
      } else if (![UserRole.ADMIN, UserRole.OPERATOR].includes(req.user!.role)) {
        throw new ApiError(403, 403, '无权限操作');
      }

      const nextStatus = accepted ? InvitationStatus.TALENT_ACCEPTED : InvitationStatus.TALENT_REJECTED;
      const remarkMsg = accepted
        ? `达人接受邀约，档期: ${scheduledAt}${remark ? `，备注: ${remark}` : ''}`
        : `达人拒绝邀约${remark ? `，原因: ${remark}` : ''}`;

      const updated = await prisma.$transaction(async (tx) => {
        const inv = await tx.invitation.update({
          where: { id },
          data: {
            status: nextStatus,
            scheduledAt: accepted ? new Date(scheduledAt) : null,
          },
        });
        await recordStatusChange(
          tx, id, InvitationStatus.PENDING_TALENT_CONFIRM, nextStatus,
          req.user!.role === UserRole.TALENT ? null : req.user!.id, remarkMsg
        );
        return inv;
      });

      success(res, updated, accepted ? '已确认接受邀约' : '已拒绝邀约');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/start',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [param('id').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const invitation = await prisma.invitation.findUnique({ where: { id } });
      if (!invitation) throw new ApiError(404, 404, '邀约不存在');
      if (invitation.status !== InvitationStatus.TALENT_ACCEPTED) {
        throw new ApiError(400, 3050, '仅达人已接受状态可开始执行');
      }
      if (!invitation.scheduledAt) {
        throw new ApiError(400, 3051, '请先确认档期');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const inv = await tx.invitation.update({
          where: { id },
          data: { status: InvitationStatus.IN_PROGRESS },
        });
        await recordStatusChange(
          tx, id, InvitationStatus.TALENT_ACCEPTED, InvitationStatus.IN_PROGRESS,
          req.user!.id, '开始执行合作'
        );

        await tx.cooperation.create({
          data: {
            talentId: inv.talentId,
            brandId: inv.brandId,
            invitationId: inv.id,
            startDate: new Date(),
          },
        });

        return inv;
      });

      success(res, updated, '合作已开始');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/complete',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [param('id').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const invitation = await prisma.invitation.findUnique({
        where: { id },
        include: { contents: true },
      });
      if (!invitation) throw new ApiError(404, 404, '邀约不存在');
      if (invitation.status !== InvitationStatus.CONTENT_SUBMITTED) {
        throw new ApiError(400, 3060, '需内容提交后才能完成');
      }
      if (invitation.contents.every((c: any) => c.reviewStatus !== 'APPROVED')) {
        throw new ApiError(400, 3061, '需内容审核通过后才能完成');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const inv = await tx.invitation.update({
          where: { id },
          data: { status: InvitationStatus.COMPLETED },
        });
        await recordStatusChange(
          tx, id, InvitationStatus.CONTENT_SUBMITTED, InvitationStatus.COMPLETED,
          req.user!.id, '合作完成'
        );
        await tx.cooperation.updateMany({
          where: { invitationId: id },
          data: { endDate: new Date() },
        });
        return inv;
      });

      success(res, updated, '合作已完成');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/cancel',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    param('id').isInt(),
    body('reason').notEmpty().withMessage('请填写取消原因'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const { reason } = req.body;
      const invitation = await prisma.invitation.findUnique({ where: { id } });
      if (!invitation) throw new ApiError(404, 404, '邀约不存在');

      const completedStatuses = [InvitationStatus.COMPLETED, InvitationStatus.CANCELLED];
      if (completedStatuses.includes(invitation.status)) {
        throw new ApiError(400, 3070, '当前状态不可取消');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const inv = await tx.invitation.update({
          where: { id },
          data: { status: InvitationStatus.CANCELLED },
        });
        await recordStatusChange(
          tx, id, invitation.status, InvitationStatus.CANCELLED,
          req.user!.id, `取消邀约: ${reason}`
        );
        return inv;
      });

      success(res, updated, '邀约已取消');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 统计 ============

router.get('/stats/summary', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const where: any = {};
    if (req.user!.role === UserRole.TALENT) {
      const talent = await prisma.talent.findUnique({ where: { userId: req.user!.id } });
      if (talent) where.talentId = talent.id;
    }

    const [total, byStatus] = await Promise.all([
      prisma.invitation.count({ where }),
      prisma.invitation.groupBy({
        by: ['status'],
        _count: { status: true },
        where,
      }),
    ]);

    const statusMap: Record<string, number> = {};
    byStatus.forEach((item) => {
      statusMap[item.status] = item._count.status;
    });

    success(res, { total, byStatus: statusMap });
  } catch (err) {
    next(err);
  }
});

export default router;
