"""주인공 기사용 동작을 직접 만들어 scripts/anim/*.json 으로 저장한다 (Blender 의 파이썬에서 실행).

    <blender python> scripts/blender/heavy_anims.py <리깅된 기사 모델.glb>

모델의 뼈대는 기본 자세에서 뼈 회전이 모두 0 이다. 그래서 프레임마다 각 뼈의 월드 회전을 직접 정하고
(다리와 검을 든 팔은 2관절 IK 로 풀어 발과 손이 정한 위치에 오게 한다) 부모 기준 로컬 회전으로 바꿔 저장한다.
좌표는 glTF 기준(+Y 위, +Z 정면, +X 캐릭터의 왼쪽), 길이 단위는 모델 원본(키 1.0)이다.
저장된 JSON 은 scripts/retarget.mjs 가 모델 파일에 동작으로 넣는다.
"""
import json, math, struct, sys, os
import bpy  # noqa: F401 — mathutils 는 Blender 모듈을 불러온 뒤에 쓸 수 있다
from mathutils import Matrix, Quaternion, Vector

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
FPS = 30


def aa(axis, deg):
    return Quaternion(Vector(axis).normalized(), math.radians(deg))


def swing(a, b):
    """방향 a 를 방향 b 로 돌리는 가장 짧은 회전"""
    return Vector(a).rotation_difference(Vector(b))


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


# ── 뼈대 읽기 ──────────────────────────────────────────────────────────────
with open(sys.argv[-1], 'rb') as f:
    data = f.read()
gltf = json.loads(data[20:20 + struct.unpack('<I', data[12:16])[0]])
nodes = gltf['nodes']
joint_ids = gltf['skins'][0]['joints']
PARENT = {}
for i, n in enumerate(nodes):
    for c in n.get('children', []):
        PARENT[nodes[c]['name']] = n['name']
BONES = [nodes[i]['name'] for i in joint_ids]
OFF = {nodes[i]['name']: Vector(nodes[i].get('translation', (0, 0, 0))) for i in joint_ids}
PARENT = {b: PARENT.get(b) if PARENT.get(b) in OFF else None for b in BONES}


def rest_pos(b):
    return OFF[b] + (rest_pos(PARENT[b]) if PARENT[b] else Vector())


REST = {b: rest_pos(b) for b in BONES}
FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']


def hand_axes(s):
    """손의 기본 자세 방향: 손가락 방향, 칼날이 서는 방향(엄지 쪽), 손바닥 방향, 손가락을 쥐는 회전축"""
    fingers = OFF[f'{s}_Middle1'].normalized()
    across = OFF[f'{s}_Pinky1'] - OFF[f'{s}_Index1']
    across = (across - fingers * across.dot(fingers)).normalized()
    palm = fingers.cross(across) * (1 if s == 'R' else -1)
    return fingers, -across, palm, fingers.cross(palm)


HAND = {s: hand_axes(s) for s in 'LR'}


class Arm:
    """팔 조종값. target 이 있으면 손목을 그 위치로 보내는 IK, 없으면 어깨·팔꿈치 각도(FK)."""
    def __init__(self, upper=Quaternion(), elbow=0.0, hand=Quaternion(), target=None, hint=None, blade=None, grip=0.0):
        self.upper, self.elbow, self.hand = upper, elbow, hand
        self.target, self.hint, self.blade, self.grip = target, hint, blade, grip


class Pose:
    def __init__(self):
        self.pelvis = Vector()            # 골반 위치 변화
        self.yaw = self.pitch = self.roll = 0.0   # 골반 회전(도)
        self.spine = [Quaternion()] * 3   # 척추 세 마디의 로컬 회전
        self.neck = self.head = Quaternion()
        self.foot = {s: (Vector(), 0.0, 0.0) for s in 'LR'}   # 발목 위치 변화, 발끝 내림 각도, 발 방향 각도
        self.arm = {s: Arm() for s in 'LR'}


def two_bone(root, target, l1, l2, hint):
    """두 마디 IK: 중간 관절 위치와 (길이 한계로 당겨진) 끝 위치를 돌려준다."""
    v = target - root
    d = max(1e-5, min(v.length, (l1 + l2) * 0.999))
    dirv = v.normalized()
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    bend = hint - dirv * hint.dot(dirv)
    bend = bend.normalized() if bend.length > 1e-5 else Vector()
    return root + dirv * a + bend * h, root + dirv * d


