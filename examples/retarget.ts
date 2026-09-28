
/**
 * 完整示例：把源人形骨架的循环行走重定向到骨名、绑定朝向、骨长均不同且
 * 插入了未映射 neck 骨的目标骨架，烘焙为目标片段后交给根运动播放器循环播放；
 * 播放过程中对固定世界目标执行世界两骨骼 IK（torso -> shoulder.R -> palm.R），
 * 并对绑定在 palm.R 上的顶点做世界蒙皮。
 *
 * 运行：npm run example:retarget
 */
import { Vector3 } from 'three';
import {
  Skeleton,
  RetargetPlan,
  retargetPose,
  retargetWorldMatrices,
  bakeRetargetedClip,
  RootMotionPlayer,
  solveWorldTwoBoneIk,
  skinVerticesToWorld,
  sampleClip,
  type SkinInfluence,
  type Vec3,
} from '../src/index.js';
import {
  humanoidBones,
  retargetMapping,
  retargetTargetBones,
  rootMotionWalkClip,
} from '../test/helpers.js';

const source = new Skeleton(humanoidBones());
const target = new Skeleton(retargetTargetBones());
const plan = new RetargetPlan(source, target, retargetMapping());

// 1) 直接姿态转换：源半程行走姿态 -> 目标姿态（根位移倍率 1）。
const sourceHalf = sampleClip(rootMotionWalkClip(), source, 0.5, 'loop');
const targetHalf = retargetPose(plan, sourceHalf, 1);
const targetHalfWorld = retargetWorldMatrices(plan, targetHalf);
const pelvisPos = new Vector3().setFromMatrixPosition(targetHalfWorld.get('pelvis')!);
console.log('=== 直接重定向（t=0.5）===');
console.log('源根前进 0.2 -> 目标 pelvis 世界位置:', pelvisPos.toArray().map((n) => n.toFixed(3)).join(', '));
console.log('目标骨长保留 shoulder.R 平移:', targetHalf.get('shoulder.R')!.translation.join(', '));

// 2) 烘焙为目标骨架片段，根运动播放器循环播放。
const baked = bakeRetargetedClip(plan, rootMotionWalkClip(), [0, 0.25, 0.5, 0.75, 1], {
  name: 'walk-retargeted',
});
const player = new RootMotionPlayer({
  skeleton: target,
  clip: baked,
  rootBoneId: 'pelvis',
  mode: 'loop',
});

// 固定世界目标：在首帧链根 torso 前方取一个可达点。
const first = player.advance(0);
const torso0 = new Vector3().setFromMatrixPosition(first.worldMatrices.get('torso')!);
const worldTarget: Vec3 = [torso0.x + 0.55, torso0.y + 0.45, torso0.z + 0.2];
const worldBend: Vec3 = [torso0.x + 0.2, torso0.y + 0.9, torso0.z + 0.3];

// 绑定姿态下位于 palm.R 的顶点（角色空间），蒙皮权重全在 palm.R。
const palmBind = new Vector3().setFromMatrixPosition(target.bindWorldMatrix('palm.R')!);
const vertices: Vec3[] = [[palmBind.x, palmBind.y, palmBind.z]];
const weights: SkinInfluence[][] = [[{ boneId: 'palm.R', weight: 1 }]];

const fmt = (v: readonly number[]) => v.map((n) => n.toFixed(4)).join(', ');
console.log('\n=== 重定向片段播放 + 世界 IK + 世界蒙皮 ===');
console.log('固定世界目标:', fmt(worldTarget));
for (const dt of [0.25, 0.25, 0.25, 0.25, 0.25]) {
  const frame = player.advance(dt);
  const ik = solveWorldTwoBoneIk(target, frame.localPose, {
    rootJointId: 'torso',
    middleJointId: 'shoulder.R',
    endJointId: 'palm.R',
    worldTarget,
    worldBendReference: worldBend,
    characterMatrix: frame.characterMatrix,
    weight: 1,
  });
  const skinned = skinVerticesToWorld(
    target,
    vertices,
    weights,
    ik.worldMatrices,
    frame.characterMatrix,
  );
  console.log(
    't=' + frame.time.toFixed(2),
    '角色x=' + frame.character.translation[0].toFixed(3),
    'IK末端=[' + fmt(ik.worldEndPosition) + ']',
    '可达=' + ik.reachable,
    '残差=' + ik.distanceToTarget.toExponential(2),
  );
  console.log('   蒙皮顶点世界坐标=[' + fmt(skinned[0]) + ']');
}
