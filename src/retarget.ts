
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { LocalTransform, Quat, Vec3 } from './types.js';
import type { Skeleton } from './skeleton.js';
import { composeLocalMatrix, computeWorldMatrices } from './skeleton.js';

const UNIT_SCALE_TOLERANCE = 1e-6;

/** 源骨骼 ID -> 目标骨骼 ID 的一一对应关系；至少必须包含两侧根骨骼。 */
export type BoneMapping = Readonly<Record<string, string>>;

function rotationOf(m: Matrix4): Quaternion {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return q;
}

function worldPositionOf(m: Matrix4): Vector3 {
  return new Vector3().setFromMatrixPosition(m);
}

function assertUnitBindScale(skeleton: Skeleton, what: string): void {
  for (const id of skeleton.boneIds) {
    const s = skeleton.bindLocalTransform(id).scale;
    if (s.some((v) => Math.abs(v - 1) > UNIT_SCALE_TOLERANCE)) {
      throw new Error(what + ' 仅支持单位缩放绑定姿态，骨骼 ' + id + ' 缩放非单位');
    }
  }
}

/**
 * 动作重定向计划。
 *
 * 依据源/目标骨架与一一骨骼映射预计算绑定姿态世界旋转，可重复用于姿态转换
 * 与片段烘焙。两侧均为单根、单位缩放、相同坐标轴约定；目标允许插入未映射
 * 中间骨（映射骨在层级上保持对应）。构造时不修改任何输入。
 */
export class RetargetPlan {
  readonly sourceSkeleton: Skeleton;
  readonly targetSkeleton: Skeleton;
  /** 源根骨骼 ID。 */
  readonly sourceRootId: string;
  /** 目标根骨骼 ID（与源根对应）。 */
  readonly targetRootId: string;
  /** 源 ID -> 目标 ID。 */
  readonly sourceToTarget: ReadonlyMap<string, string>;
  /** 目标 ID -> 源 ID。 */
  readonly targetToSource: ReadonlyMap<string, string>;
  /** 按目标求值顺序排列的映射目标骨 ID。 */
  readonly mappedTargetIds: readonly string[];

  private readonly sourceBindRot = new Map<string, Quaternion>();
  private readonly targetBindRot = new Map<string, Quaternion>();

