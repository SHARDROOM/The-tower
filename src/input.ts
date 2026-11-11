/** 터치(가상 조이스틱 + 버튼 + 시점 드래그)와 키보드/마우스를 하나의 입력 상태로 합친다. */
export class Input {
  moveX = 0;
  moveY = 0;
  attack = false;
  private dodgeQueued = false;
  private camDX = 0;
  private keys = new Set<string>();
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  private sx = 0;
  private sy = 0;
  private lookId = -1;
  private lookX = 0;
  private btnAttack = false;

  constructor(canvas: HTMLElement) {
    const stick = document.getElementById('stick')!;
    const knob = document.getElementById('knob')!;
    const R = 50;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const left = e.pointerType !== 'mouse' && e.clientX < window.innerWidth * 0.45;
      if (left && this.stickId < 0) {
        this.stickId = e.pointerId;
        this.stickX = e.clientX;
        this.stickY = e.clientY;
        stick.style.display = 'block';
        stick.style.left = `${e.clientX}px`;
        stick.style.top = `${e.clientY}px`;
        knob.style.transform = '';
      } else if (this.lookId < 0) {
        this.lookId = e.pointerId;
        this.lookX = e.clientX;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) {
        let dx = e.clientX - this.stickX;
        let dy = e.clientY - this.stickY;
        const len = Math.hypot(dx, dy);
        if (len > R) {
          dx = (dx / len) * R;
          dy = (dy / len) * R;
        }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        this.sx = dx / R;
        this.sy = -dy / R;
      } else if (e.pointerId === this.lookId) {
        this.camDX += e.clientX - this.lookX;
        this.lookX = e.clientX;
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) {
        this.stickId = -1;
        this.sx = this.sy = 0;
        stick.style.display = 'none';
      } else if (e.pointerId === this.lookId) {
        this.lookId = -1;
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    const hold = (id: string, down: () => void, up: () => void) => {
      const el = document.getElementById(id)!;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('down');
        down();
      });
      const release = () => {
        el.classList.remove('down');
        up();
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    };
    hold('btnAtk', () => (this.btnAttack = true), () => (this.btnAttack = false));
    hold('btnDodge', () => (this.dodgeQueued = true), () => {});

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyK' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.dodgeQueued = true;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.btnAttack = false;
    });
  }

  /** 프레임마다 한 번 호출 */
  poll(dt: number) {
    const k = this.keys;
    let x = this.sx;
    let y = this.sy;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    this.moveX = x;
    this.moveY = y;
    this.attack = this.btnAttack || k.has('KeyJ') || k.has('Space');
    if (k.has('KeyQ')) this.camDX -= 320 * dt;
    if (k.has('KeyE')) this.camDX += 320 * dt;
  }

  takeDodge() {
    const d = this.dodgeQueued;
    this.dodgeQueued = false;
    return d;
  }

  takeCamDX() {
    const d = this.camDX;
    this.camDX = 0;
    return d;
  }

  reset() {
    this.dodgeQueued = false;
    this.camDX = 0;
  }
}
