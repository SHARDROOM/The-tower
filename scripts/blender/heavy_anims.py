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
FPS = 60   # 빠르게 휘두르는 구간이 뭉개지지 않도록 촘촘히 기록한다 (변화가 없는 구간은 retarget.mjs 가 솎아 낸다)


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
    """팔 조종값. reach 가 있으면 손목을 그 위치로 보내는 IK, 없으면 어깨·팔꿈치 각도(FK).

    reach: 어깨에서 손목까지의 벡터(상체가 향한 쪽 기준). 팔 길이 안에서 정하면 팔꿈치가 잠기지 않는다.
    blade: 칼날이 향할 방향. lead: 칼날이 움직이는 방향 — 날(엣지)이 그쪽을 향하도록 손을 돌린다.
    """
    def __init__(self, upper=Quaternion(), elbow=0.0, hand=Quaternion(), reach=None, hint=None, blade=None, lead=None, grip=0.0):
        self.upper, self.elbow, self.hand = upper, elbow, hand
        self.reach, self.hint, self.blade, self.lead, self.grip = reach, hint, blade, lead, grip


class Pose:
    def __init__(self):
        self.pelvis = Vector()            # 골반 위치 변화
        self.yaw = self.pitch = self.roll = 0.0   # 골반 회전(도)
        self.aim = 0.0                    # 상체가 향한 방향(도): 팔 IK 의 reach 기준
        self.spine = [Quaternion()] * 3   # 척추 세 마디의 로컬 회전
        self.neck = self.head = Quaternion()
        self.foot = {s: (Vector(), 0.0, 0.0) for s in 'LR'}   # 발목 위치 변화, 발끝 내림 각도, 발 방향 각도
        self.arm = {s: Arm() for s in 'LR'}


def frame(direction, normal):
    """direction 을 첫 축으로, normal(직각 성분만 씀)을 둘째 축으로 하는 회전 행렬"""
    d = Vector(direction).normalized()
    n = Vector(normal)
    n = (n - d * n.dot(d)).normalized()
    return Matrix((d, n, d.cross(n))).transposed()


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
        if arm.reach is not None:
            aim = aa(Y, p.aim)
            E, Wr = two_bone(S, S + aim @ arm.reach, OFF[elb].length, OFF[wri].length, aim @ arm.hint)
            # 팔의 비틀림은 팔꿈치가 접히는 면으로 정한다(팔꿈치 축이 위팔에 고정된 것처럼).
            # 뼈 방향만 맞추는 가장 짧은 회전을 쓰면 팔을 머리 위로 올릴 때 비틀림이 갑자기 뒤집힌다.
            d1, d2 = (E - S).normalized(), (Wr - E).normalized()
            axis = d1.cross(d2).normalized()
            hinge = OFF[wri].normalized().cross(Z)
            W[sho] = (frame(d1, axis) @ frame(OFF[elb].normalized(), hinge).inverted()).to_quaternion()
            W[elb] = (frame(d2, axis) @ frame(OFF[wri].normalized(), hinge).inverted()).to_quaternion()
        else:
            W[sho] = chest @ arm.upper
            hinge = OFF[wri].normalized().cross(Z).normalized()   # 팔꿈치를 앞으로 굽히는 축
            W[elb] = W[sho] @ Quaternion(hinge, math.radians(arm.elbow))
        if arm.blade is not None:
            # 칼날이 정한 방향을 향하도록 손을 돌린다. 칼날 둘레로 손이 얼마나 돌아가 있을지(손등 방향)는
            # 팔뚝이 뻗은 쪽과 칼날이 움직이는 쪽을 섞어 정한다: 가만히 들고 있을 때는 손목이 자연스럽게,
            # 휘두를 때는 날이 앞서게. 다만 팔뚝과 칼날이 나란해지면 이 방향이 불안정해 손이 휙 뒤집히므로,
            # 앞 프레임의 손등 방향을 이어받아 조금씩만 따라가게 한다.
            B = arm.blade.normalized()
            want = (W[elb] @ OFF[wri].normalized()) * 0.6
            if arm.lead is not None:
                want = want + arm.lead
            want = want - B * want.dot(B)
            prev = HAND_STATE.get(s)
            if prev is None:
                F = want.normalized()
            else:
                F = (prev - B * prev.dot(B)).normalized()
                if want.length > 0.05 and want.normalized().dot(F) > -0.3:
                    F = F.lerp(want.normalized(), min(1.0, (3.6 + want.length * 7.5) / FPS)).normalized()
            HAND_STATE[s] = F
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


