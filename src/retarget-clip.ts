
import type { AnimationClip, BoneTrack, Keyframe, Quat, Vec3 } from './types.js';
import { validateClip } from './clip.js';
import { sampleClip } from './pose.js';
import { RetargetPlan, retargetPose } from './retarget.js';

/** 片段烘焙选项。 */
export interface BakeRetargetedClipOptions {
  /** 新片段名称；缺省为源片段名 + ':retargeted'。 */
  readonly name?: string;
  /** 根位移相对绑定位置位移的倍率，缺省 1，必须为有限正数。 */
  readonly rootTranslationScale?: number;
}

/**
 * 将源片段在调用方给定的严格递增采样时刻上逐帧重定向，烘焙为使用目标骨 ID
 * 的现有 AnimationClip。时刻必须从 0 覆盖到片段时长并含两端；终点按末帧
 * 求值（once 夹取），不会折回首帧。时长保持不变，缺失通道回退目标绑定值，
 * 烘焙结果可直接交给 RootMotionPlayer 播放。
 */
export function bakeRetargetedClip(
  plan: RetargetPlan,
  sourceClip: AnimationClip,
  sampleTimes: readonly number[],
  options: BakeRetargetedClipOptions = {},
): AnimationClip {
  if (!(plan instanceof RetargetPlan)) throw new Error('片段烘焙需要 RetargetPlan');
  validateClip(sourceClip, plan.sourceSkeleton);
  if (!Array.isArray(sampleTimes) || sampleTimes.length < 2) {
    throw new Error('烘焙采样时刻至少需要两个点（含 0 与片段时长）');
  }
  const duration = sourceClip.duration;
  let prev = -1;
  for (const t of sampleTimes) {
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error('烘焙采样时刻含非法数值');
    if (t < 0 || t > duration) {
      throw new Error('烘焙采样时刻必须位于 [0, ' + duration + ']: ' + String(t));
    }
    if (t <= prev) throw new Error('烘焙采样时刻必须严格递增');
    prev = t;
  }
  if (sampleTimes[0] !== 0 || sampleTimes[sampleTimes.length - 1] !== duration) {
    throw new Error('烘焙采样时刻必须从 0 开始并以片段时长 ' + duration + ' 结束（含两端）');
  }
  const scale = options.rootTranslationScale ?? 1;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new Error('根平移倍率必须是有限正数: ' + String(scale));
  }

  // 每个映射目标骨收集旋转关键帧；根额外收集平移关键帧。
  const rotationKeys = new Map<string, Keyframe<Quat>[]>();
  const translationKeys = new Map<string, Keyframe<Vec3>[]>();
  for (const dstId of plan.mappedTargetIds) {
    rotationKeys.set(dstId, []);
  }
  translationKeys.set(plan.targetRootId, []);

  for (const time of sampleTimes) {
    // 使用 once 解析：t=duration 时得到真正的末帧而非下一圈首帧。
    const sourcePose = sampleClip(sourceClip, plan.sourceSkeleton, time, 'once');
    const targetPose = retargetPose(plan, sourcePose, scale);
    for (const dstId of plan.mappedTargetIds) {
      const t = targetPose.get(dstId)!;
      rotationKeys.get(dstId)!.push({ time, value: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]] });
    }
    const root = targetPose.get(plan.targetRootId)!;
    translationKeys.get(plan.targetRootId)!.push({
      time,
      value: [root.translation[0], root.translation[1], root.translation[2]],
    });
  }

  const tracks: BoneTrack[] = [];
  for (const dstId of plan.targetSkeleton.evalOrder) {
    const rotations = rotationKeys.get(dstId);
    if (!rotations) continue;
    if (dstId === plan.targetRootId) {
      tracks.push({ boneId: dstId, translations: translationKeys.get(dstId)!, rotations });
    } else {
      tracks.push({ boneId: dstId, rotations });
    }
  }
  return { name: options.name ?? sourceClip.name + ':retargeted', duration, tracks };
}