  constructor(sourceSkeleton: Skeleton, targetSkeleton: Skeleton, mapping: BoneMapping) {
    if (!sourceSkeleton || !targetSkeleton) throw new Error('重定向计划缺少骨架');
    if (!mapping || typeof mapping !== 'object') throw new Error('重定向缺少骨骼映射');

    const sourceRoots = sourceSkeleton.boneIds.filter((id) => sourceSkeleton.parentIndex.get(id) === null);
    const targetRoots = targetSkeleton.boneIds.filter((id) => targetSkeleton.parentIndex.get(id) === null);
    if (sourceRoots.length !== 1 || targetRoots.length !== 1) {
      throw new Error('重定向要求源与目标骨架均为单根');
    }
    this.sourceRootId = sourceRoots[0];
    this.targetRootId = targetRoots[0];
    assertUnitBindScale(sourceSkeleton, '重定向源骨架');
    assertUnitBindScale(targetSkeleton, '重定向目标骨架');

    const forward = new Map<string, string>();
    const reverse = new Map<string, string>();
    for (const [srcId, dstId] of Object.entries(mapping)) {
      if (!sourceSkeleton.hasBone(srcId)) throw new Error('重定向映射引用了未知源骨骼: ' + srcId);
      if (typeof dstId !== 'string' || dstId.length === 0 || !targetSkeleton.hasBone(dstId)) {
        throw new Error('重定向映射引用了未知目标骨骼: ' + String(dstId));
      }
      if (forward.has(srcId)) throw new Error('重定向映射存在重复源骨骼: ' + srcId);
      if (reverse.has(dstId)) throw new Error('重定向映射存在重复目标骨骼: ' + dstId);
      forward.set(srcId, dstId);
      reverse.set(dstId, srcId);
    }
    if (forward.size === 0) throw new Error('重定向映射不能为空');
    if (forward.get(this.sourceRootId) !== this.targetRootId) {
      throw new Error('重定向映射必须包含两侧根骨骼的一一对应');
    }
    // 跳过未映射中间骨后，两侧映射骨的祖先链（仅映射骨）必须完全一致：
    // 允许任意一侧插入未映射中间骨，但不能跨过另一侧已映射的骨骼。
    for (const [srcId, dstId] of forward) {
      if (srcId === this.sourceRootId) continue;
      const srcChain: string[] = [];
      for (let a = sourceSkeleton.parentIndex.get(srcId)!; a !== null; a = sourceSkeleton.parentIndex.get(a)!) {
        if (forward.has(a)) srcChain.push(a);
      }
      const dstChain: string[] = [];
      for (let a = targetSkeleton.parentIndex.get(dstId)!; a !== null; a = targetSkeleton.parentIndex.get(a)!) {
        if (reverse.has(a)) dstChain.push(a);
      }
      if (srcChain.length !== dstChain.length || srcChain.some((a, i) => forward.get(a) !== dstChain[i])) {
        throw new Error('重定向映射的层级对应不一致: ' + srcId + ' -> ' + dstId);
      }
    }

    this.sourceSkeleton = sourceSkeleton;
    this.targetSkeleton = targetSkeleton;
    this.sourceToTarget = forward;
    this.targetToSource = reverse;
    this.mappedTargetIds = targetSkeleton.evalOrder.filter((id) => reverse.has(id));

    const buildBindRot = (skeleton: Skeleton, into: Map<string, Quaternion>): void => {
      for (const id of skeleton.evalOrder) {
        const local = skeleton.bindLocalTransform(id).rotation;
        const parent = skeleton.parentIndex.get(id);
        const world = parent
          ? into.get(parent)!.clone().multiply(new Quaternion(local[0], local[1], local[2], local[3]))
          : new Quaternion(local[0], local[1], local[2], local[3]);
        into.set(id, world.normalize());
      }
    };
    buildBindRot(sourceSkeleton, this.sourceBindRot);
    buildBindRot(targetSkeleton, this.targetBindRot);
  }

  /** 源骨绑定世界旋转（返回克隆）。 */
  sourceBindWorldRotation(id: string): Quaternion {
    return this.sourceBindRot.get(id)!.clone();
  }

  /** 目标骨绑定世界旋转（返回克隆）。 */
  targetBindWorldRotation(id: string): Quaternion {
    return this.targetBindRot.get(id)!.clone();
  }
}

function assertFinitePositive(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(what + ' 必须是有限正数: ' + String(value));
  }
}

function assertCompletePose(plan: RetargetPlan, sourcePose: ReadonlyMap<string, LocalTransform>): void {
  if (sourcePose.size !== plan.sourceSkeleton.boneIds.length) {
    throw new Error('重定向需要完整源局部姿态: 缺少骨骼或包含多余姿态');
  }
  for (const id of plan.sourceSkeleton.boneIds) {
    const t = sourcePose.get(id);
    if (!t) throw new Error('重定向源姿态缺少骨骼: ' + id);
    const all = [...t.translation, ...t.rotation, ...t.scale];
    if (all.length !== 10 || all.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('重定向源姿态骨骼 ' + id + ' 含非法数值');
    }
  }
}

/**
 * 把完整源局部姿态转换为完整目标局部姿态。
 *
 * 映射骨：旋转差 = 当前源世界旋转 × 源绑定世界旋转⁻¹，再左乘目标绑定世界旋转，
 * 最后按目标当前父世界旋转还原为局部旋转。未映射骨保留局部绑定姿态，但其世界
 * 姿态随已重定向的父级运动。非根骨平移/缩放保留目标绑定值。根平移 = 目标绑定
 * 根位置 + rootTranslationScale ×（源当前根位置 − 源绑定根位置），保留目标骨长。
 * 不修改任何输入，每次返回独立结果。
 */
