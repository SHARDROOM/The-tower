import { Game } from './game';

const game = new Game(document.getElementById('c') as HTMLCanvasElement);
// 콘솔 디버깅과 자동 테스트용 핸들
(window as unknown as { game: Game }).game = game;
