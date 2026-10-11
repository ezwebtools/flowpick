// 站点源地址：
// - wxt dev（开发环境）指向本地 dev server
// - wxt build（生产构建）指向线上站点
// 如需临时用其他地址，可在此处直接修改。
export const SITE_ORIGIN: string = import.meta.env.DEV
  ? 'http://localhost:3001'
  : 'https://flowpick.net'
