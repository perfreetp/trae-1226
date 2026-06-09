import { Router } from 'express';
import { body, query, param } from 'express-validator';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { success, successWithPagination, ApiError } from '../utils/response';
import { handleValidation, parsePagination } from '../middleware/error';
import { authMiddleware, AuthRequest, requireRoles } from '../middleware/auth';
import { TalentStatus, UserRole } from '../constants/enums';

const router = Router();
router.use(authMiddleware);

// ============ 静态路由：必须放在 /:id 动态路由之前 ============

router.get(
  '/',
  [
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'BLACKLISTED']),
    query('keyword').optional().isString(),
    query('tagIds').optional().isString(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { status, keyword, tagIds } = req.query;

      const where: any = {};
      if (status) where.status = status as TalentStatus;
      if (keyword) {
        where.OR = [
          { nickname: { contains: keyword as string } },
          { xhsId: { contains: keyword as string } },
          { realName: { contains: keyword as string } },
        ];
      }
      if (tagIds) {
        where.tags = {
          some: { tagId: { in: (tagIds as string).split(',').map(Number) } },
        };
      }

      const [list, total] = await Promise.all([
        prisma.talent.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: { tags: { include: { tag: true } }, quotations: true },
        }),
        prisma.talent.count({ where }),
      ]);

      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

// ============ 标签管理 ============

