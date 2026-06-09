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
