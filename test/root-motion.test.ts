import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  Skeleton,
  RootMotion,
  RootMotionPlayer,
  composeRigid,
  rigidToMatrix,
  solveWorldTwoBoneIk,
  skinVertices,
  skinVerticesToWorld,
  type AnimationClip,
  type RigidTransform,
} from '../src/index.js';
import { humanoidBones, quatY, quatZ, rootMotionWalkClip } from './helpers.js';

const sk = new Skeleton(humanoidBones());

function rigidEqual(a: RigidTransform, b: RigidTransform, eps = 1e-9): void {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.translation[i] - b.translation[i]) < eps);
  const qa = new Quaternion(...a.rotation);
  const qb = new Quaternion(...b.rotation);
  assert.ok(qa.angleTo(qb) < eps);
}

test('根运动以片段起始根变换为参考提取平移与旋转', () => {
  const motion = new RootMotion(rootMotionWalkClip(), sk, 'hips');
  assert.deepEqual(motion.startLocal.translation, [0, 1, 0]);
  const half = motion.deltaAt(0.5, 'once');
  assert.deepEqual(half.translation, [0.2, 0, 0]); // 线性推进，不夹带绑定 y=1
  const cycle = motion.cycleMotion();
  assert.deepEqual(cycle.translation, [0.4, 0, 0]);
  assert.ok(new Quaternion(...cycle.rotation).angleTo(new Quaternion()) < 1e-9);
});

test('整圈旋转按刚体顺序复合（关于根原点旋转，不是位移相加）', () => {
  // 根在 y=1 处原地转 90°；整圈运动是关于 (0,1,0) 的旋转。
  const clip: AnimationClip = {
    name: 'turn',
    duration: 1,
    tracks: [
      {
        boneId: 'hips',
        translations: [
          { time: 0, value: [0, 1, 0] },
          { time: 1, value: [0, 1, 0] },
        ],
        rotations: [
          { time: 0, value: [0, 0, 0, 1] },
          { time: 1, value: quatY(Math.PI / 2) },
        ],
      },
    ],
  };
  const motion = new RootMotion(clip, sk, 'hips');
  const two = motion.accumulate(2, 'loop');
  // 转两次后角色根原点仍在 (0,1,0)，朝向 180°。
  const root = new Vector3(0, 1, 0).applyMatrix4(rigidToMatrix(composeRigid(
    { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    two.motion,
  )));
  assert.ok(root.distanceTo(new Vector3(0, 1, 0)) < 1e-9);
  assert.ok(new Quaternion(...two.motion.rotation).angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI)) < 1e-9);

  const stepwise = composeRigid(
    motion.accumulate(1, 'loop').motion,
    motion.accumulate(1, 'loop').motion,
  );
  rigidEqual(stepwise, two.motion);
});

test('loop 分步推进与一次推进到同一时刻一致（含跨圈余段）', () => {
  const motion = new RootMotion(rootMotionWalkClip(), sk, 'hips');
  const direct = motion.accumulate(2.35, 'loop').motion;
  // 2 圈 + 余段：K^2 · D(0.35)，平移方向不变时 x = 0.8 + 0.14。
  assert.ok(Math.abs(direct.translation[0] - 0.94) < 1e-9);
  assert.deepEqual(motion.accumulate(1, 'loop').motion.translation, [0.4, 0, 0]);
});

test('播放实例：返回角色变换/完整局部姿态/角色空间矩阵，根钉在起始变换', () => {
  const player = new RootMotionPlayer({
    skeleton: sk,
    clip: rootMotionWalkClip(),
    rootBoneId: 'hips',
    mode: 'loop',
  });
  const frame = player.advance(1.25);
  assert.equal(frame.localPose.size, sk.boneIds.length);
  assert.equal(frame.worldMatrices.size, sk.boneIds.length);
  assert.ok(Math.abs(frame.character.translation[0] - 0.5) < 1e-9);
  assert.deepEqual(frame.localPose.get('hips')!.translation, [0, 1, 0]); // 无双重运动
  // 角色空间矩阵不含角色平移；世界位置由角色矩阵另行复合。
  const hipsLocal = frame.worldMatrices.get('hips')!.elements;
  assert.deepEqual([hipsLocal[12], hipsLocal[13], hipsLocal[14]], [0, 1, 0]);
  const worldHips = new Vector3().setFromMatrixPosition(
    new Matrix4().multiplyMatrices(frame.characterMatrix, frame.worldMatrices.get('hips')!),
  );
  assert.ok(worldHips.distanceTo(new Vector3(0.5, 1, 0)) < 1e-9);
});