HAND_STATE = {}   # 손마다 앞 프레임의 손등 방향 (동작을 새로 쓸 때 비운다)


def write(name, duration, pose_at, loop=False, notes=None):
    HAND_STATE.clear()
    if loop:
        # 손목 비틀림은 앞 프레임을 따라가며 정해지므로, 한 바퀴 미리 돌려 자리를 잡은 뒤 기록해야 이음매가 맞는다
        for f in range(round(duration * FPS)):
            solve(pose_at(f / FPS))
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


def V(*xyz):
    return Vector(xyz)


# ── 무게감 있는 달리기 ─────────────────────────────────────────────────────
# 참고 그림: 판금 갑옷 기사가 몸을 앞으로 크게 숙이고 투구를 앞세워 돌진하는 자세.
# - 상체를 약 40° 숙이고 어깨를 둥글게 말아 머리가 앞으로 나간다. 시선은 앞을 향하되 투구는 살짝 숙인다.
# - 검을 든 오른팔은 몸 옆으로 늘어뜨리고, 칼날은 앞쪽 아래로 비스듬히 내려 칼끝이 땅 가까이 간다.
# - 왼팔은 앞쪽 아래로 늘어뜨려 손을 반쯤 편 채 걸음에 맞춰 흔든다(조깅처럼 팔을 접어 펌프질하지 않는다).
# - 자세를 낮추고 보폭을 넓게, 앞으로 나가는 다리는 무릎을 높이 든다. 디딜 때마다 골반이 묵직하게 내려앉는다.
RUN_SPEED = 3.6       # 게임 이동 속도(월드 단위/초). 디딘 발이 이 속도로 뒤로 가야 미끄러지지 않는다
RUN_TIME = 0.74       # 두 걸음 한 주기(초)
RUN_REACH = 0.235     # 발이 골반 앞뒤로 나가는 거리
WORLD = 1.8 * 1.05    # 모델 단위 → 게임 월드 단위 (retarget.mjs 의 키 맞춤 × game.ts 의 HERO_SCALE)
RUN_STANCE = (2 * RUN_REACH * WORLD / RUN_SPEED) / RUN_TIME   # 한 발이 땅에 닿아 있는 비율(약 0.33): 보폭 ÷ 속도
RUN_LEAN = 40         # 상체를 숙이는 정도(도). 골반과 척추 세 마디에 나눠 준다


def run_foot(ph):
    if ph < RUN_STANCE:
        u = ph / RUN_STANCE
        z = lerp(RUN_REACH, -RUN_REACH, u)
        lift = max(0.0, (u - 0.6) / 0.4)
        toe_down = lerp(-12, 0, min(u / 0.18, 1)) if u < 0.6 else lerp(0, 36, lift)
        return Vector((0, 0.03 * lift, z)), toe_down
    u = (ph - RUN_STANCE) / (1 - RUN_STANCE)
    # 발을 뒤로 차 올린 뒤 무릎을 높이 들며 앞으로 가져온다
    z = lerp(-RUN_REACH, RUN_REACH * 1.05, smooth(u))
    y = 0.03 * (1 - u) + 0.11 * math.sin(math.pi * min(1.0, u * 1.15)) ** 1.2
    toe_down = lerp(36, 52, u / 0.3) if u < 0.3 else lerp(52, -14, smooth((u - 0.3) / 0.7))
    return Vector((0, y, z)), toe_down


