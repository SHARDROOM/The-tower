import { defineConfig } from 'vite';

// 상대 경로(base './')로 빌드해야 Capacitor 웹뷰(file/capacitor 스킴)에서 에셋이 로드된다.
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