test('多实例状态独立；已返回结果不被后续推进改写', () => {
  const a = new RootMotionPlayer({ skeleton: sk, clip: rootMotionWalkClip(), rootBoneId: 'hips' });
  const b = new RootMotionPlayer({ skeleton: sk, clip: rootMotionWalkClip(), rootBoneId: 'hips' });
  const fa = a.advance(0.3);
  b.advance(1.8);
  const snapshot = new Map(fa.localPose);
  const charX = fa.character.translation[0];
  a.advance(2);
  assert.deepEqual(new Map(fa.localPose), snapshot);
  assert.equal(fa.character.translation[0], charX);
  assert.ok(Math.abs(b.characterTransform().translation[0] - 0.72) < 1e-9);
});

test('非法增量或覆盖层不推进状态', () => {
  const player = new RootMotionPlayer({ skeleton: sk, clip: rootMotionWalkClip(), rootBoneId: 'hips' });
  player.advance(0.5);
  assert.throws(() => player.advance(-0.1), /非负有限/);
  assert.throws(() => player.advance(Number.NaN), /非负有限/);
  assert.throws(() => player.advance(0.5, { clip: rootMotionWalkClip(), strength: 2 }), /\[0, 1\]/);
  assert.equal(player.time, 0.5);
});

test('once 到末帧后不再移动', () => {
  const player = new RootMotionPlayer({
    skeleton: sk,
    clip: rootMotionWalkClip(),
    rootBoneId: 'hips',
    mode: 'once',
  });
  player.advance(1);
  assert.equal(player.isFinished, true);
  const atEnd = player.characterTransform().translation[0];
  player.advance(5);
  assert.equal(player.characterTransform().translation[0], atEnd);
  assert.equal(player.time, 1);
});

test('覆盖层可影响其他骨骼但不能改变根或贡献根运动（含显式根遮罩）', () => {
  const rootOverride: AnimationClip = {
    name: 'override',
    duration: 1,
    tracks: [
      {
        boneId: 'hips',
        translations: [{ time: 0, value: [9, 9, 9] }],
      },
    ],
  };
  const player = new RootMotionPlayer({ skeleton: sk, clip: rootMotionWalkClip(), rootBoneId: 'hips' });
  const frame = player.advance(0.5, { clip: rootOverride, strength: 1, mask: { hips: 1 } });
  assert.deepEqual(frame.localPose.get('hips')!.translation, [0, 1, 0]);
  assert.ok(Math.abs(frame.character.translation[0] - 0.2) < 1e-9);
});

test('屏蔽根覆盖时不会清空后代继承权重', () => {
  const rootAndLeg: AnimationClip = {
    name: 'override',
    duration: 1,
    tracks: [
      { boneId: 'hips', translations: [{ time: 0, value: [9, 9, 9] }] },
      { boneId: 'leg.L', rotations: [{ time: 0, value: quatZ(1) }] },
    ],
  };
  const player = new RootMotionPlayer({ skeleton: sk, clip: rootMotionWalkClip(), rootBoneId: 'hips' });
  // 仅给根显式权重：根必须被钉回，但未指定的后代应继续继承权重，不能被清空。
  const frame = player.advance(0.5, { clip: rootAndLeg, strength: 1, mask: { hips: 1 } });
  assert.deepEqual(frame.localPose.get('hips')!.translation, [0, 1, 0]);
  assert.ok(
    new Quaternion(...frame.localPose.get('leg.L')!.rotation).angleTo(new Quaternion(...quatZ(1))) < 1e-9,
  );
});