def run_pose(t):
    ph = (t / RUN_TIME) % 1.0
    c = math.cos(2 * math.pi * ph)
    p = Pose()
    # 발을 디딘 직후(ph 0.1, 0.6)에 가장 낮다. 내려앉을 때는 빠르게, 올라올 때는 천천히.
    drop = math.cos(4 * math.pi * (ph - 0.11))
    p.pelvis = Vector((0.010 * math.cos(2 * math.pi * (ph - 0.16)), -0.072 - 0.014 * drop - 0.004 * drop * abs(drop), -0.012))
    p.yaw = -8 * c
    p.pitch = RUN_LEAN * 0.4 + 1.5 * drop
    p.roll = 2.5 * math.sin(2 * math.pi * (ph - 0.05))
    twist = aa(Y, 5 * c)
    bend = RUN_LEAN * 0.6 / 3
    # 등 위쪽을 더 굽혀 어깨가 앞으로 말린다
    p.spine = [aa(X, bend * 0.8) @ twist, aa(X, bend) @ twist, aa(X, bend * 1.2) @ twist]
    # 몸을 숙인 만큼 고개를 들어 앞을 보되, 투구는 15° 정도 숙인 채로 둔다
    p.neck = aa(X, -(RUN_LEAN - 15) * 0.45) @ aa(Y, -3 * c)
    p.head = aa(X, -(RUN_LEAN - 15) * 0.55) @ aa(Y, -3.5 * c)
    for s, shift in (('L', 0.0), ('R', 0.5)):
        off, toe_down = run_foot((ph + shift) % 1.0)
        off.x = -0.010 * (1 if s == 'L' else -1)   # 발을 조금 모아 디딘다
        p.foot[s] = (off, toe_down, 0.0)
    p.aim = p.yaw
    # 오른팔: 검을 든 팔을 몸 옆으로 늘어뜨린다(팔 길이 약 0.236 중 0.215, 팔꿈치는 살짝 굽음).
    # 몸을 숙였으므로 어깨에서 거의 바로 아래가 골반 옆이다. 걸음에 맞춰 손이 앞뒤로 조금 흔들린다.
    hand_r = V(-0.07, -0.20, 0.035 - 0.03 * c)
    # 칼날: 앞쪽 아래로, 바깥으로 살짝 벌려 칼끝이 앞발 옆 땅 가까이 간다. 손이 흔들리는 반대로 까딱인다.
    blade = aa(Y, p.aim) @ V(-0.22, -0.78 + 0.06 * c, 0.58)
    p.arm['R'] = Arm(reach=hand_r, hint=V(-0.3, 0.1, -1.0), blade=blade, grip=68)
    # 왼팔: 앞쪽 아래로 늘어뜨려 손을 반쯤 편다. 오른발이 나갈 때(c < 0 일 때 왼팔이 뒤) 앞으로.
    hand_l = V(0.04, -0.175, 0.06 + 0.06 * c)   # 길이 0.18~0.22: 앞으로 흔들 때도 팔꿈치가 잠기지 않는다
    p.arm['L'] = Arm(reach=hand_l, hint=V(0.35, 0.0, -1.0), hand=aa(X, -10), grip=28)
    return p


write('Heavy_Run', RUN_TIME, run_pose, loop=True, notes={'speed': RUN_SPEED})


# ── 무게감 있는 내려베기 ───────────────────────────────────────────────────
# 느리고 크게 준비해서(검을 어깨 뒤로 넘기며 몸을 뒤로 틀고 체중을 뒷발에 싣는다) 순식간에 내려친다.
# 칠 때는 골반이 앞으로 나가며 내려앉고 상체가 반대로 크게 틀어지고, 친 뒤에는 그 자세로 잠깐 눌러 있다가 돌아온다.
# 시각(초):  준비 자세 → 검을 옆으로 들어 올림 → 검을 뒤로 → 머리 위를 지남 → 타격 → 끝까지 휘두름 → 눌러 있음 → 일어서며 검을 거둠 → 준비 자세
ATK_KEYS = [0.0, 0.28, 0.48, 0.61, 0.72, 0.87, 1.08, 1.32, 1.62]


def key_position(t):
    """시각 → 키 번호(소수). 키 사이의 빠르기가 이음매에서 끊기지 않도록 단조 3차 곡선(PCHIP)으로 잇는다."""
    x, n = ATK_KEYS, len(ATK_KEYS)
    t = max(x[0], min(x[-1], t))
    h = [x[i + 1] - x[i] for i in range(n - 1)]
    sec = [1.0 / hi for hi in h]   # 키 번호는 구간마다 1 씩 늘어난다
    d = [sec[0]] + [0.0] * (n - 2) + [sec[-1]]
    for i in range(1, n - 1):
        w1, w2 = 2 * h[i] + h[i - 1], h[i] + 2 * h[i - 1]
        d[i] = (w1 + w2) / (w1 / sec[i - 1] + w2 / sec[i])
    d[0] = d[-1] = 0.0   # 처음과 끝은 멈춘 상태에서 출발·도착
    i = max(k for k in range(n - 1) if x[k] <= t)
    u = (t - x[i]) / h[i]
    h00, h10, h01, h11 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u, -2 * u**3 + 3 * u**2, u**3 - u**2
    return h00 * i + h10 * h[i] * d[i] + h01 * (i + 1) + h11 * h[i] * d[i + 1]


def track(t, values):
    """ATK_KEYS 시각의 값들을 지나는 매끄러운 곡선(Catmull-Rom). 키에서 방향과 빠르기가 꺾이지 않는다."""
    k = key_position(t)
    i = min(int(k), len(values) - 2)
    u = k - i
    p0, p1, p2, p3 = values[max(i - 1, 0)], values[i], values[i + 1], values[min(i + 2, len(values) - 1)]
    return 0.5 * ((2 * p1) + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u**3)


