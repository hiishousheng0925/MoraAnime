import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

export default {
  plugins: [tailwindcss(), sveltekit()],
  server: { host: '0.0.0.0', port: 5173 },
  // 开发服务器启动时扫一遍全部组件，把依赖（尤其是 phosphor-svelte 的单个图标）一次预构建完。
  // 不扫的话，第一次打开用了新图标的页面时 vite 才发现依赖 →「optimized dependencies changed. reloading」，
  // 页面中途被重载，测试里表现为偶发的 TypeError: Cannot read properties of undefined (reading 'call')
  optimizeDeps: { entries: ['src/**/*.svelte'] }   // 只扫组件：src/**/*.js 会扫进服务端代码（截图用的 playwright-core 打不进浏览器包）
};