test('拒绝非顶层根与非单位根缩放', () => {
  assert.throws(
    () => new RootMotionPlayer({ skeleton: sk, clip: rootMotionWalkClip(), rootBoneId: 'spine' }),
    /顶层根/,
  );
  const scaledBones = humanoidBones().map((b) => b.id === 'hips'
    ? { ...b, scale: [1, 1, 2] as const }
    : b);
  assert.throws(
    () => new RootMotionPlayer({ skeleton: new Skeleton(scaledBones), clip: rootMotionWalkClip(), rootBoneId: 'hips' }),
    /单位根缩放/,
  );
  const scaleClip: AnimationClip = {
    name: 's',
    duration: 1,
    tracks: [{ boneId: 'hips', scales: [{ time: 0, value: [2, 2, 2] }] }],
  };
  assert.throws(
    () => new RootMotionPlayer({ skeleton: sk, clip: scaleClip, rootBoneId: 'hips' }),
    /单位根缩放/,
  );
});

test('世界 IK 适配：世界目标经角色刚体逆变换求解，返回世界末端/可达性/残差', () => {
  const player = new RootMotionPlayer({
    skeleton: sk,
    clip: rootMotionWalkClip(),
    rootBoneId: 'hips',
    initialTransform: { translation: [10, 0, 5], rotation: quatY(Math.PI) },
  });
  const frame = player.advance(0);
  // 在角色空间取一个可达点，再变换成世界固定目标。
  const spine = new Vector3().setFromMatrixPosition(frame.worldMatrices.get('spine')!);
  const charTarget = new Vector3(spine.x + 0.2, spine.y - 0.1, spine.z + 0.3);
  const worldTarget = charTarget.clone().applyMatrix4(frame.characterMatrix);
  const charBend = new Vector3(spine.x, spine.y + 1, spine.z);
  const worldBend = charBend.clone().applyMatrix4(frame.characterMatrix);
  const ik = solveWorldTwoBoneIk(sk, frame.localPose, {
    rootJointId: 'spine',
    middleJointId: 'arm.R',
    endJointId: 'hand.R',
    worldTarget: [worldTarget.x, worldTarget.y, worldTarget.z],
    worldBendReference: [worldBend.x, worldBend.y, worldBend.z],
    characterMatrix: frame.characterMatrix,
    weight: 1,
  });
  assert.equal(ik.reachable, true);
  assert.ok(ik.distanceToTarget < 1e-8);
  assert.ok(new Vector3(...ik.worldEndPosition).distanceTo(worldTarget) < 1e-8);
  // 推进后旧结果不被改写。
  const saved = ik.worldEndPosition.slice();
  player.advance(1);
  assert.deepEqual(ik.worldEndPosition, saved);
});

test('世界蒙皮只施加一次角色矩阵，且不修改输入', () => {
  const player = new RootMotionPlayer({
    skeleton: sk,
    clip: rootMotionWalkClip(),
    rootBoneId: 'hips',
    initialTransform: { translation: [3, 0, 0], rotation: [0, 0, 0, 1] },
  });
  const frame = player.advance(0);
  const vertices: [number, number, number][] = [[0.55, 1.35, 0]];
  const weights = [[{ boneId: 'hand.R', weight: 1 }]];
  const charSpace = skinVertices(sk, vertices, weights, frame.worldMatrices);
  const world = skinVerticesToWorld(sk, vertices, weights, frame.worldMatrices, frame.characterMatrix);
  const expected = new Vector3(...charSpace[0]).applyMatrix4(frame.characterMatrix);
  assert.ok(new Vector3(...world[0]).distanceTo(expected) < 1e-10);
  assert.deepEqual(vertices, [[0.55, 1.35, 0]]);
  // 非单位缩放角色被拒绝。
  const scaled = new Matrix4().scale(new Vector3(2, 1, 1));
  assert.throws(
    () => skinVerticesToWorld(sk, vertices, weights, frame.worldMatrices, scaled),
    /单位缩放/,
  );
});
