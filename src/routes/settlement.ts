import { Router } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../lib/prisma';
import { success, successWithPagination, ApiError } from '../utils/response';
import { handleValidation, parsePagination } from '../middleware/error';
import { authMiddleware, AuthRequest, requireRoles } from '../middleware/auth';
import { Prisma } from '@prisma/client';
import { SettlementStatus, InvitationStatus, UserRole } from '../constants/enums';

const router = Router();
router.use(authMiddleware);

// ============ 结算单查询 ============

router.get(
  '/',
  [
    query('status').optional().isIn(['PENDING', 'INVOICE_RECEIVED', 'APPROVED', 'PAID', 'DISPUTED']),
    query('talentId').optional().isInt(),
    query('invitationId').optional().isInt(),
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { status, talentId, invitationId, startDate, endDate } = req.query;

      const where: any = {};
      if (status) where.status = status as SettlementStatus;
      if (talentId) where.talentId = Number(talentId);
      if (invitationId) where.invitationId = Number(invitationId);
      if (startDate) where.createdAt = { ...where.createdAt, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        where.createdAt = { ...where.createdAt, lte: eDate };
      }

      if (req.user!.role === UserRole.TALENT) {
        const talent = await prisma.talent.findUnique({ where: { userId: req.user!.id } });
        if (talent) where.talentId = talent.id;
      }

      const [list, total] = await Promise.all([
        prisma.settlement.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: {
            invitation: { include: { brand: true } },
            talent: { select: { id: true, nickname: true, realName: true, bankName: true, bankAccount: true } },
            approver: { select: { username: true, realName: true } },
          },
        }),
        prisma.settlement.count({ where }),
      ]);

      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

// ============ 财务：批量结算流程 ============

