import { Router } from 'express';
import { body, query } from 'express-validator';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { success, ApiError } from '../utils/response';
import { handleValidation } from '../middleware/error';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

router.post(
  '/login',
  [
    body('username').notEmpty().withMessage('用户名不能为空'),
    body('password').notEmpty().withMessage('密码不能为空'),
    handleValidation,
  ],
  async (req, res, next) => {
    try {
      const { username, password } = req.body;
      const user = await prisma.user.findUnique({ where: { username } });

      if (!user) {
        throw new ApiError(400, 1001, '用户名或密码错误');
      }

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        throw new ApiError(400, 1001, '用户名或密码错误');
      }

      const token = jwt.sign(
        { userId: user.id, username: user.username, role: user.role },
        process.env.JWT_SECRET as string,
        { expiresIn: process.env.JWT_EXPIRES_IN }
      );

      success(res, {
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          realName: user.realName,
          email: user.email,
        },
      }, '登录成功');
    } catch (err) {
      next(err);
    }
  }
);

router.get('/me', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        username: true,
        role: true,
        realName: true,
        email: true,
        phone: true,
        avatarUrl: true,
        createdAt: true,
      },
    });
    success(res, user);
  } catch (err) {
    next(err);
  }
});

export default router;
