import { Router } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../lib/prisma';
import { success, successWithPagination, ApiError } from '../utils/response';
import { handleValidation, parsePagination } from '../middleware/error';
import { authMiddleware, AuthRequest, requireRoles } from '../middleware/auth';
import { ContentReviewStatus, InvitationStatus, UserRole } from '../constants/enums';

const router = Router();
router.use(authMiddleware);

// ============ 内容列表/详情 ============

router.get(
  '/',
  [
    query('reviewStatus').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_REVISION']),
    query('invitationId').optional().isInt(),
    query('talentId').optional().isInt(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { reviewStatus, invitationId, talentId } = req.query;

      const where: any = {};
      if (reviewStatus) where.reviewStatus = reviewStatus as ContentReviewStatus;
      if (invitationId) where.invitationId = Number(invitationId);
      if (talentId) where.talentId = Number(talentId);

      if (req.user!.role === UserRole.TALENT) {
        const talent = await prisma.talent.findUnique({ where: { userId: req.user!.id } });
        if (talent) where.talentId = talent.id;
      }

      const [list, total] = await Promise.all([
        prisma.content.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: {
            invitation: { include: { brand: true } },
            talent: { select: { id: true, nickname: true, avatarUrl: true } },
            submitter: { select: { username: true, realName: true } },
            reviewer: { select: { username: true, realName: true } },
          },
        }),
        prisma.content.count({ where }),
      ]);

      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', [param('id').isInt(), handleValidation], async (req, res, next) => {
  try {
    const content = await prisma.content.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        invitation: { include: { brand: true } },
        talent: true,
        submitter: true,
        reviewer: true,
        revisions: {
          orderBy: { version: 'desc' },
          include: { proposer: { select: { username: true, realName: true } } },
        },
      },
    });
    if (!content) throw new ApiError(404, 404, '内容不存在');
    success(res, content);
  } catch (err) {
    next(err);
  }
});

// ============ 提交内容 ============

