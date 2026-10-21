/** 千分位（1,628）。显式 en-US：服务端渲染和浏览器的默认 locale 不一定相同，水合时数字会跳 */
export const fmtNum = (n) => Number(n).toLocaleString('en-US');
