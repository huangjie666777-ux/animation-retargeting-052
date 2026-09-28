
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  Skeleton,
  RetargetPlan,
  retargetPose,
  retargetWorldMatrices,
  bakeRetargetedClip,
  RootMotionPlayer,
  sampleClip,
  type LocalTransform,
} from '../src/index.js';
import {
  humanoidBones,
  quatZ,
  retargetMapping,
  retargetTargetBones,
  rootMotionWalkClip,
  walkClip,
} from './helpers.js';

const src = new Skeleton(humanoidBones());
const dst = new Skeleton(retargetTargetBones());
const mapping = retargetMapping();

function fullBindPose(skeleton: Skeleton): Map<string, LocalTransform> {
  const pose = new Map<string, LocalTransform>();
  for (const id of skeleton.boneIds) pose.set(id, skeleton.bindLocalTransform(id));
  return pose;
}

function quatAngle(a: readonly number[], b: readonly number[]): number {
  return new Quaternion(a[0], a[1], a[2], a[3]).angleTo(new Quaternion(b[0], b[1], b[2], b[3]));
}

test('拒绝未知骨、重复映射、缺根与层级不一致映射', () => {
  assert.throws(() => new RetargetPlan(src, dst, { ...mapping, nope: 'torso' }), /未知源骨骼/);
  assert.throws(() => new RetargetPlan(src, dst, { ...mapping, spine: 'nope' }), /未知目标骨骼/);
  assert.throws(
    () => new RetargetPlan(src, dst, { ...mapping, head: 'palm.R' }),
    /重复目标骨骼/,
  );
  const noRoot: Record<string, string> = { spine: 'torso' };
  assert.throws(() => new RetargetPlan(src, dst, noRoot), /根骨骼/);
  // 层级不一致：spine 映射到 torso，但 arm.R 映射到 pelvis（跨过了映射父级）。
  // 交叉对应：spine 对应 shoulder.R，arm.R 对应 torso，映射祖先链不一致。
  assert.throws(
    () => new RetargetPlan(src, dst, {
      hips: 'pelvis', spine: 'shoulder.R', 'arm.R': 'torso',
    }),
    /层级对应不一致/,
  );
  assert.throws(() => retargetPose(new RetargetPlan(src, dst, mapping), new Map()), /完整源局部姿态/);
  assert.throws(
    () => retargetPose(new RetargetPlan(src, dst, mapping), fullBindPose(src), 0),
    /有限正数/,
  );
  assert.throws(
    () => retargetPose(new RetargetPlan(src, dst, mapping), fullBindPose(src), NaN),
    /有限正数/,
  );
});

test('源绑定姿态映成目标绑定姿态', () => {
  const plan = new RetargetPlan(src, dst, mapping);
  const out = retargetPose(plan, fullBindPose(src));
  assert.equal(out.size, dst.boneIds.length);
  for (const id of dst.boneIds) {
    const got = out.get(id)!;
    const bind = dst.bindLocalTransform(id);
    assert.ok(quatAngle(got.rotation, bind.rotation) < 1e-7, id + ' 旋转应为绑定值');
    assert.deepEqual(got.translation, [...bind.translation], id + ' 平移应为绑定值');
    assert.deepEqual(got.scale, [...bind.scale], id + ' 缩放应为绑定值');
  }
});

test('旋转差按绑定世界旋转重映射，目标骨长保留', () => {
  const plan = new RetargetPlan(src, dst, mapping);
  const pose = sampleClip(walkClip(), src, 0, 'loop');
  const out = retargetPose(plan, pose);

  // 非根骨平移/缩放保留目标绑定值（骨长不变）。
  assert.deepEqual(out.get('shoulder.R')!.translation, [0.5, 0.1, 0]);
  assert.deepEqual(out.get('thigh.L')!.scale, [1, 1, 1]);

  const world = retargetWorldMatrices(plan, out);
  const worldRot = (id: string): Quaternion => {
    const q = new Quaternion();
    new Matrix4().copy(world.get(id)!).decompose(new Vector3(), q, new Vector3());
    return q;
  };
  // 不变量：输出世界旋转 × 目标绑定世界旋转⁻¹ == 源旋转差（qZ(±0.5)），
  // 即绑定朝向之外的动作旋转差在映射骨上保持一致，与绑定朝向无关。
  const deltaL = plan.targetBindWorldRotation('thigh.L').invert().multiply(worldRot('thigh.L'));
  assert.ok(deltaL.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.5)) < 1e-9);
  const deltaR = plan.targetBindWorldRotation('thigh.R').invert().multiply(worldRot('thigh.R'));
  assert.ok(deltaR.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.5)) < 1e-9);

  // 根平移：源绑定 hips 在 (0,1,0)，walk 首帧也在 (0,1,0)，位移为 0。
  assert.deepEqual(out.get('pelvis')!.translation, [0, 0.8, 0]);
});

test('根位移按倍率叠加目标绑定位置', () => {
  const plan = new RetargetPlan(src, dst, mapping);
  const pose = new Map(fullBindPose(src));
  pose.set('hips', { ...pose.get('hips')!, translation: [0.6, 1.2, 0] });
  const out = retargetPose(plan, pose, 2);
  // 目标绑定根 (0,0.8,0) + 2 * (0.6,0.2,0) = (1.2,1.2,0)。
  assert.deepEqual(out.get('pelvis')!.translation, [1.2, 1.2, 0]);
});

