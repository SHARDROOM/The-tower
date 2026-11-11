import type { Game } from './game';

/** 조작 버튼 설정. 위치는 화면 크기에 대한 비율(0~1)이라 기기를 돌려도 유지된다. */
interface Config {
  scale: number;
  opacity: number;
  /** 왼손잡이 배치: 버튼은 왼쪽, 이동 조이스틱은 오른쪽 */
  lefty: boolean;
  /** 직접 배치한 버튼 중심 위치. null 이면 기본 자리 */
  atk: [number, number] | null;
  dodge: [number, number] | null;
}

const KEY = 'tower.controls';
const DEFAULTS: Config = { scale: 1, opacity: 1, lefty: false, atk: null, dodge: null };
const $ = (id: string) => document.getElementById(id)!;

/** 두루마리 설정창과 버튼 직접 배치 모드 */
export class Settings {
  private cfg: Config = { ...DEFAULTS };
  private editing = false;

  constructor(private game: Game) {
    try {
      this.cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch {
      // 저장값이 깨졌으면 기본값으로 시작한다
    }
    const scale = $('optScale') as HTMLInputElement;
    const opacity = $('optOpacity') as HTMLInputElement;

    // 게임 화면의 터치 기본 동작을 막아 두었기 때문에 click 대신 pointerdown 을 쓴다
    $('btnSettings').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.open();
    });
    $('setClose').addEventListener('click', () => this.close());
    $('settings').addEventListener('click', (e) => {
      if (e.target === $('settings')) this.close();
    });
    scale.addEventListener('input', () => {
      this.cfg.scale = Number(scale.value) / 100;
      this.apply();
    });
    opacity.addEventListener('input', () => {
      this.cfg.opacity = Number(opacity.value) / 100;
      this.apply();
    });
    $('optRight').addEventListener('click', () => this.setHand(false));
    $('optLeft').addEventListener('click', () => this.setHand(true));
    $('optEdit').addEventListener('click', () => this.startEdit());
    $('optReset').addEventListener('click', () => {
      this.cfg = { ...DEFAULTS };
      this.apply();
    });
    $('editDone').addEventListener('click', () => this.stopEdit());

    for (const [id, key] of [['btnAtk', 'atk'], ['btnDodge', 'dodge']] as const) this.makeDraggable($(id), key);
    this.apply();
  }

  private open() {
    if (this.editing) return;
    this.game.paused = true;
    $('settings').classList.add('open');
  }

  private close() {
    $('settings').classList.remove('open');
    this.game.paused = false;
  }

  private setHand(lefty: boolean) {
    // 손 방향을 바꾸면 직접 배치한 위치는 버리고 그 손의 기본 자리로 돌아간다
    this.cfg.lefty = lefty;
    this.cfg.atk = this.cfg.dodge = null;
    this.apply();
  }

  private startEdit() {
    $('settings').classList.remove('open');
    this.editing = true;
    $('hud').classList.add('editing');
    $('editBar').classList.add('show');
  }

  private stopEdit() {
    this.editing = false;
    $('hud').classList.remove('editing');
    $('editBar').classList.remove('show');
    this.game.paused = false;
  }

  /** 배치 모드에서 버튼을 끌어 옮긴다. */
  private makeDraggable(el: HTMLElement, key: 'atk' | 'dodge') {
    let dragging = false;
    el.addEventListener('pointerdown', () => (dragging = this.editing));
    el.addEventListener('pointermove', (e) => {
      if (!dragging || !this.editing) return;
      const r = el.getBoundingClientRect();
      // 버튼이 화면 밖으로 나가지 않게 한다
      const x = Math.min(Math.max(e.clientX, r.width / 2), window.innerWidth - r.width / 2);
      const y = Math.min(Math.max(e.clientY, r.height / 2), window.innerHeight - r.height / 2);
      this.cfg[key] = [x / window.innerWidth, y / window.innerHeight];
      this.apply();
    });
    const end = () => (dragging = false);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private apply() {
    const c = this.cfg;
    const hud = $('hud');
    hud.style.setProperty('--btn-scale', String(c.scale));
    hud.style.setProperty('--btn-opacity', String(c.opacity));
    hud.classList.toggle('lefty', c.lefty);
    this.game.input.stickRight = c.lefty;
    for (const [id, pos] of [['btnAtk', c.atk], ['btnDodge', c.dodge]] as const) {
      const el = $(id);
      el.classList.toggle('placed', !!pos);
      el.style.left = pos ? `${pos[0] * 100}%` : '';
      el.style.top = pos ? `${pos[1] * 100}%` : '';
    }
    ($('optScale') as HTMLInputElement).value = String(Math.round(c.scale * 100));
    ($('optOpacity') as HTMLInputElement).value = String(Math.round(c.opacity * 100));
    $('valScale').textContent = `${Math.round(c.scale * 100)}%`;
    $('valOpacity').textContent = `${Math.round(c.opacity * 100)}%`;
    $('optRight').classList.toggle('on', !c.lefty);
    $('optLeft').classList.toggle('on', c.lefty);
    localStorage.setItem(KEY, JSON.stringify(c));
  }
}