def solve(p):
    """Pose → 뼈별 로컬 회전(dict)과 골반 위치"""
    W, P = {}, {}
    Ryaw = aa(Y, p.yaw)
    W['Pelvis'] = Ryaw @ aa(X, p.pitch) @ aa(Z, p.roll)
    P['Pelvis'] = REST['Pelvis'] + p.pelvis
    prev = 'Pelvis'
    for b, q in zip(['Spine1', 'Spine2', 'Spine3', 'Neck', 'Head'], p.spine + [p.neck, p.head]):
        P[b] = P[prev] + W[prev] @ OFF[b]
        W[b] = W[prev] @ q
        prev = b
    local = {}
    for s, sx in (('L', 1), ('R', -1)):
        # 다리: 발목을 정한 위치에 놓고 무릎은 앞으로 굽힌다
        hip, knee, ankle, toe = f'{s}_Hip', f'{s}_Knee', f'{s}_Ankle', f'{s}_Foot'
        off, toe_down, foot_yaw = p.foot[s]
        H = P['Pelvis'] + W['Pelvis'] @ OFF[hip]
        fyaw = aa(Y, p.yaw * 0.5 + foot_yaw)
        K, A = two_bone(H, REST[ankle] + off, OFF[knee].length, OFF[ankle].length, fyaw @ Z)
        W[hip] = swing(Ryaw @ OFF[knee], K - H) @ Ryaw
        W[knee] = swing(W[hip] @ OFF[ankle], A - K) @ W[hip]
        W[ankle] = fyaw @ aa(X, toe_down)
        W[toe] = fyaw @ aa(X, min(toe_down, 0.0))   # 뒤꿈치를 들 때 발가락은 바닥에 남는다
        # 팔
        col, sho, elb, wri = f'{s}_Collar', f'{s}_Shoulder', f'{s}_Elbow', f'{s}_Wrist'
        arm = p.arm[s]
        chest = W['Spine3']
        P[col] = P['Spine3'] + chest @ OFF[col]
        W[col] = chest
        S = P[col] + chest @ OFF[sho]
        fingers, blade0, palm0, curl_axis = HAND[s]
        if arm.target is not None:
            E, Wr = two_bone(S, arm.target, OFF[elb].length, OFF[wri].length, arm.hint)
            W[sho] = swing(chest @ OFF[elb], E - S) @ chest
            W[elb] = swing(W[sho] @ OFF[wri], Wr - E) @ W[sho]
        else:
            W[sho] = chest @ arm.upper
            hinge = OFF[wri].normalized().cross(Z).normalized()   # 팔꿈치를 앞으로 굽히는 축
            W[elb] = W[sho] @ Quaternion(hinge, math.radians(arm.elbow))
        if arm.blade is not None:
            # 칼날이 정한 방향을 향하도록 손을 돌린다. 손가락은 팔뚝이 뻗은 쪽으로 둔다.
            B = arm.blade.normalized()
            F = W[elb] @ OFF[wri].normalized()
            F = (F - B * F.dot(B)).normalized()
            src = Matrix((fingers, blade0, fingers.cross(blade0))).transposed()
            dst = Matrix((F, B, F.cross(B))).transposed()
            W[wri] = (dst @ src.inverted()).to_quaternion()
        else:
            W[wri] = W[elb] @ arm.hand
        for f in FINGERS:
            for i in (1, 2, 3):
                amount = arm.grip * (0.45 if f == 'Thumb' else 1.0)
                local[f'{s}_{f}{i}'] = Quaternion(curl_axis, math.radians(amount))
    for b in BONES:
        if b not in local:
            parent = PARENT[b]
            local[b] = (W[parent].inverted() @ W[b]) if parent else W[b]
    return local, P['Pelvis']