router.get(
  '/batch/pending-list',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    query('brandId').optional().isInt(),
    query('talentId').optional().isInt(),
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    query('includeWithExisting').optional().isBoolean(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { brandId, talentId, startDate, endDate, includeWithExisting } = _req.query;
      const includeExisting = includeWithExisting === 'true';

      const invWhere: any = { status: InvitationStatus.COMPLETED };
      if (brandId) invWhere.brandId = Number(brandId);
      if (talentId) invWhere.talentId = Number(talentId);
      if (startDate) invWhere.updatedAt = { ...invWhere.updatedAt, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        invWhere.updatedAt = { ...invWhere.updatedAt, lte: eDate };
      }

      const completedInvitations = await prisma.invitation.findMany({
        where: invWhere,
        orderBy: { updatedAt: 'desc' },
        include: {
          brand: { select: { id: true, name: true } },
          talent: { select: { id: true, nickname: true, realName: true, taxRate: true } },
          settlements: true,
          contents: { select: { id: true, reviewStatus: true, createdAt: true } },
        },
      });

      const pendingList = completedInvitations
        .filter((inv: any) => includeExisting || inv.settlements.length === 0)
        .map((inv: any) => {
          const baseAmount = Number(inv.budget);
          const rate = Number(inv.talent.taxRate || 10);
          const commission = baseAmount * (rate / 100);
          const taxAmount = baseAmount * 0.06;
          const finalAmount = baseAmount - commission - taxAmount;
          const existingSettlement = inv.settlements[0] || null;

          return {
            invitationId: inv.id,
            invitationTitle: inv.title,
            brand: inv.brand,
            talent: inv.talent,
            budget: baseAmount.toFixed(2),
            contentType: inv.contentType,
            completedAt: inv.updatedAt,
            contentsPassed: inv.contents.filter((c: any) => c.reviewStatus === 'APPROVED').length,
            contentsTotal: inv.contents.length,
            calculation: {
              commissionRate: `${rate.toFixed(2)}%`,
              commission: commission.toFixed(2),
              taxAmount: taxAmount.toFixed(2),
              finalAmount: finalAmount.toFixed(2),
            },
            existingSettlement: existingSettlement
              ? {
                  id: existingSettlement.id,
                  status: existingSettlement.status,
                  finalAmount: Number(existingSettlement.finalAmount),
                }
              : null,
          };
        });

      const summary = pendingList.reduce(
        (acc, item) => {
          acc.count += 1;
          acc.totalBudget += Number(item.budget);
          acc.totalFinal += Number(item.calculation.finalAmount);
          if (item.existingSettlement) acc.withExisting += 1;
          else acc.needCreate += 1;
          return acc;
        },
        { count: 0, totalBudget: 0, totalFinal: 0, needCreate: 0, withExisting: 0 }
      );

      success(res, {
        summary: {
          totalCount: summary.count,
          needCreateCount: summary.needCreate,
          withExistingCount: summary.withExisting,
          totalBudget: summary.totalBudget.toFixed(2),
          totalEstimatedPayout: summary.totalFinal.toFixed(2),
        },
        list: pendingList,
      }, '待结算清单生成完成');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/batch/invoice',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    body('items').isArray({ min: 1 }).withMessage('请至少选择一条结算单'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { items } = req.body;
      const results: Array<{
        settlementId: number;
        success: boolean;
        message: string;
      }> = [];

      for (const item of items) {
        const { settlementId, invoiceNo, invoiceUrl } = item;
        try {
          if (!settlementId || !invoiceNo) {
            results.push({ settlementId, success: false, message: '缺少结算单ID或发票号' });
            continue;
          }

          const settlement = await prisma.settlement.findUnique({ where: { id: Number(settlementId) } });
          if (!settlement) {
            results.push({ settlementId, success: false, message: '结算单不存在' });
            continue;
          }
          if (settlement.status !== SettlementStatus.PENDING) {
            results.push({ settlementId, success: false, message: `当前状态[${settlement.status}]不可登记发票` });
            continue;
          }

          await prisma.settlement.update({
            where: { id: Number(settlementId) },
            data: {
              invoiceNo,
              invoiceUrl: invoiceUrl || null,
              invoiceReceived: true,
              invoiceReceivedAt: new Date(),
              status: SettlementStatus.INVOICE_RECEIVED,
            },
          });
          results.push({ settlementId, success: true, message: '发票登记成功' });
        } catch (e: any) {
          results.push({ settlementId, success: false, message: `处理异常: ${e.message}` });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      success(res, {
        total: results.length,
        successCount,
        failCount: results.length - successCount,
        results,
      }, `批量登记发票完成：成功${successCount}条，失败${results.length - successCount}条`);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/batch/approve',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    body('settlementIds').isArray({ min: 1 }).withMessage('请至少选择一条结算单'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { settlementIds, remark } = req.body;
      const results: Array<{
        settlementId: number;
        success: boolean;
        message: string;
      }> = [];

      for (const sid of settlementIds) {
        try {
          const id = Number(sid);
          if (!id) {
            results.push({ settlementId: sid, success: false, message: '结算单ID无效' });
            continue;
          }

          const settlement = await prisma.settlement.findUnique({ where: { id } });
          if (!settlement) {
            results.push({ settlementId: sid, success: false, message: '结算单不存在' });
            continue;
          }

          const allowed = [SettlementStatus.PENDING, SettlementStatus.INVOICE_RECEIVED];
          if (!allowed.includes(settlement.status)) {
            results.push({ settlementId: sid, success: false, message: `当前状态[${settlement.status}]不可审批` });
            continue;
          }
          if (!settlement.invoiceReceived) {
            results.push({ settlementId: sid, success: false, message: '请先登记发票信息' });
            continue;
          }

          await prisma.settlement.update({
            where: { id },
            data: {
              status: SettlementStatus.APPROVED,
              approverId: req.user!.id,
              remark: remark || settlement.remark,
            },
          });
          results.push({ settlementId: sid, success: true, message: '审批通过' });
        } catch (e: any) {
          results.push({ settlementId: sid, success: false, message: `处理异常: ${e.message}` });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      success(res, {
        total: results.length,
        successCount,
        failCount: results.length - successCount,
        results,
      }, `批量审批完成：成功${successCount}条，失败${results.length - successCount}条`);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/batch/pay',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    body('items').isArray({ min: 1 }).withMessage('请至少选择一条结算单'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { items } = req.body;
      const results: Array<{
        settlementId: number;
        success: boolean;
        message: string;
      }> = [];

      for (const item of items) {
        const { settlementId, paymentVoucher, remark } = item;
        try {
          const id = Number(settlementId);
          if (!id || !paymentVoucher) {
            results.push({ settlementId, success: false, message: '缺少结算单ID或付款凭证' });
            continue;
          }

          const settlement = await prisma.settlement.findUnique({ where: { id } });
          if (!settlement) {
            results.push({ settlementId, success: false, message: '结算单不存在' });
            continue;
          }
          if (settlement.status !== SettlementStatus.APPROVED) {
            results.push({ settlementId, success: false, message: `当前状态[${settlement.status}]不可标记付款` });
            continue;
          }

          await prisma.settlement.update({
            where: { id },
            data: {
              status: SettlementStatus.PAID,
              paidAt: new Date(),
              paymentVoucher,
              remark: remark || settlement.remark,
            },
          });
          results.push({ settlementId, success: true, message: '付款已确认' });
        } catch (e: any) {
          results.push({ settlementId, success: false, message: `处理异常: ${e.message}` });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      success(res, {
        total: results.length,
        successCount,
        failCount: results.length - successCount,
        results,
      }, `批量标记付款完成：成功${successCount}条，失败${results.length - successCount}条`);
    } catch (err) {
      next(err);
    }
  }
);

// ============ 财务：结算批次管理 ============

router.post(
  '/batches',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    body('name').isString().notEmpty().withMessage('请输入批次名称'),
    body('settlementIds').optional().isArray(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { name, settlementIds, remark } = req.body;
      const userId = req.user!.id;

      const batchNo = `BATCH${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

      const batch = await prisma.settlementBatch.create({
        data: {
          batchNo,
          name,
          remark: remark || null,
          creatorId: userId,
          status: 'OPEN',
        },
      });

      const results: Array<{ settlementId: number; success: boolean; message: string }> = [];
      let totalAmount = 0;
      let invRecv = 0;
      let apprCount = 0;
      let paidCount = 0;

      if (settlementIds && settlementIds.length > 0) {
        for (const sid of settlementIds) {
          try {
            const id = Number(sid);
            if (!id) { results.push({ settlementId: sid, success: false, message: '结算单ID无效' }); continue; }
            const s = await prisma.settlement.findUnique({ where: { id } });
            if (!s) { results.push({ settlementId: sid, success: false, message: '结算单不存在' }); continue; }
            if (s.batchId) { results.push({ settlementId: sid, success: false, message: '该结算单已绑定其他批次' }); continue; }

            await prisma.settlement.update({ where: { id }, data: { batchId: batch.id } });
            totalAmount += Number(s.finalAmount);
            if (s.invoiceReceived) invRecv += 1;
            if (s.status === 'APPROVED' || s.status === 'PAID') apprCount += 1;
            if (s.status === 'PAID') paidCount += 1;
            results.push({ settlementId: sid, success: true, message: '已加入批次' });
          } catch (e: any) {
            results.push({ settlementId: sid, success: false, message: `处理异常: ${e.message}` });
          }
        }

        const addedCount = results.filter((r) => r.success).length;
        if (addedCount > 0) {
          await prisma.settlementBatch.update({
            where: { id: batch.id },
            data: {
              totalAmount,
              invoiceReceivedCount: invRecv,
              approvedCount: apprCount,
              paidCount,
            },
          });
        }
      }

      success(res, {
        batch: { id: batch.id, batchNo: batch.batchNo, name: batch.name, status: batch.status },
        total: results.length,
        addedCount: results.filter((r) => r.success).length,
        failedCount: results.filter((r) => !r.success).length,
        results,
      }, `批次创建成功，已加入 ${results.filter((r) => r.success).length} 笔结算单`);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/batches',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    query('status').optional().isString(),
    query('keyword').optional().isString(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(_req);
      const { status, keyword } = _req.query;

      const where: any = {};
      if (status) where.status = status;
      if (keyword) where.OR = [{ name: { contains: keyword as string } }, { batchNo: { contains: keyword as string } }];

      const [list, total] = await Promise.all([
        prisma.settlementBatch.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: {
            creator: { select: { id: true, username: true, realName: true } },
            _count: { select: { settlements: true } },
          },
        }),
        prisma.settlementBatch.count({ where }),
      ]);

      const stats = await prisma.settlementBatch.aggregate({
        _sum: { totalAmount: true },
        _count: true,
      });

      const listWithProgress = list.map((b: any) => {
        const total = b._count.settlements;
        return {
          id: b.id,
          batchNo: b.batchNo,
          name: b.name,
          status: b.status,
          remark: b.remark,
          totalAmount: Number(b.totalAmount),
          settlementCount: total,
          invoiceReceivedCount: b.invoiceReceivedCount,
          approvedCount: b.approvedCount,
          paidCount: b.paidCount,
          progress: {
            invoiceProgress: total > 0 ? `${Math.round((b.invoiceReceivedCount / total) * 100)}%` : '0%',
            approveProgress: total > 0 ? `${Math.round((b.approvedCount / total) * 100)}%` : '0%',
            paidProgress: total > 0 ? `${Math.round((b.paidCount / total) * 100)}%` : '0%',
            completed: total > 0 && b.paidCount === total,
          },
          creator: b.creator,
          closedAt: b.closedAt,
          createdAt: b.createdAt,
        };
      });

      successWithPagination(res, listWithProgress, total, page, pageSize, {
        summary: {
          totalBatchCount: stats._count,
          totalBatchAmount: Number(stats._sum.totalAmount || 0).toFixed(2),
        },
      }, '批次列表加载成功');
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/batches/:bid',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [param('bid').isInt(), handleValidation],
  async (req, res, next) => {
    try {
      const id = Number(req.params.bid);
      const batch = await prisma.settlementBatch.findUnique({
        where: { id },
        include: {
          creator: { select: { id: true, username: true, realName: true } },
          settlements: {
            include: {
              invitation: { include: { brand: true } },
              talent: { select: { id: true, nickname: true, realName: true, xhsId: true } },
              approver: { select: { username: true, realName: true } },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      if (!batch) throw new ApiError(404, 404, '结算批次不存在');

      const settlements = (batch as any).settlements;
      const count = settlements.length;

      const operations: Array<{
        settlementId: number;
        title: string;
        talent: string;
        brand: string;
        status: string;
        finalAmount: number;
        invoice: { received: boolean; invoiceNo: string | null };
        approval: { approved: boolean; approver: string | null; approvedAt: string | null };
        payment: { paid: boolean; paidAt: string | null; voucher: string | null };
        detailType: string;
      }> = settlements.map((s: any) => ({
        settlementId: s.id,
        title: s.invitation?.title || '',
        talent: s.talent?.nickname || '',
        brand: s.invitation?.brand?.name || '',
        status: s.status,
        finalAmount: Number(s.finalAmount),
        invoice: {
          received: s.invoiceReceived,
          invoiceNo: s.invoiceNo,
        },
        approval: {
          approved: s.status === 'APPROVED' || s.status === 'PAID',
          approver: s.approver?.realName || s.approver?.username || null,
          approvedAt: s.status === 'APPROVED' ? s.updatedAt : s.paidAt,
        },
        payment: {
          paid: s.status === 'PAID',
          paidAt: s.paidAt,
          voucher: s.paymentVoucher,
        },
        detailType: 'SETTLEMENT_DETAIL',
      }));

      const invoicesAll = operations.filter((o) => o.invoice.received).length;
      const approvalsAll = operations.filter((o) => o.approval.approved).length;
      const paymentsAll = operations.filter((o) => o.payment.paid).length;

      success(res, {
        batch: {
          id: batch.id,
          batchNo: batch.batchNo,
          name: batch.name,
          status: batch.status,
          remark: batch.remark,
          totalAmount: Number(batch.totalAmount),
          settlementCount: count,
          creator: batch.creator,
          closedAt: batch.closedAt,
          createdAt: batch.createdAt,
          updatedAt: batch.updatedAt,
        },
        progress: {
          total: count,
          invoiceReceivedCount: invoicesAll,
          approvedCount: approvalsAll,
          paidCount: paymentsAll,
          invoiceProgress: count > 0 ? `${Math.round((invoicesAll / count) * 100)}%` : '0%',
          approveProgress: count > 0 ? `${Math.round((approvalsAll / count) * 100)}%` : '0%',
          paidProgress: count > 0 ? `${Math.round((paymentsAll / count) * 100)}%` : '0%',
          completed: count > 0 && paymentsAll === count,
        },
        items: operations,
        actionSuggestions: {
          pendingInvoices: operations.filter((o) => !o.invoice.received).map((o) => o.settlementId),
          pendingApproval: operations.filter((o) => o.invoice.received && !o.approval.approved).map((o) => o.settlementId),
          pendingPayment: operations.filter((o) => o.approval.approved && !o.payment.paid).map((o) => o.settlementId),
        },
      }, '批次详情加载成功');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/batches/:bid/close',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [param('bid').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.bid);
      const batch = await prisma.settlementBatch.findUnique({ where: { id }, include: { settlements: true } });
      if (!batch) throw new ApiError(404, 404, '结算批次不存在');

      const total = (batch as any).settlements.length;
      const allPaid = total > 0 && (batch as any).settlements.every((s: any) => s.status === 'PAID');

      const updated = await prisma.settlementBatch.update({
        where: { id },
        data: {
          status: allPaid ? 'CLOSED' : 'PARTIAL_CLOSED',
          closedAt: new Date(),
          remark: req.body.remark || batch.remark,
        },
      });

      success(res, {
        batch: { id: updated.id, status: updated.status, closedAt: updated.closedAt },
        message: allPaid ? '批次已全额完成并关闭' : '批次已部分关闭，仍有未付款结算单',
      }, allPaid ? '批次已成功关闭' : '批次已部分关闭');
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id', [param('id').isInt(), handleValidation], async (req, res, next) => {
  try {
    const settlement = await prisma.settlement.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        invitation: {
          include: {
            brand: true,
            contents: true,
            statusLogs: { orderBy: { createdAt: 'desc' }, take: 5 },
          },
        },
        talent: true,
        approver: true,
      },
    });
    if (!settlement) throw new ApiError(404, 404, '结算单不存在');
    success(res, settlement);
  } catch (err) {
    next(err);
  }
});

// ============ 创建结算单（自动计算佣金） ============

router.post(
  '/calculate',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR, UserRole.FINANCE),
  [
    body('invitationId').isInt().withMessage('邀约ID不能为空'),
    body('commissionRate').optional().isDecimal().withMessage('佣金比例必须为数字'),
    handleValidation,
  ],
  async (req, res, next) => {
    try {
      const { invitationId, commissionRate } = req.body;

      const invitation = await prisma.invitation.findUnique({
        where: { id: invitationId },
        include: { talent: true, brand: true },
      });
      if (!invitation) throw new ApiError(404, 6010, '邀约不存在');
      if (invitation.status !== InvitationStatus.COMPLETED) {
        throw new ApiError(400, 6011, '仅已完成的邀约可创建结算单');
      }

      const existSettlement = await prisma.settlement.findFirst({ where: { invitationId } });
      if (existSettlement) throw new ApiError(400, 6012, '该邀约已存在结算单');

      const baseAmount = Number(invitation.budget);
      const rate = commissionRate !== undefined ? Number(commissionRate) : Number(invitation.talent.taxRate || 10);
      const commission = baseAmount * (rate / 100);
      const taxAmount = baseAmount * 0.06;
      const finalAmount = baseAmount - commission - taxAmount;

      const calculation = {
        invitationId,
        brand: { id: invitation.brand.id, name: invitation.brand.name },
        talent: { id: invitation.talent.id, nickname: invitation.talent.nickname },
        baseAmount: baseAmount.toFixed(2),
        commissionRate: `${rate.toFixed(2)}%`,
        commission: commission.toFixed(2),
        taxRate: '6%',
        taxAmount: taxAmount.toFixed(2),
        finalAmount: finalAmount.toFixed(2),
        breakdown: [
          { item: '合作基础金额', amount: baseAmount.toFixed(2) },
          { item: `平台佣金 (${rate.toFixed(2)}%)`, amount: `-${commission.toFixed(2)}` },
          { item: '代扣税费 (6%)', amount: `-${taxAmount.toFixed(2)}` },
          { item: '达人实得金额', amount: finalAmount.toFixed(2), highlight: true },
        ],
      };

      success(res, calculation, '费用计算完成');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR, UserRole.FINANCE),
  [
    body('invitationId').isInt().withMessage('邀约ID不能为空'),
    handleValidation,
  ],
  async (req, res, next) => {
    try {
      const { invitationId, commissionRate, remark } = req.body;

      const invitation = await prisma.invitation.findUnique({
        where: { id: invitationId },
        include: { talent: true },
      });
      if (!invitation) throw new ApiError(404, 6010, '邀约不存在');
      if (invitation.status !== InvitationStatus.COMPLETED) {
        throw new ApiError(400, 6011, '仅已完成的邀约可创建结算单');
      }

      const existSettlement = await prisma.settlement.findFirst({ where: { invitationId } });
      if (existSettlement) throw new ApiError(400, 6012, '该邀约已存在结算单');

      const baseAmount = Number(invitation.budget);
      const rate = commissionRate !== undefined ? Number(commissionRate) : Number(invitation.talent.taxRate || 10);
      const commission = baseAmount * (rate / 100);
      const taxAmount = baseAmount * 0.06;
      const finalAmount = baseAmount - commission - taxAmount;

      const settlement = await prisma.settlement.create({
        data: {
          invitationId,
          talentId: invitation.talentId,
          baseAmount: new Prisma.Decimal(baseAmount.toFixed(2)),
          commissionRate: new Prisma.Decimal(rate.toFixed(4)),
          commission: new Prisma.Decimal(commission.toFixed(2)),
          taxAmount: new Prisma.Decimal(taxAmount.toFixed(2)),
          finalAmount: new Prisma.Decimal(finalAmount.toFixed(2)),
          remark,
          status: SettlementStatus.PENDING,
        },
        include: { invitation: true, talent: true },
      });

      success(res, settlement, '结算单创建成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 发票核对 ============

router.post(
  '/:id/invoice',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    param('id').isInt(),
    body('invoiceNo').notEmpty().withMessage('发票号不能为空'),
    handleValidation,
  ],
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { invoiceNo, invoiceUrl } = req.body;

      const settlement = await prisma.settlement.findUnique({ where: { id } });
      if (!settlement) throw new ApiError(404, 404, '结算单不存在');
      if (settlement.status !== SettlementStatus.PENDING) {
        throw new ApiError(400, 6020, '仅待处理状态可登记发票');
      }

      const updated = await prisma.settlement.update({
        where: { id },
        data: {
          invoiceNo,
          invoiceUrl,
          invoiceReceived: true,
          invoiceReceivedAt: new Date(),
          status: SettlementStatus.INVOICE_RECEIVED,
        },
      });

      success(res, updated, '发票已登记');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 财务审批 ============

router.post(
  '/:id/approve',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    param('id').isInt(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const { remark } = req.body;

      const settlement = await prisma.settlement.findUnique({ where: { id } });
      if (!settlement) throw new ApiError(404, 404, '结算单不存在');

      const allowed = [SettlementStatus.PENDING, SettlementStatus.INVOICE_RECEIVED];
      if (!allowed.includes(settlement.status)) {
        throw new ApiError(400, 6030, '当前状态不可审批');
      }
      if (!settlement.invoiceReceived) {
        throw new ApiError(400, 6031, '请先登记发票信息');
      }

      const updated = await prisma.settlement.update({
        where: { id },
        data: {
          status: SettlementStatus.APPROVED,
          approverId: req.user!.id,
          remark: remark || settlement.remark,
        },
      });

      success(res, updated, '结算已审批通过');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 标记付款 ============

router.post(
  '/:id/pay',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    param('id').isInt(),
    body('paymentVoucher').notEmpty().withMessage('请上传付款凭证'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const { paymentVoucher, remark } = req.body;

      const settlement = await prisma.settlement.findUnique({ where: { id } });
      if (!settlement) throw new ApiError(404, 404, '结算单不存在');
      if (settlement.status !== SettlementStatus.APPROVED) {
        throw new ApiError(400, 6040, '仅审批通过状态可标记付款');
      }

      const updated = await prisma.settlement.update({
        where: { id },
        data: {
          status: SettlementStatus.PAID,
          paidAt: new Date(),
          paymentVoucher,
          remark: remark || settlement.remark,
        },
      });

      success(res, updated, '付款已确认');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 异议处理 ============

router.post(
  '/:id/dispute',
  [
    param('id').isInt(),
    body('remark').notEmpty().withMessage('请填写异议原因'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const { remark } = req.body;

      const settlement = await prisma.settlement.findUnique({
        where: { id },
        include: { talent: true },
      });
      if (!settlement) throw new ApiError(404, 404, '结算单不存在');

      if (req.user!.role === UserRole.TALENT) {
        if (settlement.talent.userId !== req.user!.id) {
          throw new ApiError(403, 403, '无权限操作');
        }
      } else if (![UserRole.ADMIN, UserRole.FINANCE].includes(req.user!.role)) {
        throw new ApiError(403, 403, '无权限操作');
      }

      if (settlement.status === SettlementStatus.PAID) {
        throw new ApiError(400, 6050, '已付款状态不可提出异议');
      }

      const updated = await prisma.settlement.update({
        where: { id },
        data: {
          status: SettlementStatus.DISPUTED,
          remark: `${settlement.remark ? settlement.remark + ' | ' : ''}异议: ${remark}`,
        },
      });

      success(res, updated, '异议已记录');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 财务统计 ============

router.get(
  '/stats/summary',
  requireRoles(UserRole.ADMIN, UserRole.FINANCE),
  [
    query('startDate').optional().isString(),
    query('endDate').optional().isString(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { startDate, endDate } = _req.query;
      const where: any = {};
      if (startDate) where.createdAt = { ...where.createdAt, gte: new Date(startDate as string) };
      if (endDate) {
        const eDate = new Date(endDate as string);
        eDate.setHours(23, 59, 59, 999);
        where.createdAt = { ...where.createdAt, lte: eDate };
      }

      const settlements = await prisma.settlement.findMany({ where });
      const byStatus: Record<string, { count: number; amount: string }> = {};

      Object.values(SettlementStatus).forEach((s) => {
        byStatus[s] = { count: 0, amount: '0.00' };
      });

      let totalBase = 0, totalCommission = 0, totalTax = 0, totalFinal = 0;

      settlements.forEach((s) => {
        byStatus[s.status].count += 1;
        byStatus[s.status].amount = (
          Number(byStatus[s.status].amount) + Number(s.finalAmount)
        ).toFixed(2);
        totalBase += Number(s.baseAmount);
        totalCommission += Number(s.commission);
        totalTax += Number(s.taxAmount);
        totalFinal += Number(s.finalAmount);
      });

      success(res, {
        totalCount: settlements.length,
        totalBaseAmount: totalBase.toFixed(2),
        totalCommission: totalCommission.toFixed(2),
        totalTax: totalTax.toFixed(2),
        totalPayout: totalFinal.toFixed(2),
        byStatus,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