router.get('/tags/list', async (_req, res, next) => {
  try {
    const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
    success(res, tags);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/tags',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [body('name').notEmpty(), handleValidation],
  async (req, res, next) => {
    try {
      const { name, category } = req.body;
      const exist = await prisma.tag.findUnique({ where: { name } });
      if (exist) throw new ApiError(400, 2010, '标签已存在');

      const tag = await prisma.tag.create({ data: { name, category } });
      success(res, tag, '标签创建成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 黑名单 ============

router.get(
  '/blacklist/list',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  async (req: AuthRequest, res, next) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const [list, total] = await Promise.all([
        prisma.blacklist.findMany({
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
          include: { talent: true },
        }),
        prisma.blacklist.count(),
      ]);
      successWithPagination(res, list, total, page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

// ============ 报价（独立资源，不依赖达人id） ============

router.put(
  '/quotations/:qid',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR, UserRole.TALENT),
  [param('qid').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const qid = Number(req.params.qid);
      const quotation = await prisma.quotation.findUnique({
        where: { id: qid },
        include: { talent: true },
      });
      if (!quotation) throw new ApiError(404, 404, '报价不存在');

      if (req.user!.role === UserRole.TALENT && quotation.talent.userId !== req.user!.id) {
        throw new ApiError(403, 403, '无权限操作');
      }

      const { price, platformFee, isActive, ...rest } = req.body;
      const finalPrice =
        price && platformFee
          ? (Number(price) + Number(platformFee)).toString()
          : price
          ? price
          : undefined;

      const updated = await prisma.quotation.update({
        where: { id: qid },
        data: { price, platformFee, finalPrice, isActive, ...rest },
      });
      success(res, updated, '报价更新成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 新建达人 ============

router.post(
  '/',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    body('xhsId').notEmpty().withMessage('小红书ID不能为空'),
    body('nickname').notEmpty().withMessage('昵称不能为空'),
    body('username').notEmpty().withMessage('登录账号不能为空'),
    body('password').notEmpty().withMessage('密码不能为空'),
    body('followerCount').optional().isInt(),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const { username, password, xhsId, nickname, ...talentData } = req.body;

      const [existUser, existXhs] = await Promise.all([
        prisma.user.findUnique({ where: { username } }),
        prisma.talent.findUnique({ where: { xhsId } }),
      ]);
      if (existUser) throw new ApiError(400, 2001, '登录账号已存在');
      if (existXhs) throw new ApiError(400, 2002, '小红书ID已注册');

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: {
          username,
          password: hashedPassword,
          role: UserRole.TALENT,
          email: talentData.email,
          phone: talentData.phone,
          realName: talentData.realName,
        },
      });

      const talent = await prisma.talent.create({
        data: {
          userId: user.id,
          xhsId,
          nickname,
          ...talentData,
        },
        include: { user: { select: { username: true } } },
      });

      success(res, talent, '达人建档成功');
    } catch (err) {
      next(err);
    }
  }
);

// ============ 动态路由 /:id （及其子路由） ============

router.get('/:id', [param('id').isInt(), handleValidation], async (req, res, next) => {
  try {
    const talent = await prisma.talent.findUnique({
      where: { id: Number(req.params.id) },
      include: {
        tags: { include: { tag: true } },
        quotations: true,
        blacklist: true,
        user: { select: { username: true, email: true, phone: true } },
      },
    });
    if (!talent) throw new ApiError(404, 404, '达人不存在');
    success(res, talent);
  } catch (err) {
    next(err);
  }
});

router.put(
  '/:id',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR, UserRole.TALENT),
  [param('id').isInt(), handleValidation],
  async (req: AuthRequest, res, next) => {
    try {
      const id = Number(req.params.id);
      const talent = await prisma.talent.findUnique({ where: { id } });
      if (!talent) throw new ApiError(404, 404, '达人不存在');

      if (req.user!.role === UserRole.TALENT && talent.userId !== req.user!.id) {
        throw new ApiError(403, 403, '无权限修改');
      }

      const { userId, status, ...updateData } = req.body;
      const updated = await prisma.talent.update({
        where: { id },
        data: updateData,
      });
      success(res, updated, '达人信息更新成功');
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id/status',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    param('id').isInt(),
    body('status').isIn(['PENDING', 'APPROVED', 'REJECTED', 'BLACKLISTED']),
    handleValidation,
  ],
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body;

      const talent = await prisma.talent.update({
        where: { id },
        data: { status: status as TalentStatus },
      });
      success(res, talent, '状态更新成功');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/tags',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [param('id').isInt(), body('tagIds').isArray().withMessage('tagIds必须为数组'), handleValidation],
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { tagIds } = req.body;

      await prisma.talentTag.deleteMany({ where: { talentId: id } });
      if (tagIds.length > 0) {
        await prisma.talentTag.createMany({
          data: tagIds.map((tagId: number) => ({ talentId: id, tagId })),
        });
      }

      const talent = await prisma.talent.findUnique({
        where: { id },
        include: { tags: { include: { tag: true } } },
      });
      success(res, talent, '标签设置成功');
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id/quotations', [param('id').isInt(), handleValidation], async (req, res, next) => {
  try {
    const list = await prisma.quotation.findMany({
      where: { talentId: Number(req.params.id) },
      orderBy: { createdAt: 'desc' },
    });
    success(res, list);
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/quotations',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR, UserRole.TALENT),
  [
    param('id').isInt(),
    body('contentType').notEmpty(),
    body('price').isDecimal().withMessage('价格必须为数字'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const talentId = Number(req.params.id);
      const { contentType, price, platformFee, note, effectiveAt, expireAt } = req.body;

      const talent = await prisma.talent.findUnique({ where: { id: talentId } });
      if (!talent) throw new ApiError(404, 404, '达人不存在');

      if (req.user!.role === UserRole.TALENT && talent.userId !== req.user!.id) {
        throw new ApiError(403, 403, '无权限操作');
      }

      const finalPrice = platformFee ? (Number(price) + Number(platformFee)).toString() : price;
      const quotation = await prisma.quotation.create({
        data: {
          talentId,
          contentType,
          price,
          platformFee: platformFee || null,
          finalPrice,
          note,
          effectiveAt: effectiveAt ? new Date(effectiveAt) : null,
          expireAt: expireAt ? new Date(expireAt) : null,
        },
      });
      success(res, quotation, '报价设置成功');
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/blacklist',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [
    param('id').isInt(),
    body('reason').notEmpty().withMessage('拉黑原因不能为空'),
    handleValidation,
  ],
  async (req: AuthRequest, res, next) => {
    try {
      const talentId = Number(req.params.id);
      const { reason, permanent, expireAt } = req.body;

      const exist = await prisma.blacklist.findUnique({ where: { talentId } });
      if (exist) throw new ApiError(400, 2020, '该达人已在黑名单中');

      const blacklist = await prisma.$transaction(async (tx) => {
        const bl = await tx.blacklist.create({
          data: {
            talentId,
            reason,
            permanent: permanent || false,
            expireAt: expireAt ? new Date(expireAt) : null,
            operatorId: req.user!.id,
          },
        });
        await tx.talent.update({ where: { id: talentId }, data: { status: TalentStatus.BLACKLISTED } });
        return bl;
      });

      success(res, blacklist, '已加入黑名单');
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id/blacklist',
  requireRoles(UserRole.ADMIN, UserRole.OPERATOR),
  [param('id').isInt(), handleValidation],
  async (_req, res, next) => {
    try {
      const talentId = Number(_req.params.id);
      await prisma.$transaction(async (tx) => {
        await tx.blacklist.delete({ where: { talentId } });
        await tx.talent.update({ where: { id: talentId }, data: { status: TalentStatus.APPROVED } });
      });
      success(res, null, '已从黑名单移除');
    } catch (err) {
      next(err);
    }
  }
);

export default router;
