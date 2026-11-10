import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 빌드 결과는 Python(FastAPI)이 정적 파일로 서빙한다.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../app/static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
