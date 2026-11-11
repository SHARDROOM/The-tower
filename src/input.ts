/** 터치(가상 조이스틱 + 버튼 + 시점 드래그)와 키보드/마우스를 하나의 입력 상태로 합친다. */
export class Input {
  moveX = 0;
  moveY = 0;
  attack = false;
  /** 걷기 키(C)를 누르고 있다. 터치에서는 조이스틱을 조금만 밀면 걷는다. */
  walk = false;
  /** 이동 조이스틱을 화면 오른쪽에서 잡는다(왼손잡이 배치) */
  stickRight = false;
  private dodgeQueued = false;
  private camDX = 0;
  private camDY = 0;
  private zoom = 0;
  private keys = new Set<string>();
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  private sx = 0;
  private sy = 0;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;
  private btnAttack = false;

  constructor(canvas: HTMLElement) {
    const stick = document.getElementById('stick')!;
    const knob = document.getElementById('knob')!;
    const R = 50;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const zone = this.stickRight ? e.clientX > window.innerWidth * 0.55 : e.clientX < window.innerWidth * 0.45;
      const left = e.pointerType !== 'mouse' && zone;
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
        this.lookY = e.clientY;
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
        this.camDY += e.clientY - this.lookY;
        this.lookX = e.clientX;
        this.lookY = e.clientY;
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

    // 모바일 브라우저의 확대 동작 차단. iOS Safari 는 viewport 의 user-scalable=no 를 무시하므로
    // 연타 시 더블탭 확대, 두 손가락 핀치 확대를 직접 막아야 한다. (포인터 이벤트는 그대로 온다)
    const inMenu = (t: EventTarget | null) => t instanceof Element && !!t.closest('.screen, .ui');
    document.addEventListener('touchstart', (e) => { if (!inMenu(e.target)) e.preventDefault(); }, { passive: false });
    // 설정창 안에서는 한 손가락 끌기(슬라이더·스크롤)를 허용하고, 두 손가락 핀치만 막는다
    document.addEventListener('touchmove', (e) => { if (!inMenu(e.target) || e.touches.length > 1) e.preventDefault(); }, { passive: false });
    document.addEventListener('touchend', (e) => { if (!inMenu(e.target)) e.preventDefault(); }, { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault());
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => e.preventDefault());
    }
    // PC 에서 Ctrl + 휠/트랙패드 핀치로 페이지가 확대되는 것도 막는다
    // 휠은 카메라 거리 조절에 쓴다. (Ctrl + 휠/트랙패드 핀치의 페이지 확대도 함께 막힌다)
    window.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!e.ctrlKey) this.zoom += Math.sign(e.deltaY);
    }, { passive: false });

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
    this.walk = k.has('KeyC');
    if (k.has('KeyQ')) this.camDX -= 320 * dt;
    if (k.has('KeyE')) this.camDX += 320 * dt;
  }

  takeDodge() {
    const d = this.dodgeQueued;
    this.dodgeQueued = false;
    return d;
  }

  /** 시점 드래그의 세로 이동량(픽셀) */
  takeCamDY() {
    const d = this.camDY;
    this.camDY = 0;
    return d;
  }

  /** 휠 단계 수(+ 멀어짐, - 가까워짐) */
  takeZoom() {
    const z = this.zoom;
    this.zoom = 0;
    return z;
  }

  takeCamDX() {
    const d = this.camDX;
    this.camDX = 0;
    return d;
  }

  reset() {
    this.dodgeQueued = false;
    this.camDX = this.camDY = this.zoom = 0;
  }
}
