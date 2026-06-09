import { Router } from 'express';
import { body, query, param } from 'express-validator';
import nodemailer from 'nodemailer';
import prisma from '../lib/prisma';
import { success, successWithPagination, ApiError } from '../utils/response';
import { handleValidation, parsePagination } from '../middleware/error';
import { authMiddleware, AuthRequest, requireRoles } from '../middleware/auth';
import { NotificationType, NotificationChannel, UserRole } from '../constants/enums';

const router = Router();
router.use(authMiddleware);

// ============ 邮件发送器 ============

const createMailTransporter = () => {
  if (!process.env.SMTP_HOST || process.env.SMTP_HOST === 'smtp.example.com') {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const sendEmailNotification = async (to: string, title: string, content: string): Promise<boolean> => {
  const transporter = createMailTransporter();
  if (!transporter) return false;

  try {
    await transporter.sendMail({
      from: `"品牌合作平台" <${process.env.SMTP_USER}>`,
      to,
      subject: title,
      html: `<div style="padding:20px;font-family:Arial,sans-serif;"><h3>${title}</h3><p>${content}</p></div>`,
    });
    return true;
  } catch (e) {
    console.error('[Email] 发送失败:', e);
    return false;
  }
};

// ============ 通知模板管理 ============

router.get('/templates', requireRoles(UserRole.ADMIN), async (_req, res, next) => {
  try {
    const templates = await prisma.notificationTemplate.findMany({ orderBy: { createdAt: 'desc' } });
    success(res, templates);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/templates',
  requireRoles(UserRole.ADMIN),
  [
    body('code').notEmpty(),
    body('name').notEmpty(),
    body('title').notEmpty(),
    body('content').notEmpty(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { code, type, channel, ...data } = _req.body;
      const exist = await prisma.notificationTemplate.findUnique({ where: { code } });
      if (exist) throw new ApiError(400, 8001, '模板编码已存在');

      const tpl = await prisma.notificationTemplate.create({
        data: {
          code,
          type: (type || 'TODO') as NotificationType,
          channel: (channel || 'IN_APP') as NotificationChannel,
          ...data,
        },
      });
      success(res, tpl, '模板创建成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 发送通知 ============

const renderTemplate = (content: string, variables: Record<string, string>): string => {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '');
};

const createNotification = async (
  userId: number,
  type: NotificationType,
  channel: NotificationChannel,
  title: string,
  content: string,
  relatedType?: string,
  relatedId?: number,
  variables: Record<string, string> = {}
) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const renderedTitle = renderTemplate(title, variables);
  const renderedContent = renderTemplate(content, variables);

  let sendStatus = 'PENDING';
  let failReason: string | null = null;
  let sentAt: Date | null = null;

  if (channel === NotificationChannel.EMAIL && user.email) {
    const ok = await sendEmailNotification(user.email, renderedTitle, renderedContent);
    if (ok) {
      sendStatus = 'SENT';
      sentAt = new Date();
    } else {
      sendStatus = 'FAILED';
      failReason = '邮件服务未配置或发送失败';
    }
  } else {
    sendStatus = 'SENT';
    sentAt = new Date();
  }

  return prisma.notification.create({
    data: {
      userId,
      type,
      channel,
      title: renderedTitle,
      content: renderedContent,
      relatedType,
      relatedId,
      sendStatus,
      failReason,
      sentAt,
    },
  });
};

router.post(
  '/send',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('userIds').isArray({ min: 1 }).withMessage('用户ID列表不能为空'),
    body('type').isIn(['TODO', 'RESULT', 'REMINDER', 'WARNING']),
    body('channel').isIn(['IN_APP', 'EMAIL', 'SMS', 'WECHAT']),
    body('title').notEmpty(),
    body('content').notEmpty(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { userIds, type, channel, title, content, relatedType, relatedId, variables } = _req.body;

      const results = await Promise.all(
        userIds.map((uid: number) =>
          createNotification(
            uid,
            type as NotificationType,
            channel as NotificationChannel,
            title,
            content,
            relatedType,
            relatedId,
            variables || {}
          )
        )
      );

      const successCount = results.filter((r) => r?.sendStatus === 'SENT').length;
      const failCount = results.filter((r) => r?.sendStatus === 'FAILED').length;

      success(
        res,
        { total: userIds.length, success: successCount, failed: failCount, items: results },
        `通知发送完成: 成功${successCount}条, 失败${failCount}条`
      );
    } catch (err) {
      next(err);
    }
  }
);

// ============ 业务场景快捷通知 ============

router.post(
  '/send/scene',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('scene').isIn([
      'INVITATION_PUBLISHED',
      'INVITATION_ACCEPTED',
      'INVITATION_REJECTED',
      'CONTENT_SUBMITTED',
      'CONTENT_REVIEWED',
      'SETTLEMENT_APPROVED',
      'SETTLEMENT_PAID',
      'RISK_ALERT',
    ]),
    body('invitationId').optional().isInt(),
    body('contentId').optional().isInt(),
    body('settlementId').optional().isInt(),
    handleValidation,
  ],
  async (_req: AuthRequest, res, next) => {
    try {
      const { scene, invitationId, contentId, settlementId } = _req.body;
      const tasks: Promise<any>[] = [];

      const findOperators = prisma.user.findMany({
        where: { role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } },
        select: { id: true, email: true },
      });
      const findFinances = prisma.user.findMany({
        where: { role: { in: [UserRole.ADMIN, UserRole.FINANCE] } },
        select: { id: true, email: true },
      });

      switch (scene) {
        case 'INVITATION_PUBLISHED': {
          const invitation = await prisma.invitation.findUnique({
            where: { id: invitationId },
            include: { talent: { include: { user: true } }, brand: true },
          });
          if (!invitation?.talent.user) break;

          tasks.push(
            createNotification(
              invitation.talent.user.id,
              NotificationType.TODO,
              NotificationChannel.IN_APP,
              '您有新的合作邀约',
              `品牌「{{brand}}」向您发出合作邀请：{{title}}，请及时确认档期。`,
              'INVITATION',
              invitation.id,
              { brand: invitation.brand.name, title: invitation.title }
            )
          );
          tasks.push(
            createNotification(
              invitation.talent.user.id,
              NotificationType.REMINDER,
              NotificationChannel.EMAIL,
              '新合作邀约提醒',
              `品牌「{{brand}}」合作邀请：{{title}}，请登录小程序查看详情。`,
              'INVITATION',
              invitation.id,
              { brand: invitation.brand.name, title: invitation.title }
            )
          );
          break;
        }

        case 'INVITATION_ACCEPTED': {
          const invitation = await prisma.invitation.findUnique({
            where: { id: invitationId },
            include: { talent: true, brand: true },
          });
          if (!invitation) break;

          const operators = await findOperators;
          operators.forEach((op) => {
            tasks.push(
              createNotification(
                op.id,
                NotificationType.RESULT,
                NotificationChannel.IN_APP,
                '达人已接受邀约',
                `达人「{{talent}}」接受了品牌「{{brand}}」的合作邀约。`,
                'INVITATION',
                invitation.id,
                { talent: invitation.talent.nickname, brand: invitation.brand.name }
              )
            );
          });
          break;
        }

        case 'INVITATION_REJECTED': {
          const invitation = await prisma.invitation.findUnique({
            where: { id: invitationId },
            include: { talent: true, brand: true },
          });
          if (!invitation) break;

          const operators = await findOperators;
          operators.forEach((op) => {
            tasks.push(
              createNotification(
                op.id,
                NotificationType.WARNING,
                NotificationChannel.IN_APP,
                '达人拒绝了邀约',
                `达人「{{talent}}」拒绝了品牌「{{brand}}」的合作邀约。`,
                'INVITATION',
                invitation.id,
                { talent: invitation.talent.nickname, brand: invitation.brand.name }
              )
            );
          });
          break;
        }

        case 'CONTENT_SUBMITTED': {
          const content = await prisma.content.findUnique({
            where: { id: contentId },
            include: { talent: true, invitation: { include: { brand: true } } },
          });
          if (!content) break;

          const operators = await findOperators;
          operators.forEach((op) => {
            tasks.push(
              createNotification(
                op.id,
                NotificationType.TODO,
                NotificationChannel.IN_APP,
                '新内容待审核',
                `达人「{{talent}}」提交了品牌「{{brand}}」的合作内容，请及时审核。`,
                'CONTENT',
                content.id,
                { talent: content.talent.nickname, brand: content.invitation.brand.name }
              )
            );
          });
          break;
        }

        case 'CONTENT_REVIEWED': {
          const content = await prisma.content.findUnique({
            where: { id: contentId },
            include: { talent: { include: { user: true } }, invitation: { include: { brand: true } } },
          });
          if (!content?.talent.user) break;

          const statusText = {
            APPROVED: '已通过',
            REJECTED: '被驳回',
            NEEDS_REVISION: '需修改',
          }[content.reviewStatus] || '已审核';

          tasks.push(
            createNotification(
              content.talent.user.id,
              NotificationType.RESULT,
              NotificationChannel.IN_APP,
              '内容审核结果',
              `您提交的品牌「{{brand}}」合作内容{{status}}。{{remark}}`,
              'CONTENT',
              content.id,
              {
                brand: content.invitation.brand.name,
                status: statusText,
                remark: content.reviewRemark ? `备注：${content.reviewRemark}` : '',
              }
            )
          );
          break;
        }

        case 'SETTLEMENT_APPROVED': {
          const settlement = await prisma.settlement.findUnique({
            where: { id: settlementId },
            include: { talent: { include: { user: true } }, invitation: { include: { brand: true } } },
          });
          if (!settlement?.talent.user) break;

          tasks.push(
            createNotification(
              settlement.talent.user.id,
              NotificationType.RESULT,
              NotificationChannel.IN_APP,
              '结算单已审批通过',
              `品牌「{{brand}}」合作结算单已审批，金额 ¥{{amount}}，等待付款。`,
              'SETTLEMENT',
              settlement.id,
              { brand: settlement.invitation.brand.name, amount: settlement.finalAmount.toString() }
            )
          );

          const finances = await findFinances;
          finances.forEach((f) => {
            tasks.push(
              createNotification(
                f.id,
                NotificationType.TODO,
                NotificationChannel.IN_APP,
                '待付款提醒',
                `达人「{{talent}}」结算单已审批，请完成付款：¥{{amount}}。`,
                'SETTLEMENT',
                settlement.id,
                { talent: settlement.talent.nickname, amount: settlement.finalAmount.toString() }
              )
            );
          });
          break;
        }

        case 'SETTLEMENT_PAID': {
          const settlement = await prisma.settlement.findUnique({
            where: { id: settlementId },
            include: { talent: { include: { user: true } }, invitation: { include: { brand: true } } },
          });
          if (!settlement?.talent.user) break;

          tasks.push(
            createNotification(
              settlement.talent.user.id,
              NotificationType.RESULT,
              NotificationChannel.IN_APP,
              '付款已完成',
              `品牌「{{brand}}」合作款项 ¥{{amount}} 已支付，请查收。`,
              'SETTLEMENT',
              settlement.id,
              { brand: settlement.invitation.brand.name, amount: settlement.finalAmount.toString() }
            )
          );
          tasks.push(
            createNotification(
              settlement.talent.user.id,
              NotificationType.RESULT,
              NotificationChannel.EMAIL,
              '合作款项支付通知',
              `您好，品牌「{{brand}}」合作款项 ¥{{amount}} 已成功支付至您的银行账户，请注意查收。`,
              'SETTLEMENT',
              settlement.id,
              { brand: settlement.invitation.brand.name, amount: settlement.finalAmount.toString() }
            )
          );
          break;
        }

        case 'RISK_ALERT': {
          const operators = await findOperators;
          operators.forEach((op) => {
            tasks.push(
              createNotification(
                op.id,
                NotificationType.WARNING,
                NotificationChannel.IN_APP,
                '风控告警',
                `系统检测到新的风险事件，请前往风控中心查看处理。`,
                'RISK',
                undefined,
                {}
              )
            );
          });
          break;
        }
      }

      const results = await Promise.all(tasks);
      success(res, { count: results.length, items: results }, '场景通知发送完成');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 当前用户通知 ============

router.get(
  '/mine',
  [
    query('type').optional().isIn(['TODO', 'RESULT', 'REMINDER', 'WARNING']),
    query('isRead').optional().isBoolean(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { type, isRead } = req.query;

      const where: any = { userId: req.user!.id };
      if (type) where.type = type as NotificationType;
      if (isRead !== undefined) where.isRead = isRead === 'true';

      const [list, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId: req.user!.id, isRead: false } }),
      ]);

      successWithPagination(res, { list, unreadCount }, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/mine/unread-count', async (req: AuthRequest, res, next) => {
  try {
    const [total, byType] = await Promise.all([
      prisma.notification.count({ where: { userId: req.user!.id, isRead: false } }),
      prisma.notification.groupBy({
        by: ['type'],
        _count: { type: true },
        where: { userId: req.user!.id, isRead: false },
      }),
    ]);

    const typeMap: Record<string, number> = {};
    byType.forEach((item) => (typeMap[item.type] = item._count.type));

    success(res, { total, byType: typeMap });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/read',
  [param('id').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const notification = await prisma.notification.findUnique({ where: { id } });
      if (!notification) throw new ApiError(404, 404, '通知不存在');
      if (notification.userId !== req.user!.id) throw new ApiError(403, 403, '无权限操作');

      const updated = await prisma.notification.update({
        where: { id },
        data: { isRead: true, readAt: new Date() },
      });
      success(res, updated, '已标记已读');
    } catch (err) {
      next(err);
    }
  }
);

router.post('/read-all', async (req: AuthRequest, res, next) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user!.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    success(res, { count: result.count }, `已标记 ${result.count} 条为已读`);
  } catch (err) {
    next(err);
  }
});

// ============ 管理员：查询所有通知 ============

router.get(
  '/all',
  requireRoles(UserRole.ADMIN),
  [
    query('userId').optional().isInt(),
    query('channel').optional().isIn(['IN_APP', 'EMAIL', 'SMS', 'WECHAT']),
    query('sendStatus').optional().isString(),
    handleValidation,
  ],
  async (_req, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(_req);
      const { userId, channel, sendStatus } = _req.query;

      const where: any = {};
      if (userId) where.userId = Number(userId);
      if (channel) where.channel = channel as NotificationChannel;
      if (sendStatus) where.sendStatus = sendStatus as string;

      const [list, total] = await Promise.all([
        prisma.notification.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { id: true, username: true, role: true, email: true } } },
        }),
        prisma.notification.count({ where }),
      ]);

      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
