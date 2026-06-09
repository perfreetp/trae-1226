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

// ============ 品牌方：合作项目总览（含统计卡片+列表） ============

router.get(
  '/overview',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    query('brandId').optional().isInt(),
    query('talentId').optional().isInt(),
    query('status').optional().isIn(Object.values(InvitationStatus)),
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { brandId, talentId, status, startDate, endDate } = req.query;

      const where: any = {};
      if (brandId) where.brandId = Number(brandId);
      if (talentId) where.talentId = Number(talentId);
      if (status) where.status = status as InvitationStatus;
      if (startDate) where.createdAt = { ...where.createdAt, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        where.createdAt = { ...where.createdAt, lte: eDate };
      }

      const invitations = await prisma.invitation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          brand: { select: { id: true, name: true, logoUrl: true } },
          talent: { select: { id: true, nickname: true, avatarUrl: true, xhsId: true } },
          contents: { select: { id: true, reviewStatus: true, title: true } },
          settlements: { select: { id: true, status: true, finalAmount: true, paidAt: true } },
        },
      });

      const contentIds = invitations.reduce<number[]>((acc, inv) => {
        (inv as any).contents.forEach((c: any) => acc.push(c.id));
        return acc;
      }, []);

      const perfWhere: any = {};
      if (contentIds.length > 0) perfWhere.contentId = { in: contentIds };
      if (startDate) perfWhere.date = { ...perfWhere.date, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        perfWhere.date = { ...perfWhere.date, lte: eDate };
      }

      const performances = contentIds.length > 0
        ? await prisma.performanceData.findMany({ where: perfWhere })
        : [];

      const byContentMetrics: Record<number, any> = {};
      performances.forEach((p: any) => {
        if (!p.contentId) return;
        if (!byContentMetrics[p.contentId]) {
          byContentMetrics[p.contentId] = {
            readCount: 0, likeCount: 0, commentCount: 0,
            collectCount: 0, shareCount: 0, clueCount: 0,
          };
        }
        const m = byContentMetrics[p.contentId];
        m.readCount += p.readCount;
        m.likeCount += p.likeCount;
        m.commentCount += p.commentCount;
        m.collectCount += p.collectCount;
        m.shareCount += p.shareCount;
        m.clueCount += p.clueCount;
      });

      const overallMetrics = Object.values(byContentMetrics).reduce(
        (acc, m) => ({
          readCount: acc.readCount + m.readCount,
          likeCount: acc.likeCount + m.likeCount,
          commentCount: acc.commentCount + m.commentCount,
          collectCount: acc.collectCount + m.collectCount,
          shareCount: acc.shareCount + m.shareCount,
          clueCount: acc.clueCount + m.clueCount,
        }),
        { readCount: 0, likeCount: 0, commentCount: 0, collectCount: 0, shareCount: 0, clueCount: 0 }
      );
      const overallInteraction =
        overallMetrics.likeCount + overallMetrics.commentCount + overallMetrics.collectCount + overallMetrics.shareCount;

      const listWithMetrics = invitations.map((inv: any) => {
        const totalContents = inv.contents.length;
        const approvedContents = inv.contents.filter((c: any) => c.reviewStatus === 'APPROVED').length;
        const pendingContents = inv.contents.filter((c: any) => c.reviewStatus === 'PENDING').length;
        const revisionContents = inv.contents.filter((c: any) => c.reviewStatus === 'NEEDS_REVISION').length;
        const reviewProgress = totalContents > 0 ? Math.round((approvedContents / totalContents) * 100) : 0;

        const invMetrics = inv.contents.reduce(
          (acc: any, c: any) => {
            const m = byContentMetrics[c.id];
            if (m) {
              acc.readCount += m.readCount;
              acc.likeCount += m.likeCount;
              acc.commentCount += m.commentCount;
              acc.collectCount += m.collectCount;
              acc.shareCount += m.shareCount;
              acc.clueCount += m.clueCount;
            }
            return acc;
          },
          { readCount: 0, likeCount: 0, commentCount: 0, collectCount: 0, shareCount: 0, clueCount: 0 }
        );
        const invInteraction =
          invMetrics.likeCount + invMetrics.commentCount + invMetrics.collectCount + invMetrics.shareCount;
        const invInteractionRate =
          invMetrics.readCount > 0 ? ((invInteraction / invMetrics.readCount) * 100).toFixed(2) + '%' : '0%';

        const latestSettlement = inv.settlements[0] || null;
        let settlementProgress = 0;
        let settlementStatusText = '未开始';
        if (latestSettlement) {
          const statusFlow: Record<string, number> = {
            PENDING: 25,
            INVOICE_RECEIVED: 50,
            APPROVED: 75,
            PAID: 100,
            DISPUTED: 30,
          };
          settlementProgress = statusFlow[latestSettlement.status] || 0;
          const statusTextMap: Record<string, string> = {
            PENDING: '待登记发票',
            INVOICE_RECEIVED: '发票已收到',
            APPROVED: '审批通过待付款',
            PAID: '已付款',
            DISPUTED: '有异议',
          };
          settlementStatusText = statusTextMap[latestSettlement.status] || latestSettlement.status;
        }

        return {
          id: inv.id,
          title: inv.title,
          description: inv.description,
          status: inv.status,
          contentType: inv.contentType,
          requirements: inv.requirements,
          budget: Number(inv.budget),
          deadline: inv.deadline,
          scheduledAt: inv.scheduledAt,
          createdAt: inv.createdAt,
          brand: inv.brand,
          talent: inv.talent,
          contentProgress: {
            total: totalContents,
            approved: approvedContents,
            pending: pendingContents,
            needsRevision: revisionContents,
            progressPercent: reviewProgress,
          },
          performance: {
            readCount: invMetrics.readCount,
            likeCount: invMetrics.likeCount,
            commentCount: invMetrics.commentCount,
            collectCount: invMetrics.collectCount,
            shareCount: invMetrics.shareCount,
            interactionCount: invInteraction,
            interactionRate: invInteractionRate,
            clueCount: invMetrics.clueCount,
          },
          settlement: latestSettlement
            ? {
                id: latestSettlement.id,
                status: latestSettlement.status,
                statusText: settlementStatusText,
                finalAmount: Number(latestSettlement.finalAmount),
                progressPercent: settlementProgress,
                paidAt: latestSettlement.paidAt,
              }
            : null,
        };
      });

      const statCards = invitations.reduce(
        (acc, inv: any) => {
          acc.totalCount += 1;
          acc.totalBudget += Number(inv.budget);

          const statusBucket = acc.byStatus[inv.status] || { count: 0, budget: 0 };
          statusBucket.count += 1;
          statusBucket.budget += Number(inv.budget);
          acc.byStatus[inv.status] = statusBucket;

          const contents = inv.contents || [];
          acc.totalContents += contents.length;
          acc.approvedContents += contents.filter((c: any) => c.reviewStatus === 'APPROVED').length;

          const settlements = inv.settlements || [];
          acc.totalSettlements += settlements.length;
          settlements.forEach((s: any) => {
            acc.totalSettlementAmount += Number(s.finalAmount);
            if (s.status === 'PAID') {
              acc.paidSettlements += 1;
              acc.paidSettlementAmount += Number(s.finalAmount);
            } else {
              acc.pendingSettlements += 1;
              acc.pendingSettlementAmount += Number(s.finalAmount);
            }
          });

          return acc;
        },
        {
          totalCount: 0,
          totalBudget: 0,
          totalContents: 0,
          approvedContents: 0,
          totalSettlements: 0,
          paidSettlements: 0,
          pendingSettlements: 0,
          totalSettlementAmount: 0,
          paidSettlementAmount: 0,
          pendingSettlementAmount: 0,
          byStatus: {} as Record<string, { count: number; budget: number }>,
        }
      );

      const paginatedList = listWithMetrics.slice(skip, skip + pageSize);
      const total = listWithMetrics.length;

      success(res, {
        stats: {
          totalProjectCount: statCards.totalCount,
          totalBudget: statCards.totalBudget.toFixed(2),
          avgBudgetPerProject: statCards.totalCount > 0 ? (statCards.totalBudget / statCards.totalCount).toFixed(2) : '0.00',
          contentReviewProgress: statCards.totalContents > 0
            ? `${Math.round((statCards.approvedContents / statCards.totalContents) * 100)}%`
            : '0%',
          settlementProgress: statCards.totalSettlements > 0
            ? `${Math.round((statCards.paidSettlements / statCards.totalSettlements) * 100)}%`
            : '0%',
          totalSettlementAmount: statCards.totalSettlementAmount.toFixed(2),
          paidSettlementAmount: statCards.paidSettlementAmount.toFixed(2),
          pendingSettlementAmount: statCards.pendingSettlementAmount.toFixed(2),
          performance: {
            totalRead: overallMetrics.readCount,
            totalLike: overallMetrics.likeCount,
            totalComment: overallMetrics.commentCount,
            totalCollect: overallMetrics.collectCount,
            totalShare: overallMetrics.shareCount,
            totalInteraction: overallInteraction,
            totalClue: overallMetrics.clueCount,
            avgInteractionRate: overallMetrics.readCount > 0
              ? ((overallInteraction / overallMetrics.readCount) * 100).toFixed(2) + '%'
              : '0%',
          },
          byStatus: statCards.byStatus,
        },
        list: paginatedList,
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      }, '项目总览数据加载成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 达人：我的合作工作台 ============

router.get(
  '/talent/workbench',
  requireRoles(UserRole.TALENT),
  handleValidation,
  async (req: AuthRequest, res, next) => {
    try {
      const talent = await prisma.talent.findUnique({ where: { userId: req.user!.id } });
      if (!talent) throw new ApiError(404, 404, '达人档案不存在');
      const talentId = talent.id;

      const [pendingConfirm, inProgressInvitations, settlements, allMyContents, allRevisions] = await Promise.all([
        prisma.invitation.findMany({
          where: { talentId, status: InvitationStatus.PENDING_TALENT_CONFIRM },
          include: { brand: { select: { id: true, name: true, logoUrl: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.invitation.findMany({
          where: {
            talentId,
            status: { in: [InvitationStatus.IN_PROGRESS, InvitationStatus.TALENT_ACCEPTED] },
          },
          include: {
            brand: { select: { id: true, name: true, logoUrl: true, industry: true, contactName: true } },
            contents: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.settlement.findMany({
          where: { talentId },
          include: { invitation: { include: { brand: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.content.findMany({
          where: { invitation: { talentId } },
          include: { invitation: { select: { id: true, title: true, brandId: true, brand: { select: { id: true, name: true } } } } },
          orderBy: { updatedAt: 'desc' },
        }),
        prisma.revision.findMany({
          where: { content: { invitation: { talentId } } },
          include: { proposer: { select: { username: true, realName: true } } },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      const contentRevisionsMap: Record<number, any[]> = {};
      allRevisions.forEach((r: any) => {
        if (!contentRevisionsMap[r.contentId]) contentRevisionsMap[r.contentId] = [];
        contentRevisionsMap[r.contentId].push(r);
      });

      const submittedInvIds = new Set<number>();
      allMyContents.forEach((c: any) => {
        if (['APPROVED', 'PENDING', 'NEEDS_REVISION'].includes(c.reviewStatus)) {
          submittedInvIds.add(c.invitationId);
        }
      });

      const pendingSubmitInvitations = inProgressInvitations
        .filter((inv: any) => !submittedInvIds.has(inv.id) ||
          inv.contents.every((c: any) => c.reviewStatus === 'DRAFT' || c.reviewStatus === 'NEEDS_REVISION')
        )
        .filter((inv: any) => {
          const approvedCount = inv.contents.filter((c: any) => c.reviewStatus === 'APPROVED').length;
          return approvedCount < 1;
        });

      const needsRevisionContents = allMyContents.filter(
        (c: any) => c.reviewStatus === 'NEEDS_REVISION'
      );
      const pendingReviewContents = allMyContents.filter(
        (c: any) => c.reviewStatus === 'PENDING'
      );

      const pendingSettlements = settlements.filter(
        (s: any) => s.status !== 'PAID'
      );
      const completedSettlements = settlements.filter(
        (s: any) => s.status === 'PAID'
      );

      const submitEntryHint: Record<string, any> = {
        NOTE: {
          label: '图文笔记',
          fields: [
            { key: 'title', label: '笔记标题', type: 'text', required: true, maxLength: 50, placeholder: '请输入吸引人的标题，突出产品卖点' },
            { key: 'noteContent', label: '正文内容', type: 'textarea', required: true, placeholder: '分享产品真实体验，包含使用感受、效果展示等' },
            { key: 'imageUrls', label: '配图（最多9张）', type: 'images', required: true, maxCount: 9, hint: '建议 3:4 竖图，展示产品细节、对比图、场景图' },
            { key: 'tagList', label: '话题标签', type: 'tags', required: false, hint: '#品牌名 #产品类别 #使用场景 等' },
          ],
        },
        VIDEO: {
          label: '视频笔记',
          fields: [
            { key: 'title', label: '视频标题', type: 'text', required: true, maxLength: 50, placeholder: '突出主题的标题' },
            { key: 'videoUrl', label: '视频', type: 'video', required: true, hint: '建议 9:16，时长 15s-60s' },
            { key: 'coverImage', label: '视频封面', type: 'image', required: true, hint: '3:4 竖图，清晰有吸引力' },
            { key: 'videoContent', label: '配文描述', type: 'textarea', required: true, placeholder: '视频要点、产品亮点' },
            { key: 'tagList', label: '话题标签', type: 'tags', required: false },
          ],
        },
        LIVE: {
          label: '直播',
          fields: [
            { key: 'title', label: '直播标题', type: 'text', required: true, placeholder: '直播间标题' },
            { key: 'liveUrl', label: '直播回放/预约链接', type: 'text', required: true },
            { key: 'coverImage', label: '直播封面', type: 'image', required: true },
            { key: 'liveTime', label: '开播时间', type: 'datetime', required: true },
            { key: 'noteContent', label: '直播预告/总结', type: 'textarea', required: true },
          ],
        },
        DEFAULT: {
          label: '内容',
          fields: [
            { key: 'title', label: '标题', type: 'text', required: true },
            { key: 'noteContent', label: '正文', type: 'textarea', required: true },
            { key: 'imageUrls', label: '素材', type: 'images', required: true },
          ],
        },
      };

      success(res, {
        talent: { id: talent.id, nickname: talent.nickname, avatarUrl: talent.avatarUrl, xhsId: talent.xhsId },
        summary: {
          pendingConfirmCount: pendingConfirm.length,
          pendingSubmitCount: pendingSubmitInvitations.length,
          needsRevisionCount: needsRevisionContents.length,
          pendingSettlementCount: pendingSettlements.length,
          totalEarned: completedSettlements.reduce((acc: number, s: any) => acc + Number(s.finalAmount), 0).toFixed(2),
        },
        categories: {
          pendingConfirm: pendingConfirm.map((inv: any) => ({
            id: inv.id,
            title: inv.title,
            brand: inv.brand,
            budget: Number(inv.budget),
            deadline: inv.deadline,
            createdAt: inv.createdAt,
            detailType: 'INVITATION',
          })),
          pendingSubmit: pendingSubmitInvitations.map((inv: any) => {
            const contentType: string = inv.contentType || 'NOTE';
            const hintKey = Object.keys(submitEntryHint).includes(contentType) ? contentType : 'DEFAULT';
            const draftContents = inv.contents.filter((c: any) => c.reviewStatus === 'DRAFT');
            const hasExistingDraft = draftContents.length > 0;
            return {
              id: inv.id,
              invitationId: inv.id,
              title: inv.title,
              brand: inv.brand,
              contentType,
              contentTypeLabel: submitEntryHint[hintKey].label,
              budget: Number(inv.budget),
              deadline: inv.deadline,
              scheduledAt: inv.scheduledAt,
              description: inv.description,
              requirements: inv.requirements,
              existingDraftCount: draftContents.length,
              existingDraftId: hasExistingDraft ? draftContents[0].id : null,
              detailType: 'INVITATION_CONTENT_ENTRY',
              submitEntry: {
                hintText: `提交${submitEntryHint[hintKey].label}`,
                requireContentId: hasExistingDraft,
                fields: submitEntryHint[hintKey].fields,
                submitApi: hasExistingDraft
                  ? { method: 'PUT', url: `/api/v1/contents/${draftContents[0].id}` }
                  : { method: 'POST', url: '/api/v1/contents', body: { invitationId: inv.id } },
              },
            };
          }),
          needsRevision: needsRevisionContents.map((c: any) => ({
            id: c.id,
            contentId: c.id,
            invitationId: c.invitationId,
            title: c.title,
            brand: c.invitation.brand,
            contentType: c.contentType,
            updatedAt: c.updatedAt,
            reviewRemark: c.reviewRemark,
            revisions: (contentRevisionsMap[c.id] || []).map((r: any) => ({
              id: r.id,
              version: r.version,
              field: r.field,
              suggestion: r.suggestion,
              example: r.example,
              createdAt: r.createdAt,
              proposer: r.proposer,
            })),
            detailType: 'CONTENT_REVISION',
            submitEntry: {
              hintText: '修改后重新提交审核',
              fields: [
                { key: 'title', label: '修改标题', type: 'text', currentValue: c.title },
                { key: 'noteContent', label: '修改正文', type: 'textarea', currentValue: c.content },
                { key: 'revisionRemark', label: '修改说明（可选）', type: 'textarea' },
              ],
              submitApi: { method: 'POST', url: `/api/v1/contents/${c.id}/revisions` },
            },
          })),
          pendingSettlement: pendingSettlements.map((s: any) => ({
            id: s.id,
            settlementId: s.id,
            invitationId: s.invitationId,
            invitationTitle: s.invitation.title,
            brand: s.invitation.brand,
            baseAmount: Number(s.baseAmount),
            commission: Number(s.commission),
            taxAmount: Number(s.taxAmount),
            finalAmount: Number(s.finalAmount),
            commissionRate: `${Number(s.commissionRate).toFixed(1)}%`,
            status: s.status,
            statusText: ({
              PENDING: '待登记发票',
              INVOICE_RECEIVED: '发票已收到',
              APPROVED: '审批通过待付款',
              DISPUTED: '有异议处理中',
            } as any)[s.status] || s.status,
            invoiceNo: s.invoiceNo,
            invoiceReceived: s.invoiceReceived,
            paidAt: s.paidAt,
            createdAt: s.createdAt,
            detailType: 'SETTLEMENT',
          })),
        },
        extras: {
          pendingReview: pendingReviewContents.map((c: any) => ({
            id: c.id,
            invitationId: c.invitationId,
            title: c.title,
            brand: c.invitation.brand,
            contentType: c.contentType,
            submittedAt: c.submittedAt || c.updatedAt,
          })),
        },
      }, '工作台数据加载成功');
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
