export interface RouteMeta {
  path: string
  title: string
  description: string
  noindex?: boolean
  prerender: boolean
}

export const SITE_NAME = '趋势交易课程伴学'

/** 预渲染脚本与客户端导航共用；新增公开页必须登记，否则深链落到 SPA 壳。 */
export const ROUTES: RouteMeta[] = [
  {
    path: '/',
    title: '趋势交易课程伴学｜把课程与 AI 问答装进本地客户端',
    description: '在本地 dsh 客户端中检索课程知识、定位视频片段、逐步建立趋势交易体系。课程内容与账号服务由云端提供，推理与密钥留在本地。',
    prerender: true,
  },
  {
    path: '/system',
    title: '趋势交易体系｜理念、方法框架与风险控制',
    description: '趋势交易的核心假设、进出场框架、仓位与风险控制，以及新手最常见的误区。',
    prerender: true,
  },
  {
    path: '/features',
    title: '站点功能｜知识检索、片段定位、课程体系与伴学问答',
    description: '了解检索、引用定位、课程树与伴学问答各自解决什么问题，以及问答的边界。',
    prerender: true,
  },
  {
    path: '/guide',
    title: '使用向导｜安装 dsh 与学习插件',
    description: '从安装 deepseek harness 到登录授权，分步完成插件安装、Web UI 与常见问题排查。',
    prerender: true,
  },
  {
    path: '/downloads',
    title: '版本下载｜趋势交易课程伴学插件',
    description: '下载最新插件安装包，查看版本号、校验值与更新说明。',
    prerender: true,
  },
  {
    path: '/faq',
    title: '常见问题｜安装、授权与使用',
    description: '安装、登录授权、知识检索与视频播放的常见问题与排查步骤。',
    prerender: true,
  },
  {
    path: '/login',
    title: `登录｜${SITE_NAME}`,
    description: '登录趋势交易课程伴学账号，管理个人资料与已授权设备。',
    noindex: true,
    prerender: true,
  },
  {
    path: '/register',
    title: `注册｜${SITE_NAME}`,
    description: '注册趋势交易课程伴学账号，使用知识检索、课程体系与伴学问答。',
    noindex: true,
    prerender: true,
  },
  {
    path: '/account',
    title: `个人中心｜${SITE_NAME}`,
    description: '管理昵称、密码与已授权设备。',
    noindex: true,
    prerender: true,
  },
  {
    path: '/legal/privacy',
    title: `隐私说明｜${SITE_NAME}`,
    description: '说明账号、设备与使用数据如何被收集、存储与保护。',
    prerender: true,
  },
  {
    path: '/legal/terms',
    title: `用户协议｜${SITE_NAME}`,
    description: '使用趋势交易课程伴学服务前请阅读的用户协议。',
    prerender: true,
  },
]

export function metaFor(pathname: string): RouteMeta | undefined {
  const normalized = pathname !== '/' ? pathname.replace(/\/+$/, '') : pathname
  return ROUTES.find(route => route.path === normalized)
}