def write(name, duration, pose_at, loop=False, notes=None):
    frames = round(duration * FPS) + 1
    tracks = {b: [] for b in BONES}
    pelvis = []
    last = {}
    for f in range(frames):
        t = f / (frames - 1) * duration
        if loop and f == frames - 1:
            t = 0.0   # 반복 동작은 끝 프레임을 첫 프레임과 똑같이 맞춘다
        local, pos = solve(pose_at(t))
        for b in BONES:
            q = local[b].normalized()
            if b in last and last[b].dot(q) < 0:
                q.negate()   # 프레임 사이 보간이 먼 길로 돌지 않게 부호를 맞춘다
            last[b] = q
            tracks[b] += [round(q.x, 5), round(q.y, 5), round(q.z, 5), round(q.w, 5)]
        pelvis += [round(v, 5) for v in pos]
    out = os.path.join(os.path.dirname(__file__), '..', 'anim', f'{name}.json')
    with open(out, 'w') as fp:
        json.dump({'name': name, 'duration': duration, 'frames': frames, 'notes': notes or {}, 'pelvis': pelvis, 'rotations': tracks}, fp)
    print(f'{name}: {duration:.2f}s, {frames} frames')


# ── 무게감 있는 달리기 ─────────────────────────────────────────────────────
# 갑옷을 입은 느낌: 자세를 낮추고 상체를 숙인 채, 발을 낮게 들어 쿵쿵 내딛는다. 위아래 출렁임은 작게,
# 대신 발을 디딜 때마다 골반이 묵직하게 내려앉는다. 검을 든 오른팔은 거의 고정하고 왼팔만 흔든다.
RUN_TIME = 0.74       # 두 걸음 한 주기(초)
RUN_REACH = 0.215     # 발이 골반 앞뒤로 나가는 거리
RUN_STANCE = 0.42     # 한 발이 땅에 닿아 있는 비율


def run_foot(ph):
    if ph < RUN_STANCE:
        u = ph / RUN_STANCE
        z = lerp(RUN_REACH, -RUN_REACH, u)
        lift = max(0.0, (u - 0.6) / 0.4)
        toe_down = lerp(-12, 0, min(u / 0.18, 1)) if u < 0.6 else lerp(0, 32, lift)
        return Vector((0, 0.03 * lift, z)), toe_down
    u = (ph - RUN_STANCE) / (1 - RUN_STANCE)
    z = lerp(-RUN_REACH, RUN_REACH, smooth(u))
    y = 0.03 * (1 - u) + 0.075 * math.sin(math.pi * u) ** 1.3
    toe_down = lerp(32, 48, u / 0.3) if u < 0.3 else lerp(48, -12, smooth((u - 0.3) / 0.7))
    return Vector((0, y, z)), toe_down


def run_pose(t):
    ph = (t / RUN_TIME) % 1.0
    c = math.cos(2 * math.pi * ph)
    p = Pose()
    # 발을 디딘 직후(ph 0.1, 0.6)에 가장 낮다. 내려앉을 때는 빠르게, 올라올 때는 천천히.
    drop = math.cos(4 * math.pi * (ph - 0.11))
    p.pelvis = Vector((0.010 * math.cos(2 * math.pi * (ph - 0.2)), -0.045 - 0.013 * drop - 0.004 * drop * abs(drop), 0.0))
    p.yaw = -7 * c
    p.pitch = 12
    p.roll = 2.0 * math.sin(2 * math.pi * (ph - 0.05))
    twist = aa(Y, 4.5 * c)
    p.spine = [aa(X, 5) @ twist, aa(X, 5) @ twist, aa(X, 4) @ twist]
    p.neck = aa(X, -7) @ aa(Y, -3 * c)
    p.head = aa(X, -9) @ aa(Y, -3.5 * c)
    for s, shift in (('L', 0.0), ('R', 0.5)):
        off, toe_down = run_foot((ph + shift) % 1.0)
        off.x = -0.012 * (1 if s == 'L' else -1)   # 발을 조금 모아 디딘다
        p.foot[s] = (off, toe_down, 0.0)
    # 왼팔: 오른발이 나갈 때 앞으로. 오른팔: 검을 세워 들고 작게만 흔든다.
    p.arm['L'] = Arm(upper=aa(X, 20 * c - 4) @ aa(Z, -24), elbow=78 - 10 * c, grip=55)
    p.arm['R'] = Arm(upper=aa(X, 14 - 7 * c) @ aa(Z, 22), elbow=84 + 4 * c, grip=62)
    return p


write('Heavy_Run', RUN_TIME, run_pose, loop=True, notes={'speed': 'authored for about 4 world units per second'})