export function retargetPose(
  plan: RetargetPlan,
  sourcePose: ReadonlyMap<string, LocalTransform>,
  rootTranslationScale = 1,
): Map<string, LocalTransform> {
  if (!(plan instanceof RetargetPlan)) throw new Error('重定向转换需要 RetargetPlan');
  assertFinitePositive(rootTranslationScale, '根平移倍率');
  assertCompletePose(plan, sourcePose);

  const source = plan.sourceSkeleton;
  const target = plan.targetSkeleton;
  const sourceWorld = computeWorldMatrices(source, sourcePose);
  const out = new Map<string, LocalTransform>();
  const outWorldRot = new Map<string, Quaternion>();

  const sourceBindRootPos = worldPositionOf(source.bindWorldMatrix(plan.sourceRootId));
  const sourceCurrentRootPos = worldPositionOf(sourceWorld.get(plan.sourceRootId)!);
  const rootDisplacement = sourceCurrentRootPos.clone().sub(sourceBindRootPos).multiplyScalar(rootTranslationScale);

  for (const dstId of target.evalOrder) {
    const srcId = plan.targetToSource.get(dstId);
    const bind = target.bindLocalTransform(dstId);
    const dstParent = target.parentIndex.get(dstId);
    if (srcId !== undefined) {
      // delta = qSrcWorld * inverse(qSrcBindWorld); qDstWorld = qDstBindWorld * delta。
      const delta = rotationOf(sourceWorld.get(srcId)!)
        .multiply(plan.sourceBindWorldRotation(srcId).invert());
      const dstWorldRot = plan.targetBindWorldRotation(dstId).multiply(delta).normalize();
      outWorldRot.set(dstId, dstWorldRot);

      let translation: Vec3 = [bind.translation[0], bind.translation[1], bind.translation[2]];
      let scale: Vec3 = [bind.scale[0], bind.scale[1], bind.scale[2]];
      if (dstId === plan.targetRootId) {
        const bindRootPos = worldPositionOf(target.bindWorldMatrix(plan.targetRootId));
        const p = bindRootPos.add(rootDisplacement);
        translation = [p.x, p.y, p.z];
        scale = [1, 1, 1];
      }
      const parentWorldRot = dstParent ? outWorldRot.get(dstParent)!.clone() : new Quaternion();
      const localRot = parentWorldRot.invert().multiply(dstWorldRot).normalize();
      out.set(dstId, {
        translation,
        rotation: [localRot.x, localRot.y, localRot.z, localRot.w],
        scale,
      });
    } else {
      // 未映射骨：保留局部绑定姿态；其世界旋转随父级输出旋转，天然继承父运动。
      const parentWorldRot = dstParent ? outWorldRot.get(dstParent)!.clone() : new Quaternion();
      const bindLocalRot = new Quaternion(...bind.rotation);
      outWorldRot.set(dstId, parentWorldRot.multiply(bindLocalRot).normalize());
      out.set(dstId, {
        translation: [bind.translation[0], bind.translation[1], bind.translation[2]],
        rotation: [bind.rotation[0], bind.rotation[1], bind.rotation[2], bind.rotation[3]],
        scale: [bind.scale[0], bind.scale[1], bind.scale[2]],
      });
    }
  }
  return out;
}

/** 便捷函数：计算重定向后目标姿态的世界矩阵。 */
export function retargetWorldMatrices(
  plan: RetargetPlan,
  targetPose: ReadonlyMap<string, LocalTransform>,
): Map<string, Matrix4> {
  return computeWorldMatrices(plan.targetSkeleton, targetPose);
}

/** 内部复用：按目标绑定姿态组合局部矩阵。 */
export function bindLocalMatrix(skeleton: Skeleton, id: string): Matrix4 {
  const t = skeleton.bindLocalTransform(id);
  return composeLocalMatrix(t.translation, t.rotation, t.scale);
}
