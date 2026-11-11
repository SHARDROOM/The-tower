import { loadAssets } from './assets';
import { Game } from './game';

const start = document.getElementById('start') as HTMLButtonElement;
start.disabled = true;
start.textContent = '불러오는 중…';

loadAssets((r) => (start.textContent = `불러오는 중… ${Math.round(r * 100)}%`))
  .then(() => {
    const game = new Game(document.getElementById('c') as HTMLCanvasElement);
    // 콘솔 디버깅과 자동 테스트용 핸들
    (window as unknown as { game: Game }).game = game;
    start.textContent = '탑 오르기';
    start.disabled = false;
  })
  .catch((err) => {
    console.error(err);
    start.textContent = '불러오기 실패 — 새로고침 해주세요';
  });