router.post(
  '/',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR, UserRole.TALENT),
  [
    body('invitationId').isInt().withMessage('邀约ID不能为空'),
    body('noteUrl').optional().isURL().withMessage('笔记链接格式不正确'),
    body('title').optional().isString(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { invitationId, noteUrl, title, coverImageUrl, contentImages, body } = req.body;

      const invitation = await prisma.invitation.findUnique({
        where: { id: invitationId },
        include: { talent: true },
      });
      if (!invitation) throw new ApiError(404, 4010, '邀约不存在');
      if (invitation.status !== InvitationStatus.IN_PROGRESS) {
        throw new ApiError(400, 4011, '仅执行中状态可提交内容');
      }

      if (req.user!.role === UserRole.TALENT && invitation.talent.userId !== req.user!.id) {
        throw new ApiError(403, 403, '无权限提交该邀约内容');
      }

      const content = await prisma.$transaction(async (tx) => {
        const c = await tx.content.create({
          data: {
            invitationId,
            talentId: invitation.talentId,
            noteUrl,
            title,
            coverImageUrl,
            contentImages,
            body,
            reviewStatus: ContentReviewStatus.PENDING,
            submitterId: req.user!.id,
          },
        });

        await tx.invitation.update({
          where: { id: invitationId },
          data: { status: InvitationStatus.CONTENT_SUBMITTED },
        });

        await tx.statusLog.create({
          data: {
            invitationId,
            fromStatus: InvitationStatus.IN_PROGRESS,
            toStatus: InvitationStatus.CONTENT_SUBMITTED,
            operatorId: req.user!.id,
            remark: '达人提交内容',
          },
        });

        return c;
      });

      success(res, content, '内容提交成功');
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/:id',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR, UserRole.TALENT),
  [param('id').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const content = await prisma.content.findUnique({
        where: { id },
        include: { talent: true },
      });
      if (!content) throw new ApiError(404, 404, '内容不存在');

      if (req.user!.role === UserRole.TALENT && content.talent.userId !== req.user!.id) {
        throw new ApiError(403, 403, '无权限操作');
      }

      const allowedStatuses = [ContentReviewStatus.PENDING, ContentReviewStatus.NEEDS_REVISION];
      if (!allowedStatuses.includes(content.reviewStatus)) {
        throw new ApiError(400, 4020, '当前审核状态不可修改');
      }

      const { noteUrl, title, coverImageUrl, contentImages, body } = req.body;

      const latestRevision = await prisma.revision.findFirst({
        where: { contentId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latestRevision?.version || 0) + 1;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.revision.create({
          data: {
            contentId: id,
            version: nextVersion,
            title: content.title,
            coverImageUrl: content.coverImageUrl,
            contentImages: content.contentImages,
            body: content.body,
            changeLog: `提交新版本 v${nextVersion}`,
            proposerId: req.user!.id,
          },
        });

        return tx.content.update({
          where: { id },
          data: {
            noteUrl,
            title,
            coverImageUrl,
            contentImages,
            body,
            reviewStatus: ContentReviewStatus.PENDING,
          },
        });
      });

      success(res, updated, '内容更新成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 内容审核 ============

router.post(
  '/:id/review',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    param('id').isInt(),
    body('status').isIn(['APPROVED', 'REJECTED', 'NEEDS_REVISION']).withMessage('审核状态不正确'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const { status, reviewRemark } = req.body;
      const reviewStatus = status as ContentReviewStatus;

      const content = await prisma.content.findUnique({ where: { id } });
      if (!content) throw new ApiError(404, 404, '内容不存在');

      const statusText: Record<string, string> = {
        APPROVED: '通过',
        REJECTED: '驳回',
        NEEDS_REVISION: '需修改',
      };

      const updated = await prisma.$transaction(async (tx) => {
        const c = await tx.content.update({
          where: { id },
          data: {
            reviewStatus,
            reviewerId: req.user!.id,
            reviewedAt: new Date(),
            reviewRemark,
          },
        });

        if (reviewStatus === ContentReviewStatus.NEEDS_REVISION && reviewRemark) {
          const latestRevision = await tx.revision.findFirst({
            where: { contentId: id },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          const nextVersion = (latestRevision?.version || 0) + 1;

          await tx.revision.create({
            data: {
              contentId: id,
              version: nextVersion,
              title: c.title,
              coverImageUrl: c.coverImageUrl,
              contentImages: c.contentImages,
              body: c.body,
              changeLog: `审核${statusText[status]}：${reviewRemark}`,
              proposerId: req.user!.id,
            },
          });
        }

        return c;
      });

      success(res, updated, `审核${statusText[status]}`);
    } catch (err) {
      next(err);
    }
  }
);

// ============ 修改意见 ============

router.get(
  '/:id/revisions',
  [param('id').isInt(), handleValidation],
  async (req, res, next) => {
    try {
      const revisions = await prisma.revision.findMany({
        where: { contentId: Number(req.params.id) },
        orderBy: { version: 'desc' },
        include: { proposer: { select: { username: true, realName: true, role: true } } },
      });
      success(res, revisions);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/revisions',
  [
    param('id').isInt(),
    body('changeLog').notEmpty().withMessage('修改意见不能为空'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const { changeLog, title, coverImageUrl, contentImages, body } = req.body;

      const content = await prisma.content.findUnique({ where: { id } });
      if (!content) throw new ApiError(404, 404, '内容不存在');

      const latestRevision = await prisma.revision.findFirst({
        where: { contentId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (latestRevision?.version || 0) + 1;

      const revision = await prisma.revision.create({
        data: {
          contentId: id,
          version: nextVersion,
          title: title || content.title,
          coverImageUrl: coverImageUrl || content.coverImageUrl,
          contentImages: contentImages || content.contentImages,
          body: body || content.body,
          changeLog,
          proposerId: req.user!.id,
        },
      });

      success(res, revision, '修改意见已记录');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 数据统计 ============

router.get('/stats/review', async (req: AuthRequest, res, next) => {
  try {
    const where: any = {};
    if (req.user!.role === UserRole.TALENT) {
      const talent = await prisma.talent.findUnique({ where: { userId: req.user!.id } });
      if (talent) where.talentId = talent.id;
    }

    const byStatus = await prisma.content.groupBy({
      by: ['reviewStatus'],
      _count: { reviewStatus: true },
      where,
    });

    const statusMap: Record<string, number> = {};
    byStatus.forEach((item) => {
      statusMap[item.reviewStatus] = item._count.reviewStatus;
    });

    success(res, { byStatus: statusMap });
  } catch (err) {
    next(err);
  }
});

export default router;