test('未映射骨保留局部绑定姿态且继承父运动', () => {
  const plan = new RetargetPlan(src, dst, mapping);
  const pose = sampleClip(walkClip(), src, 0.3, 'loop');
  const out = retargetPose(plan, pose);
  assert.deepEqual(out.get('neck')!.rotation, [...dst.bindLocalTransform('neck').rotation]);
  assert.deepEqual(out.get('neck')!.translation, [0, 0.2, 0]);
  // torso 有运动时，neck 的世界旋转 = 父世界旋转 × 绑定局部旋转。
  const world = retargetWorldMatrices(plan, out);
  const qNeck = new Quaternion();
  new Matrix4().copy(world.get('neck')!).decompose(new Vector3(), qNeck, new Vector3());
  const qTorso = new Quaternion();
  new Matrix4().copy(world.get('torso')!).decompose(new Vector3(), qTorso, new Vector3());
  const bindNeck = dst.bindLocalTransform('neck').rotation;
  const exact = qTorso.clone().multiply(new Quaternion(bindNeck[0], bindNeck[1], bindNeck[2], bindNeck[3]));
  assert.ok(qNeck.angleTo(exact) < 1e-7);
  // cranium 为映射骨，绑定姿态下应映回自身绑定世界旋转。
  const qCranium = new Quaternion();
  new Matrix4().copy(world.get('cranium')!).decompose(new Vector3(), qCranium, new Vector3());
  const bindCranium = new Quaternion();
  new Matrix4().copy(dst.bindWorldMatrix('cranium')).decompose(new Vector3(), bindCranium, new Vector3());
  assert.ok(qCranium.angleTo(bindCranium) < 1e-9);
});

test('结果独立：重复转换与改写先前结果互不影响', () => {
  const plan = new RetargetPlan(src, dst, mapping);
  const pose = sampleClip(walkClip(), src, 0.2, 'loop');
  const a = retargetPose(plan, pose);
  const b = retargetPose(plan, pose);
  assert.notEqual(a, b);
  const saved = [...a.get('thigh.L')!.rotation];
  (a.get('thigh.L')!.rotation as unknown as number[])[0] = 9; // 若共享底层数组会污染 b
  assert.deepEqual([...b.get('thigh.L')!.rotation], saved);
});

test('烘焙片段：时刻、时长、目标骨 ID、终点不折回且与直接转换一致', () => {
  const plan = new RetargetPlan(src, dst, mapping);
  const times = [0, 0.25, 0.5, 0.75, 1];
  const baked = bakeRetargetedClip(plan, rootMotionWalkClip(), times);
  assert.equal(baked.duration, 1);
  const ids = baked.tracks.map((tr) => tr.boneId).sort();
  assert.deepEqual(ids, [...plan.mappedTargetIds].sort());
  for (const tr of baked.tracks) {
    assert.equal(tr.rotations!.length, 5);
    assert.deepEqual(tr.rotations!.map((k) => k.time), times);
  }
  const rootTrack = baked.tracks.find((tr) => tr.boneId === 'pelvis')!;
  assert.ok(rootTrack.translations);
  // 与逐时刻直接转换一致。
  for (const t of times) {
    const direct = retargetPose(plan, sampleClip(rootMotionWalkClip(), src, t, 'once'), 1);
    const sampled = sampleClip(baked, dst, t, 'once');
    for (const id of dst.boneIds) {
      const ang = quatAngle(sampled.get(id)!.rotation, direct.get(id)!.rotation);
      assert.ok(ang < 1e-7, 'bone ' + id + ' t=' + t + ' angle=' + ang);
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(sampled.get(id)!.translation[k] - direct.get(id)!.translation[k]) < 1e-10);
      }
    }
  }
  // 终点为真实末帧：根推进到 0.4，而不是折回首帧的 0。
  assert.deepEqual(rootTrack.translations![4].value, [0.4, 0.8, 0]);
  assert.notDeepEqual(rootTrack.translations![4].value, rootTrack.translations![0].value);
  // 非法采样时刻。
  assert.throws(() => bakeRetargetedClip(plan, rootMotionWalkClip(), [0, 0.5]), /片段时长/);
  assert.throws(() => bakeRetargetedClip(plan, rootMotionWalkClip(), [0, 0.5, 0.5, 1]), /严格递增/);
  assert.throws(() => bakeRetargetedClip(plan, rootMotionWalkClip(), [0, 1, 2]), /必须位于/);
});

test('烘焙片段可直接由根运动播放器播放，推进量与源一致', () => {
  const plan = new RetargetPlan(src, dst, mapping);
  const baked = bakeRetargetedClip(plan, rootMotionWalkClip(), [0, 0.5, 1]);
  const player = new RootMotionPlayer({
    skeleton: dst,
    clip: baked,
    rootBoneId: 'pelvis',
    mode: 'loop',
  });
  const frame = player.advance(1);
  assert.ok(Math.abs(frame.character.translation[0] - 0.4) < 1e-9);
  // 姿态根钉回片段起始（目标绑定根位置）。
  assert.deepEqual(frame.localPose.get('pelvis')!.translation, [0, 0.8, 0]);
});

test('非单位绑定缩放被拒绝', () => {
  const scaledBones = retargetTargetBones().map((b) => b.id === 'neck'
    ? { ...b, scale: [1, 2, 1] as const }
    : b);
  assert.throws(
    () => new RetargetPlan(src, new Skeleton(scaledBones), mapping),
    /单位缩放/,
  );
});