# ── 무게감 있는 내려베기 ───────────────────────────────────────────────────
# 느리고 크게 준비해서(검을 어깨 뒤로 넘기며 몸을 뒤로 틀고 체중을 뒷발에 싣는다) 순식간에 내려친다.
# 칠 때는 골반이 앞으로 나가며 내려앉고 상체가 반대로 크게 틀어지고, 친 뒤에는 그 자세로 잠깐 눌러 있다가 돌아온다.
# 시각(초):  준비 자세 → 검을 뒤로 → 머리 위를 지남 → 타격 → 끝까지 휘두름 → 눌러 있음 → 준비 자세
ATK_KEYS = [0.0, 0.50, 0.58, 0.66, 0.80, 1.05, 1.45]
ATK_HIT = 0.63   # 검이 목표를 지나는 순간
ATK_EASE = [smooth, lambda u: u * u, lambda u: u, lambda u: 1 - (1 - u) ** 2, smooth, smooth]


def track(t, values):
    """ATK_KEYS 시각의 값들 사이를 구간별 가감속으로 잇는다."""
    for i in range(len(ATK_KEYS) - 1):
        if t <= ATK_KEYS[i + 1] or i == len(ATK_KEYS) - 2:
            u = ATK_EASE[i](max(0.0, min(1.0, (t - ATK_KEYS[i]) / (ATK_KEYS[i + 1] - ATK_KEYS[i]))))
            a, b = values[i], values[i + 1]
            return a.lerp(b, u) if isinstance(a, Vector) else lerp(a, b, u)


def V(*xyz):
    return Vector(xyz)


GUARD_HAND, GUARD_BLADE = V(-0.15, 0.15, 0.10), V(-0.10, 0.85, 0.50)


def attack_pose(t):
    p = Pose()
    p.pelvis = track(t, [V(0, -0.03, 0), V(-0.01, -0.02, -0.035), V(0, -0.035, 0.01), V(0.01, -0.075, 0.055),
                         V(0.012, -0.088, 0.06), V(0.01, -0.078, 0.05), V(0, -0.03, 0)])
    p.yaw = track(t, [-12, -30, -10, 18, 24, 20, -12])
    p.pitch = track(t, [4, -4, 6, 16, 18, 16, 4])
    twist = track(t, [-10, -40, -5, 30, 38, 30, -10])
    lean = track(t, [6, -10, 8, 26, 30, 26, 6])
    p.spine = [aa(X, lean / 3) @ aa(Y, twist / 3)] * 3
    # 머리는 계속 정면의 상대를 본다
    look = aa(X, -(lean * 0.6 + p.pitch * 0.5) / 2) @ aa(Y, -(p.yaw + twist) * 0.8 / 2)
    p.neck = p.head = look
    # 왼발은 앞에 딛고 버틴다. 오른발은 뒤에서 바깥으로 틀어 딛고, 칠 때 뒤꿈치가 들린다.
    heel = track(t, [0, 0, 8, 22, 26, 12, 0])
    p.foot['L'] = (V(0.012, 0, 0.09), 0.0, 8.0)
    p.foot['R'] = (V(-0.02, 0.02 * heel / 26, -0.09 + 0.01 * heel / 26), heel, -30.0)
    hand = track(t, [GUARD_HAND, V(-0.17, 0.46, -0.05), V(-0.09, 0.47, 0.13), V(0.01, 0.17, 0.24),
                     V(0.06, 0.08, 0.20), V(0.05, 0.09, 0.19), GUARD_HAND])
    blade = track(t, [GUARD_BLADE, V(-0.15, 0.45, -0.88), V(0, 0.85, 0.50), V(0.10, -0.25, 0.96),
                      V(0.30, -0.55, 0.78), V(0.28, -0.50, 0.80), GUARD_BLADE])
    p.arm['R'] = Arm(target=hand, hint=V(-0.7, -0.4, -0.5), blade=blade, grip=65)
    # 왼팔: 준비할 때 앞으로 뻗어 균형을 잡고, 칠 때 뒤로 당긴다
    swing_l = track(t, [-20, -55, -30, 25, 35, 28, -20])
    spread = track(t, [20, 10, 20, 30, 32, 30, 20])
    p.arm['L'] = Arm(upper=aa(X, swing_l) @ aa(Z, -spread), elbow=track(t, [75, 35, 50, 60, 65, 62, 75]), grip=40)
    return p


write('Heavy_Attack', ATK_KEYS[-1], attack_pose, notes={'hit': ATK_HIT})
