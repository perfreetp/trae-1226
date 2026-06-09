import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const UserRole = { ADMIN: 'ADMIN', OPERATOR: 'OPERATOR', FINANCE: 'FINANCE', TALENT: 'TALENT', BRAND: 'BRAND' };
const TalentStatus = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', BLACKLISTED: 'BLACKLISTED' };
const RiskLevel = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 开始初始化种子数据...');

  const hashedPassword = await bcrypt.hash('123456', 10);

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password: hashedPassword,
      role: UserRole.ADMIN,
      realName: '系统管理员',
      email: 'admin@example.com',
      phone: '13800000001',
    },
  });
  console.log('✅ 管理员账号: admin / 123456');

  const operator = await prisma.user.upsert({
    where: { username: 'operator' },
    update: {},
    create: {
      username: 'operator',
      password: hashedPassword,
      role: UserRole.OPERATOR,
      realName: '运营专员',
      email: 'operator@example.com',
      phone: '13800000002',
    },
  });
  console.log('✅ 运营账号: operator / 123456');

  const finance = await prisma.user.upsert({
    where: { username: 'finance' },
    update: {},
    create: {
      username: 'finance',
      password: hashedPassword,
      role: UserRole.FINANCE,
      realName: '财务专员',
      email: 'finance@example.com',
      phone: '13800000003',
    },
  });
  console.log('✅ 财务账号: finance / 123456');

  const talentUser1 = await prisma.user.upsert({
    where: { username: 'talent001' },
    update: {},
    create: {
      username: 'talent001',
      password: hashedPassword,
      role: UserRole.TALENT,
      realName: '李美丽',
      email: 'talent001@example.com',
      phone: '13900000001',
    },
  });

  const talent1 = await prisma.talent.upsert({
    where: { xhsId: 'xhs_beauty_001' },
    update: {},
    create: {
      userId: talentUser1.id,
      xhsId: 'xhs_beauty_001',
      nickname: '美美丽丽酱',
      bio: '美妆博主 | 护肤测评 | 好物分享',
      avatarUrl: 'https://via.placeholder.com/150',
      followerCount: 158000,
      likeCount: 2500000,
      collectCount: 890000,
      status: TalentStatus.APPROVED,
      realName: '李美丽',
      idCardNo: '110101199501011234',
      phone: '13900000001',
      wechat: 'meili_wechat',
      email: 'talent001@example.com',
      bankAccount: '6222021234567890123',
      bankName: '中国工商银行',
      taxRate: 10,
    },
  });
  console.log('✅ 达人账号: talent001 / 123456');

  const talentUser2 = await prisma.user.upsert({
    where: { username: 'talent002' },
    update: {},
    create: {
      username: 'talent002',
      password: hashedPassword,
      role: UserRole.TALENT,
      realName: '王潮潮',
      email: 'talent002@example.com',
      phone: '13900000002',
    },
  });

  const talent2 = await prisma.talent.upsert({
    where: { xhsId: 'xhs_fashion_002' },
    update: {},
    create: {
      userId: talentUser2.id,
      xhsId: 'xhs_fashion_002',
      nickname: '潮流王同学',
      bio: '穿搭分享 | 男生时尚 | 生活方式',
      avatarUrl: 'https://via.placeholder.com/150',
      followerCount: 86000,
      likeCount: 1200000,
      collectCount: 420000,
      status: TalentStatus.APPROVED,
      realName: '王潮潮',
      idCardNo: '310101199602025678',
      phone: '13900000002',
      wechat: 'chaochao_wechat',
      email: 'talent002@example.com',
      bankAccount: '6222029876543210987',
      bankName: '中国建设银行',
      taxRate: 12,
    },
  });
  console.log('✅ 达人账号: talent002 / 123456');

  const tagsData = [
    { name: '美妆', category: '内容领域' },
    { name: '护肤', category: '内容领域' },
    { name: '穿搭', category: '内容领域' },
    { name: '美食', category: '内容领域' },
    { name: '旅行', category: '内容领域' },
    { name: '数码', category: '内容领域' },
    { name: '母婴', category: '内容领域' },
    { name: '家居', category: '内容领域' },
    { name: '健身', category: '内容领域' },
    { name: '头部达人', category: '粉丝量级' },
    { name: '腰部达人', category: '粉丝量级' },
    { name: '初级达人', category: '粉丝量级' },
    { name: '高互动', category: '数据表现' },
    { name: '转化好', category: '数据表现' },
    { name: '性价比高', category: '合作属性' },
  ];

  const tags = await Promise.all(
    tagsData.map((t) =>
      prisma.tag.upsert({
        where: { name: t.name },
        update: {},
        create: t,
      })
    )
  );
  console.log(`✅ 初始化 ${tags.length} 个达人标签`);

  await prisma.talentTag.deleteMany({});
  await prisma.talentTag.createMany({
    data: [
      { talentId: talent1.id, tagId: tags[0].id },
      { talentId: talent1.id, tagId: tags[1].id },
      { talentId: talent1.id, tagId: tags[9].id },
      { talentId: talent1.id, tagId: tags[12].id },
      { talentId: talent2.id, tagId: tags[2].id },
      { talentId: talent2.id, tagId: tags[10].id },
      { talentId: talent2.id, tagId: tags[14].id },
    ],
  });
  console.log('✅ 关联达人标签');

  await prisma.quotation.deleteMany({});
  await prisma.quotation.createMany({
    data: [
      {
        talentId: talent1.id,
        contentType: '图文笔记',
        price: 8000,
        platformFee: 1600,
        finalPrice: 9600,
        note: '常规合作报价',
        isActive: true,
      },
      {
        talentId: talent1.id,
        contentType: '视频笔记',
        price: 15000,
        platformFee: 3000,
        finalPrice: 18000,
        note: '60s内短视频',
        isActive: true,
      },
      {
        talentId: talent2.id,
        contentType: '图文笔记',
        price: 4500,
        platformFee: 900,
        finalPrice: 5400,
        note: '含3张精修图',
        isActive: true,
      },
      {
        talentId: talent2.id,
        contentType: '视频笔记',
        price: 8000,
        platformFee: 1600,
        finalPrice: 9600,
        isActive: true,
      },
    ],
  });
  console.log('✅ 初始化达人报价');

  const brandsData = [
    {
      name: '雅诗兰黛',
      logoUrl: 'https://via.placeholder.com/100',
      industry: '美妆护肤',
      contactName: '张经理',
      contactPhone: '13600000001',
      contactEmail: 'marketing@esteelauder.com',
    },
    {
      name: '优衣库',
      logoUrl: 'https://via.placeholder.com/100',
      industry: '服饰品牌',
      contactName: '李总监',
      contactPhone: '13600000002',
      contactEmail: 'brand@uniqlo.com',
    },
    {
      name: '小米',
      logoUrl: 'https://via.placeholder.com/100',
      industry: '数码电子',
      contactName: '王总',
      contactPhone: '13600000003',
      contactEmail: 'bd@xiaomi.com',
    },
    {
      name: '三只松鼠',
      logoUrl: 'https://via.placeholder.com/100',
      industry: '食品零食',
      contactName: '陈经理',
      contactPhone: '13600000004',
      contactEmail: 'brand@3songshu.com',
    },
  ];

  const brands = await Promise.all(
    brandsData.map((b) =>
      prisma.brand.upsert({
        where: { name: b.name },
        update: {},
        create: b,
      })
    )
  );
  console.log(`✅ 初始化 ${brands.length} 个品牌`);

  const prohibitedWords = [
    { word: '最好', severity: RiskLevel.MEDIUM, category: '绝对化用词' },
    { word: '第一', severity: RiskLevel.MEDIUM, category: '绝对化用词' },
    { word: '国家级', severity: RiskLevel.HIGH, category: '绝对化用词' },
    { word: '最高级', severity: RiskLevel.MEDIUM, category: '绝对化用词' },
    { word: '特效药', severity: RiskLevel.HIGH, category: '医疗用语' },
    { word: '包治百病', severity: RiskLevel.CRITICAL, category: '医疗用语' },
    { word: '100%有效', severity: RiskLevel.HIGH, category: '虚假宣传' },
    { word: '永久', severity: RiskLevel.MEDIUM, category: '绝对化用词' },
    { word: '全网最低', severity: RiskLevel.MEDIUM, category: '价格宣传' },
    { word: '秒杀一切', severity: RiskLevel.HIGH, category: '虚假宣传' },
  ];

  await Promise.all(
    prohibitedWords.map((w) =>
      prisma.prohibitedWord.upsert({
        where: { word: w.word },
        update: {},
        create: w,
      })
    )
  );
  console.log(`✅ 初始化 ${prohibitedWords.length} 个违规词`);

  const templates = [
    {
      code: 'INVITATION_NEW',
      name: '新邀约通知',
      type: 'TODO' as any,
      channel: 'IN_APP' as any,
      title: '您有新的合作邀约',
      content: '品牌「{{brand}}」向您发出合作邀请：{{title}}，请及时确认档期。',
    },
    {
      code: 'CONTENT_REVIEW_RESULT',
      name: '内容审核结果',
      type: 'RESULT' as any,
      channel: 'IN_APP' as any,
      title: '内容审核结果通知',
      content: '您提交的内容审核{{status}}，请登录查看详情。',
    },
    {
      code: 'PAYMENT_COMPLETED',
      name: '付款完成通知',
      type: 'RESULT' as any,
      channel: 'EMAIL' as any,
      title: '合作款项已支付',
      content: '您好，合作款项 ¥{{amount}} 已成功支付，请注意查收。',
    },
  ];

  await Promise.all(
    templates.map((t) =>
      prisma.notificationTemplate.upsert({
        where: { code: t.code },
        update: {},
        create: t,
      })
    )
  );
  console.log(`✅ 初始化 ${templates.length} 个通知模板`);

  console.log('\n🎉 种子数据初始化完成!');
  console.log('\n📋 测试账号汇总:');
  console.log('  管理员  -> admin / 123456');
  console.log('  运营    -> operator / 123456');
  console.log('  财务    -> finance / 123456');
  console.log('  达人001 -> talent001 / 123456');
  console.log('  达人002 -> talent002 / 123456');
}

main()
  .catch((e) => {
    console.error('❌ 初始化失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