# 손 위치는 오른 어깨에서 잰 벡터다(팔 길이는 약 0.236). 0.15~0.21 사이로 두어 팔꿈치가 잠기거나 완전히 접히지 않게 한다.
GUARD_HAND, GUARD_BLADE = V(-0.03, -0.14, 0.12), V(-0.10, 0.85, 0.50)
# 들어 올릴 때 손이 어깨 바로 앞을 지나면 팔이 완전히 접히므로, 바깥 앞쪽으로 돌아 올라가는 지점을 둔다.
HAND_KEYS = [GUARD_HAND, V(-0.11, 0.03, 0.10), V(-0.04, 0.12, -0.07), V(0.02, 0.17, 0.08), V(0.08, -0.08, 0.18), V(0.11, -0.15, 0.10), V(0.10, -0.14, 0.10), V(0.03, -0.15, 0.13), GUARD_HAND]
BLADE_KEYS = [GUARD_BLADE, V(-0.15, 0.95, -0.10), V(-0.15, 0.45, -0.88), V(0, 0.85, 0.50), V(0.10, -0.25, 0.96), V(0.35, -0.85, 0.40), V(0.33, -0.80, 0.46), V(0.10, 0.15, 0.98), GUARD_BLADE]


def attack_pose(t):
    p = Pose()
    p.pelvis = track(t, [V(0, -0.03, 0), V(-0.006, -0.024, -0.02), V(-0.01, -0.02, -0.035), V(0, -0.035, 0.01), V(0.01, -0.075, 0.055),
                         V(0.012, -0.088, 0.06), V(0.01, -0.078, 0.05), V(0.004, -0.05, 0.02), V(0, -0.03, 0)])
    p.yaw = track(t, [-12, -22, -30, -10, 18, 24, 20, 2, -12])
    p.pitch = track(t, [4, 0, -4, 6, 16, 18, 16, 9, 4])
    twist = track(t, [-10, -27, -40, -5, 30, 38, 30, 8, -10])
    lean = track(t, [6, -3, -10, 8, 26, 30, 26, 14, 6])
    p.spine = [aa(X, lean / 3) @ aa(Y, twist / 3)] * 3
    # 머리는 계속 정면의 상대를 본다
    look = aa(X, -(lean * 0.6 + p.pitch * 0.5) / 2) @ aa(Y, -(p.yaw + twist) * 0.8 / 2)
    p.neck = p.head = look
    # 왼발은 앞에 딛고 버틴다. 오른발은 뒤에서 바깥으로 틀어 딛고, 칠 때 뒤꿈치가 들린다.
    heel = max(0.0, track(t, [0, 0, 0, 8, 22, 26, 12, 3, 0]))
    p.foot['L'] = (V(0.012, 0, 0.09), 0.0, 8.0)
    p.foot['R'] = (V(-0.02, 0.02 * heel / 26, -0.09 + 0.01 * heel / 26), heel, -30.0)
    p.aim = p.yaw + twist
    blade = track(t, BLADE_KEYS).normalized()
    # 칼날이 지금 움직이는 방향(앞뒤 시각의 차이). 빠르게 휘두를수록 날이 그쪽을 더 따른다.
    lead = (track(t + 0.03, BLADE_KEYS).normalized() - track(t - 0.03, BLADE_KEYS).normalized()) / 0.06 * 0.25
    # 팔꿈치는 아래·바깥쪽으로 둔다. 옆으로 벌어지면 내려칠 때 팔뚝이 몸을 가로질러 손목이 과하게 꺾인다.
    p.arm['R'] = Arm(reach=track(t, HAND_KEYS), hint=V(-0.35, -0.9, -0.2), blade=blade, lead=lead, grip=65)
    # 왼팔: 준비할 때 앞으로 뻗어 균형을 잡고, 칠 때 뒤로 당긴다
    swing_l = track(t, [-20, -40, -55, -30, 25, 35, 28, 2, -20])
    spread = track(t, [20, 14, 10, 20, 30, 32, 30, 25, 20])
    p.arm['L'] = Arm(upper=aa(X, swing_l) @ aa(Z, -spread), elbow=track(t, [75, 52, 35, 50, 60, 65, 62, 70, 75]), grip=40)
    return p


write('Heavy_Attack', ATK_KEYS[-1], attack_pose)
